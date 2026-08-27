/**
 * Chat over a Typesense sidecar (yourphr#594) — the port of the Go stack's `backend/pkg/search`
 * (`typesense.go`, `indexer.go`) onto this stack's provider seam.
 *
 * Typesense does the retrieval AND holds the conversation: its `conversation: true` search embeds
 * the query, retrieves the nearest records, assembles them with the system prompt and the history,
 * and calls the operator's own model (`vllm/<name>` against `vllm_url` — any OpenAI-compatible
 * endpoint, Ollama included). So this provider is a thin, honest client: it creates the two
 * collections and the conversation model at boot, upserts records, and asks.
 *
 * WHAT THE PORT CHANGES, AND WHY
 *
 * In Go this ran in the BROWSER. `typesense.service.ts` held the Typesense API key — handed to it
 * in plaintext by the unauthenticated `GET /api/settings` — and queried the collection directly.
 * Neither the retrieval nor the conversation list carried an owner filter, so on an instance with
 * more than one account a member's question could retrieve another member's records, and the
 * conversation list was shared by everyone. `docs/deployment/search-and-chat.md` names this and
 * calls routing it through an authenticated backend "the real fix, not yet implemented".
 *
 * This is that fix. The key never leaves the server, and every retrieval carries
 * `filter_by: user_id:=<caller>` — the owner seam the rest of this stack already keeps
 * (`RecordsManager.who(ctx)`).
 *
 * The conversation store is the one place the seam cannot be a filter: Typesense writes those
 * documents itself, to a schema it owns, with no field for an owner. So ownership is recorded
 * beside it (see `BaseChatConversationsProvider`) and checked here before any transcript is read.
 * A conversation whose owner does not match is not this caller's, and answering with it would be
 * the same leak in a new place.
 */
import { OutboundHttp, type GuardedResponse } from '../../http/index.js';
import {
  BaseChatProvider,
  type ChatAnswer,
  type ChatConversation,
  type ChatIndexedRecord,
  type ChatMessage,
} from './BaseChatProvider.js';
import type { BaseChatConversationsProvider } from './BaseChatConversationsProvider.js';

export interface TypesenseChatConfig {
  /** Where the sidecar is, e.g. `http://typesense:8108`. */
  uri: string;
  apiKey: string;
  /** The retrieval collection. Go's `search.collection_name`. */
  collection: string;
  /** The transcript collection Typesense writes into. Go's `search.chat.conversation_collection_name`. */
  conversationCollection: string;
  model: {
    /** The conversation model's id in Typesense. Changing it creates a NEW model — see below. */
    id: string;
    /** The model as the endpoint names it, bare. The `vllm/` prefix is added here — see below. */
    name: string;
    vllmUrl: string;
    /** Bytes of context Typesense assembles per turn: prompt + records + history. */
    maxBytes: number;
  };
  /** How many records one answer may draw on. See `per_page` in ask() for why this is tuned, not maximal. */
  maxRecords: number;
  /** Test-only: lets the harness drive a loopback stand-in. Never true in a deployment. */
  allowInternal?: boolean;
  log?: (line: string) => void;
}

/**
 * What the model is told. Carried from `ensureConversationModel` in `typesense.go` — but NOT
 * verbatim, and the one edit is the point.
 *
 * The Go prompt illustrated its date instruction with a literal example: "convert them into
 * human-readable date formats (e.g.,'March 3, 2019')". A 27B model asked when a medication was
 * prescribed answered "around March 3, 2019". The real date was 21 May 2019. It had reached into
 * the SYSTEM PROMPT for a date and presented it as a fact about the patient's prescription,
 * confidently and in the right shape — the hardest kind of wrong answer to notice.
 *
 * An example date in a prompt that asks about dates is indistinguishable, to the model, from a date
 * in the context. So the instruction now describes the FORM without supplying a value. Nothing else
 * is changed: the rest was tuned against a real model and its clauses are load-bearing.
 *
 * Changing this text means a NEW conversation model — the prompt is frozen into one at creation and
 * later edits do nothing to a model that already exists. That is why the shipped `model.id` moved
 * with it; see `yourphr.chat.model.id`.
 */
const SYSTEM_PROMPT =
  "You are an assistant for question-answering, using only the context provided. This context represents personal information belonging to the user. Never mention or reference any technical details from the context, such as field names, data structures, formats (e.g., JSON), timestamps, codes, or metadata. Instead, interpret and convey the actual meaning of the content clearly and naturally. If a date is present, state it in plain language using the day, month and year exactly as they appear in the context, without mentioning that a timestamp was used; never supply a date that is not in the context. Never repeat or expose field names like 'sort_title', 'resource_raw', or any similar terms. Do not speculate based on metadata or structural hints. Only use the meaning conveyed by the values themselves. If an answer cannot be formed clearly from the context, respond by saying you do not have enough information. Always respond in plain, human-friendly language, as if you're speaking to a non-technical person.";

/** Fields the model is shown: what the record says, and what kind of record it is. Nothing else. */
const INCLUDE_FIELDS = ['source_resource_type', 'sort_title', 'sort_date', 'text'].join(',');

/** Semantic first, then the two literal fields worth a keyword match. */
const QUERY_BY = 'embedding,sort_title,text';

/** What a Typesense hit looks like, narrowed to the fields read below. */
interface TypesenseHit {
  document?: Record<string, unknown>;
}
interface TypesenseSearchResponse {
  found?: number;
  hits?: TypesenseHit[];
  conversation?: { answer?: string; conversation_id?: string };
}

export class TypesenseChatProvider extends BaseChatProvider {
  readonly name = 'typesense';
  readonly available = true;
  readonly unavailableReason = '';
  /** The engine holds its own copy of every record, so it has to be filled and kept current. */
  readonly needsIndexing = true;

  private readonly http: OutboundHttp;
  private readonly base: string;
  private readonly log: (line: string) => void;

  constructor(
    private readonly config: TypesenseChatConfig,
    private readonly conversations_: BaseChatConversationsProvider
  ) {
    super();
    this.base = config.uri.replace(/\/+$/, '');
    this.log = config.log ?? ((): void => undefined);
    // The sidecar is on the operator's own network, which the SSRF guard refuses by default and
    // correctly so. The exemption is for THIS host only, declared from the configured URI rather
    // than a switch — see `isAllowedHost` in src/http/ssrf.ts for why that distinction matters.
    this.http = new OutboundHttp({
      allowInternal: config.allowInternal ?? false,
      allowHosts: [new URL(this.base).hostname],
      timeoutMs: 15 * 60_000, // Go used a 15-minute connection timeout: a cold model can take minutes to answer.
      maxBytes: 32 * 1024 * 1024,
    });
  }

  // --- the wire ---

  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: unknown }> {
    const response: GuardedResponse = await this.http.request(`${this.base}${path}`, {
      method,
      headers: { 'x-typesense-api-key': this.config.apiKey },
      ...(body === undefined ? {} : { json: body }),
    });
    const text = response.body.toString('utf8');
    let json: unknown = undefined;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      // Typesense answers JSON for everything it understands. A body that is not JSON means a proxy
      // or an error page got in the way, and the raw text is more use than a parse failure.
      json = { message: text.slice(0, 500) };
    }
    return { status: response.status, json };
  }

  /** A call that must succeed. Raises the sidecar's own message, which is usually the actual cause. */
  private async must(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const { status, json } = await this.call(method, path, body);
    if (status < 200 || status >= 300) {
      const message = (json as { message?: string } | undefined)?.message ?? `HTTP ${status}`;
      throw new Error(`typesense ${method} ${path}: ${message}`);
    }
    return json;
  }

  // --- bringing the index into being (Go's Init) ---

  override async initialize(): Promise<void> {
    await this.waitForReady();
    await this.ensureCollection(this.resourcesSchema());
    await this.ensureCollection(this.conversationsSchema());
    await this.ensureConversationModel();
    this.log(`chat: typesense ready at ${this.base} — collections '${this.config.collection}', '${this.config.conversationCollection}'`);
  }

  /**
   * Go retried a ping 30 times, two seconds apart, because compose starts the sidecar and the app
   * together and the app usually wins. Same budget here, and the same decision at the end of it:
   * give up loudly rather than serve a chat that silently answers nothing.
   */
  private async waitForReady(attempts = 30, delayMs = 2_000): Promise<void> {
    let last = '';
    for (let i = 0; i < attempts; i++) {
      try {
        const { status } = await this.call('GET', '/collections');
        if (status >= 200 && status < 300) return;
        last = `HTTP ${status}`;
      } catch (err) {
        last = (err as Error).message;
      }
      this.log(`chat: typesense not ready yet (attempt ${i + 1}/${attempts}): ${last}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`typesense did not become ready at ${this.base} after ${attempts} attempts: ${last}`);
  }

  private async ensureCollection(schema: { name: string } & Record<string, unknown>): Promise<void> {
    const { status } = await this.call('GET', `/collections/${encodeURIComponent(schema.name)}`);
    if (status >= 200 && status < 300) {
      this.log(`chat: collection '${schema.name}' already exists`);
      return;
    }
    if (status !== 404) throw new Error(`typesense: cannot inspect collection '${schema.name}' (HTTP ${status})`);
    await this.must('POST', '/collections', schema);
    this.log(`chat: created collection '${schema.name}'`);
  }

  private resourcesSchema(): { name: string } & Record<string, unknown> {
    return {
      name: this.config.collection,
          default_sorting_field: 'sort_date',
      fields: [
        { name: 'id', type: 'string' },
        // Faceted so `filter_by: user_id:=…` is an index lookup rather than a scan. The Go schema
        // had the field but never filtered on it; here it is the owner seam and it is on every read.
        { name: 'user_id', type: 'string', facet: true },
        { name: 'source_id', type: 'string' },
        { name: 'source_resource_type', type: 'string', facet: true },
        { name: 'source_resource_id', type: 'string' },
        { name: 'sort_date', type: 'int64' },
        { name: 'sort_title', type: 'string', optional: true },
        { name: 'source_uri', type: 'string', optional: true },
        // A flat string, deliberately — see `text` on ChatIndexedRecord for what indexing the raw
        // FHIR object cost. It is also what gets embedded, so retrieval matches on what the record
        // SAYS rather than on its title alone.
        { name: 'text', type: 'string', optional: true },
        {
          name: 'embedding',
          type: 'float[]',
          embed: {
            from: ['sort_title', 'text'],
            model_config: { model_name: 'ts/all-MiniLM-L12-v2' },
          },
        },
      ],
    };
  }

  private conversationsSchema(): { name: string } & Record<string, unknown> {
    return {
      name: this.config.conversationCollection,
      fields: [
        { name: 'conversation_id', type: 'string', facet: true },
        { name: 'model_id', type: 'string' },
        { name: 'timestamp', type: 'int32' },
        { name: 'role', type: 'string', index: false },
        { name: 'message', type: 'string', index: false },
      ],
    };
  }

  /**
   * The model, created once and then never touched again — the gotcha Go's deployment doc warns
   * about and this keeps: `max_bytes` and the prompt only take effect for a model that does not
   * exist yet, so changing them on a live instance means changing `model.id` too.
   */
  private async ensureConversationModel(): Promise<void> {
    const { status } = await this.call('GET', `/conversations/models/${encodeURIComponent(this.config.model.id)}`);
    if (status >= 200 && status < 300) {
      this.log(`chat: conversation model '${this.config.model.id}' already exists`);
      return;
    }
    if (status !== 404) throw new Error(`typesense: cannot inspect conversation model (HTTP ${status})`);
    await this.must('POST', '/conversations/models', {
      id: this.config.model.id,
      // Typesense decides WHERE to send the request from this prefix: `vllm/` means the configured
      // vllm_url, anything else means OpenAI's hosted API. That is this engine's convention, not
      // something an operator should have to know, so it is applied here rather than asked for in
      // configuration — and getting it wrong sends records off the premises.
      model_name: `vllm/${this.config.model.name}`,
      vllm_url: this.config.model.vllmUrl,
      history_collection: this.config.conversationCollection,
      system_prompt: SYSTEM_PROMPT,
      max_bytes: this.config.model.maxBytes,
    });
    this.log(`chat: created conversation model '${this.config.model.id}' (${this.config.model.name} at ${this.config.model.vllmUrl})`);
  }

  // --- indexing (Go's IndexerService.IndexResource) ---

  override async index(record: ChatIndexedRecord): Promise<void> {
    await this.must('POST', `/collections/${encodeURIComponent(this.config.collection)}/documents?action=upsert`, {
      id: record.id,
      user_id: record.userId,
      source_id: record.sourceId,
      source_resource_type: record.resourceType,
      source_resource_id: record.resourceId,
      sort_date: record.sortDate,
      sort_title: record.sortTitle,
      source_uri: record.sourceUri,
      text: record.text,
    });
  }

  override async indexedCount(userId: string): Promise<number> {
    const params = new URLSearchParams({ q: '*', query_by: 'sort_title', filter_by: `user_id:=${quote(userId)}`, per_page: '0' });
    const { status, json } = await this.call('GET', `/collections/${encodeURIComponent(this.config.collection)}/documents/search?${params}`);
    // A collection that is not there yet holds nothing — which is the honest answer to "how many",
    // and lets a backfill decide to run rather than crash on a fresh instance.
    if (status === 404) return 0;
    if (status < 200 || status >= 300) throw new Error(`typesense: cannot count indexed records (HTTP ${status})`);
    return (json as TypesenseSearchResponse).found ?? 0;
  }

  // --- asking ---

  override async ask(userId: string, question: string, conversationId?: string): Promise<ChatAnswer> {
    if (conversationId !== undefined && !(await this.conversations_.owns(userId, conversationId))) {
      // Not theirs. Refused rather than answered into, because continuing someone else's
      // conversation would put their transcript into this caller's context window.
      throw new Error('conversation not found');
    }
    const params = new URLSearchParams({
      q: question,
      query_by: QUERY_BY,
      // THE OWNER SEAM. Absent in the Go/browser version, which is what made chat unsafe on an
      // instance with more than one account.
      filter_by: `user_id:=${quote(userId)}`,
      include_fields: INCLUDE_FIELDS,
      conversation: 'true',
      conversation_model_id: this.config.model.id,
      // How many records the answer may draw on. NOT "as many as the budget allows" — measured
      // against a 4B model on a real record, more context made the answers WORSE, not better:
      //
      //     5 records   correct, clean
      //    10 records   correct, with one irrelevant item
      //    20 records   "I am unable to answer this question"
      //    30 records   confidently listed blood tests as diagnoses
      //
      // The right number depends on the model an operator runs, which is why it is configuration
      // and not a constant here. See `yourphr.chat.retrieval.max-records`.
      per_page: String(this.config.maxRecords),
      ...(conversationId ? { conversation_id: conversationId } : {}),
    });
    const json = (await this.must(
      'GET',
      `/collections/${encodeURIComponent(this.config.collection)}/documents/search?${params}`
    )) as TypesenseSearchResponse;

    const answeredIn = json.conversation?.conversation_id ?? conversationId;
    if (!answeredIn) throw new Error('typesense answered without a conversation id — is the conversation model configured?');
    if (conversationId === undefined) await this.conversations_.claim(userId, answeredIn, new Date());

    return {
      conversationId: answeredIn,
      answer: json.conversation?.answer ?? '',
      citations: (json.hits ?? []).map((hit) => ({
        resourceType: String(hit.document?.['source_resource_type'] ?? ''),
        resourceId: String(hit.document?.['source_resource_id'] ?? ''),
        sourceId: String(hit.document?.['source_id'] ?? ''),
        title: String(hit.document?.['sort_title'] ?? ''),
      })),
    };
  }

  // --- transcripts ---

  override async conversations(userId: string): Promise<ChatConversation[]> {
    const owned = await this.conversations_.list(userId);
    const out: ChatConversation[] = [];
    for (const record of owned) {
      const turns = await this.transcript(record.conversationId);
      // The label is the first thing the person asked, read from the transcript rather than stored
      // beside the ownership row: the question is about their health, and the ownership map is
      // deliberately free of anything that is.
      out.push({
        id: record.conversationId,
        firstMessage: turns.find((t) => t.role === 'user')?.message ?? '',
        at: record.at,
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  override async messages(userId: string, conversationId: string): Promise<ChatMessage[]> {
    if (!(await this.conversations_.owns(userId, conversationId))) return [];
    return this.transcript(conversationId);
  }

  /** Every turn Typesense recorded for one conversation, oldest first. Ownership is the caller's job. */
  private async transcript(conversationId: string): Promise<ChatMessage[]> {
    const params = new URLSearchParams({
      q: '*',
      query_by: 'conversation_id',
      filter_by: `conversation_id:=${quote(conversationId)}`,
      sort_by: 'timestamp:asc',
      per_page: '250',
    });
    const { status, json } = await this.call(
      'GET',
      `/collections/${encodeURIComponent(this.config.conversationCollection)}/documents/search?${params}`
    );
    if (status < 200 || status >= 300) return [];
    const turns: ChatMessage[] = (json as TypesenseSearchResponse).hits?.map((hit) => ({
      role: hit.document?.['role'] === 'assistant' ? 'assistant' : 'user',
      message: String(hit.document?.['message'] ?? ''),
      at: Number(hit.document?.['timestamp'] ?? 0) * 1000,
    })) ?? [];
    // `sort_by: timestamp:asc` is not enough on its own. Typesense stamps a conversation's turns
    // with WHOLE SECONDS, and a question and its answer almost always land in the same one — so the
    // engine's tie-break decides the order, and it rendered the answer above the question that
    // produced it. Within one second the question came first, by definition.
    return turns.sort((a, b) => a.at - b.at || rank(a.role) - rank(b.role));
  }

  override async forget(userId: string, conversationId: string): Promise<boolean> {
    if (!(await this.conversations_.owns(userId, conversationId))) return false;
    await this.deleteWhere(this.config.conversationCollection, `conversation_id:=${quote(conversationId)}`);
    await this.conversations_.release(userId, conversationId);
    return true;
  }

  override async removeAll(userId: string): Promise<void> {
    await this.deleteWhere(this.config.collection, `user_id:=${quote(userId)}`);
    for (const record of await this.conversations_.list(userId)) {
      await this.deleteWhere(this.config.conversationCollection, `conversation_id:=${quote(record.conversationId)}`);
    }
    await this.conversations_.releaseAll(userId);
  }

  private async deleteWhere(collection: string, filter: string): Promise<void> {
    const params = new URLSearchParams({ filter_by: filter });
    const { status } = await this.call('DELETE', `/collections/${encodeURIComponent(collection)}/documents?${params}`);
    // 404 is the collection not existing, which is the state the caller wanted anyway.
    if (status !== 404 && (status < 200 || status >= 300)) {
      throw new Error(`typesense: cannot delete from '${collection}' (HTTP ${status})`);
    }
  }
}

/** Within one timestamp, a question precedes its answer. */
function rank(role: ChatMessage['role']): number {
  return role === 'user' ? 0 : 1;
}

/**
 * A value inside a `filter_by`, quoted so it cannot end the clause and start another.
 *
 * Usernames are the values here, and a username is chosen by whoever created the account. Without
 * this, a name carrying `&&` or a backtick rewrites the owner filter — which is the one thing in
 * this file that must not be rewritable. Typesense uses backticks for literals and has no escape
 * for a backtick inside one, so the character is dropped rather than passed through: a name cannot
 * contain one in a form that survives, and a filter that matches nothing is the safe direction.
 */
function quote(value: string): string {
  return `\`${value.replace(/`/g, '')}\``;
}
