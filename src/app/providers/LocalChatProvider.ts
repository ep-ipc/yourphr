/**
 * Chat with no sidecar (yourphr#594): retrieval through the Records door, the prompt assembled here,
 * one call to the operator's own model, transcripts in the app database.
 *
 * This is the native implementation. `TypesenseChatProvider` beside it is the port of the Go stack's
 * design, where a search engine held a second copy of every record, embedded it, assembled the
 * prompt and called the model on our behalf. Everything that design cost is gone here:
 *
 *   - __No second copy of the records.__ Retrieval is the full-text index the dashboard's own search
 *     already maintains (yourphr#599), through the same manager. One resource, one door — and
 *     nothing to backfill, re-index, or leave stale when a record changes.
 *   - __No create-once conversation model.__ The prompt is a string in this file. Editing it takes
 *     effect on the next question, rather than silently doing nothing until someone remembers to
 *     change an id.
 *   - __No schema.__ FHIR is too heterogeneous to type, which is what refused six of one bundle's
 *     records when the engine tried to infer field types from the first document it saw.
 *   - __Transcripts encrypted at rest.__ They live in the app database with everything else, not in
 *     a container volume that is not encrypted.
 *   - __One less service.__ No container, no published port, no readiness retry at boot.
 *
 * What it gives up is semantic retrieval. The engine embedded every record, so "what am I taking for
 * seizures" could reach a clonazepam prescription that never mentions seizures. A full-text index
 * cannot: it matches words. That is answered by asking the model to turn the question into search
 * terms first — see `termsFor`. It costs one extra, short model call and no new storage.
 */
import { OutboundHttp } from '../../http/index.js';
import {
  BaseChatProvider,
  type ChatAnswer,
  type ChatConversation,
  type ChatIndexedRecord,
  type ChatMessage,
} from './BaseChatProvider.js';
import type { BaseChatConversationsProvider } from './BaseChatConversationsProvider.js';

/** One record, as retrieval hands it over. Shaped by the manager, which owns what a record "says". */
export interface RetrievedRecord {
  resourceType: string;
  resourceId: string;
  sourceId: string;
  title: string;
  /** The readable text — `ChatManager.textOf`. */
  text: string;
}

/**
 * How this provider reaches the caller's records.
 *
 * A function rather than the Records manager itself, so this file cannot read anything else and the
 * composition root stays the only place that decides what "the caller's records" means. It is
 * handed a `userId` and must answer for that account and no other — the same contract every
 * provider in this stack works to.
 */
export type RecordRetriever = (userId: string, query: string, limit: number) => Promise<RetrievedRecord[]>;

/** How many expanded terms are searched. Each is one index query; past this it is noise. */
const MAX_TERMS = 8;

export interface LocalChatConfig {
  /** The model endpoint, e.g. `http://10.1.1.212:11434`. OpenAI-compatible; no `/v1` suffix. */
  url: string;
  /** The model as the endpoint names it, e.g. `medgemma:27b-it-q4_K_M`. No `vllm/` prefix here. */
  name: string;
  /** How many records one answer may draw on. */
  maxRecords: number;
  /** Bytes of retrieved record text the prompt may carry. */
  maxBytes: number;
  /** Test-only: lets a harness drive a loopback stand-in. Never true in a deployment. */
  allowInternal?: boolean;
  log?: (line: string) => void;
  /** Injected so a test can make ids predictable; defaults to a random uuid. */
  newId?: () => string;
  now?: () => Date;
}

/**
 * What the model is told.
 *
 * Deliberately free of any example value, and of dates above all. The prompt this replaces carried
 * "(e.g.,'March 3, 2019')" to illustrate date formatting, and a model asked when a medication was
 * prescribed answered "around March 3, 2019" when the real date was 21 May 2019 — it had taken the
 * date out of its own instructions and presented it as a fact about the patient. An example in a
 * prompt is, to the model, just more context.
 */
const SYSTEM_PROMPT = [
  "You are answering questions about one person's own medical records.",
  'Use ONLY the records given to you below. They are that person\'s own records, so answer them directly and in the second person.',
  'If the records do not contain the answer, say that you do not have that information. Never guess, and never supply a date, dose, name or value that is not written in the records.',
  'Write in plain language, as if speaking to someone with no medical training. Do not mention field names, data formats, record types, identifiers or codes.',
  'When a record carries a date, give it as it appears. Be brief.',
].join(' ');

/**
 * The words a record's text is actually filed under — the resource types, as `textFor` writes them
 * (camel case split, so `MedicationRequest` is indexed as "medication request"). Not decoration:
 * see TERMS_PROMPT for the failure that produced this list.
 */
const RECORD_VOCABULARY = [
  'condition', 'diagnosis', 'observation', 'immunization', 'medication', 'request', 'statement',
  'procedure', 'encounter', 'allergy', 'intolerance', 'diagnostic', 'report', 'care', 'plan', 'goal',
];

/**
 * The question that turns a question into search terms. Its answer is never shown to anybody.
 *
 * It NAMES THE VOCABULARY, and that is the part that took a live failure to learn. Asked "what
 * vaccinations have I had?", a model with no idea what the index contains answered
 * "vaccination immunisation vaccine shot jab" — five reasonable words, none of which appear in a
 * record. The index says "Immunization", American spelling, because that is what FHIR calls the
 * resource. Every term missed and the answer was "I do not have that information" for a patient
 * with twelve of them.
 *
 * Listing the words the records are actually filed under costs nothing and removes a whole class of
 * near-miss: synonyms, British spellings, and the patient's word for a thing versus the record's.
 */
const TERMS_PROMPT = [
  "Extract search keywords for a full-text search over a patient's medical records.",
  'Reply with ONLY a space-separated list of lowercase words — no punctuation, no explanation, no sentences.',
  'Records are filed under these words, so include whichever fit the question:',
  `${RECORD_VOCABULARY.join(', ')}.`,
  'Also include the specific medical terms the answer would be filed under — drug names, drug classes, condition names, vaccine names — including ones the question only implies.',
  'Use American spellings.',
].join(' ');

/** A short cap on the keyword call: it should be a handful of words, and a runaway is a bug. */
const TERMS_MAX_TOKENS = 60;

/** Words that match everything and therefore narrow nothing. */
const STOP_WORDS = new Set(['what', 'when', 'where', 'which', 'have', 'has', 'had', 'been', 'was', 'were', 'the', 'and', 'for', 'are', 'any', 'all', 'you', 'your', 'that', 'this', 'with', 'from', 'about', 'ever', 'list', 'tell', 'show', 'give', 'does', 'did', 'can', 'could', 'would', 'please', 'there', 'they', 'them', 'his', 'her', 'she', 'him', 'who', 'whom', 'how', 'why', 'not']);

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string } | string;
}

export class LocalChatProvider extends BaseChatProvider {
  readonly name = 'local';
  readonly available = true;
  readonly unavailableReason = '';
  /** Reads the records where they live, so there is nothing to fill and nothing to go stale. */
  readonly needsIndexing = false;

  private readonly http: OutboundHttp;
  private readonly base: string;
  private readonly log: (line: string) => void;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly config: LocalChatConfig,
    private readonly retrieve: RecordRetriever,
    private readonly conversations_: BaseChatConversationsProvider
  ) {
    super();
    this.base = config.url.replace(/\/+$/, '');
    this.log = config.log ?? ((): void => undefined);
    this.newId = config.newId ?? ((): string => globalThis.crypto.randomUUID());
    this.now = config.now ?? ((): Date => new Date());
    // A model an operator runs is almost always on their own network, which the SSRF guard refuses
    // by default and rightly so. The exemption names THIS host and nothing else.
    this.http = new OutboundHttp({
      allowInternal: config.allowInternal ?? false,
      allowHosts: [new URL(this.base).hostname],
      // A cold model can take minutes to load before it answers the first question.
      timeoutMs: 10 * 60_000,
      maxBytes: 8 * 1024 * 1024,
    });
  }

  override async initialize(): Promise<void> {
    // Nothing to bring into being — no collections, no conversation model, no readiness retry. The
    // model is reached when somebody asks something, and a failure then is reported then.
    this.log(`chat: local provider — ${this.config.name} at ${this.base}, up to ${this.config.maxRecords} record(s) per answer`);
  }

  // --- the model ---

  private async complete(messages: { role: string; content: string }[], maxTokens?: number): Promise<string> {
    const response = await this.http.request(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      json: {
        model: this.config.name,
        messages,
        stream: false,
        temperature: 0,
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      },
    });
    const text = response.body.toString('utf8');
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`the model endpoint answered HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    let parsed: ChatCompletion;
    try {
      parsed = JSON.parse(text) as ChatCompletion;
    } catch {
      throw new Error(`the model endpoint did not answer JSON: ${text.slice(0, 200)}`);
    }
    if (parsed.error) {
      throw new Error(typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? 'the model refused'));
    }
    return (parsed.choices?.[0]?.message?.content ?? '').trim();
  }

  // --- retrieval ---

  /**
   * Turn a question into search terms.
   *
   * The one place this makes up for not having embeddings. "What am I taking for my seizures" has
   * no word in common with a clonazepam prescription; a model that knows clonazepam is an
   * anticonvulsant supplies the missing word, and the full-text index does the rest.
   *
   * Falls back to the question itself when the call fails or answers nothing useful — a worse
   * search is a far better outcome than no answer, and it is exactly what would have happened
   * without this step.
   */
  private async termsFor(question: string): Promise<string[]> {
    const words = (text: string): string[] =>
      text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    const asked = words(question);
    try {
      const raw = await this.complete(
        [
          { role: 'system', content: TERMS_PROMPT },
          { role: 'user', content: question },
        ],
        TERMS_MAX_TOKENS
      );
      const expanded = [...new Set([...words(raw), ...asked])].slice(0, MAX_TERMS);
      return expanded.length > 0 ? expanded : asked.slice(0, MAX_TERMS);
    } catch (err) {
      this.log(`chat: keyword expansion failed, searching the question as typed: ${(err as Error).message}`);
      return asked.slice(0, MAX_TERMS);
    }
  }

  /**
   * Search each term separately and merge, ranking by how many terms a record matched.
   *
   * NOT one search for all the terms at once. The shared query builder joins words with AND — right
   * for a search box, where typing more words means "narrow it down", and fatal here: an expanded
   * list of eight keywords would demand a record containing all eight, and nothing does. Every
   * question came back "I do not have that information" until this was split.
   *
   * Ranking by term coverage also falls out of it for free, and is better than a flat OR: a record
   * matching "seizure" and "clonazepam" outranks one matching only "medication".
   */
  private async search(userId: string, terms: string[], limit: number): Promise<RetrievedRecord[]> {
    const hits = new Map<string, { record: RetrievedRecord; matched: number }>();
    const perTerm = await Promise.all(terms.map((term) => this.retrieve(userId, term, limit).catch(() => [])));
    for (const records of perTerm) {
      for (const record of records) {
        const key = `${record.resourceType}/${record.resourceId}`;
        const seen = hits.get(key);
        if (seen) seen.matched++;
        else hits.set(key, { record, matched: 1 });
      }
    }
    return [...hits.values()].sort((a, b) => b.matched - a.matched).slice(0, limit).map((h) => h.record);
  }

  /** The records, as the prompt will carry them, capped by the byte budget. */
  private contextOf(records: RetrievedRecord[]): string {
    const lines: string[] = [];
    let used = 0;
    for (const record of records) {
      const line = `- ${record.text}`;
      if (used + line.length > this.config.maxBytes) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join('\n');
  }

  // --- asking ---

  override async ask(userId: string, question: string, conversationId?: string): Promise<ChatAnswer> {
    if (conversationId !== undefined && !(await this.conversations_.owns(userId, conversationId))) {
      throw new Error('conversation not found');
    }

    const terms = await this.termsFor(question);
    // THE OWNER SEAM: retrieval is handed the asking account and answers for that one only.
    const records = await this.search(userId, terms, this.config.maxRecords);
    const context = this.contextOf(records);

    const history = conversationId === undefined ? [] : await this.conversations_.transcript(conversationId);
    const answer = await this.complete([
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map((turn) => ({ role: turn.role, content: turn.message })),
      {
        role: 'user',
        content: context === ''
          // Said plainly rather than left to the model to infer from an empty list, which is how a
          // model ends up answering from what it knows about medicine instead of about this person.
          ? `No records were found for this question.\n\nQuestion: ${question}`
          : `Records:\n${context}\n\nQuestion: ${question}`,
      },
    ]);

    const id = conversationId ?? this.newId();
    const at = this.now();
    if (conversationId === undefined) await this.conversations_.claim(userId, id, at);
    await this.conversations_.append(id, { role: 'user', message: question, at });
    await this.conversations_.append(id, { role: 'assistant', message: answer, at });

    return {
      conversationId: id,
      answer,
      citations: records.map((r) => ({ resourceType: r.resourceType, resourceId: r.resourceId, sourceId: r.sourceId, title: r.title })),
    };
  }

  // --- transcripts ---

  override async conversations(userId: string): Promise<ChatConversation[]> {
    const owned = await this.conversations_.list(userId);
    const out: ChatConversation[] = [];
    for (const record of owned) {
      const turns = await this.conversations_.transcript(record.conversationId);
      out.push({ id: record.conversationId, firstMessage: turns.find((t) => t.role === 'user')?.message ?? '', at: record.at });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  override async messages(userId: string, conversationId: string): Promise<ChatMessage[]> {
    if (!(await this.conversations_.owns(userId, conversationId))) return [];
    return this.conversations_.transcript(conversationId);
  }

  override async forget(userId: string, conversationId: string): Promise<boolean> {
    return this.conversations_.release(userId, conversationId);
  }

  override async removeAll(userId: string): Promise<void> {
    await this.conversations_.releaseAll(userId);
  }

  // --- the index that is not there ---

  /**
   * Nothing to index: retrieval reads the records where they already live. Returning without doing
   * anything is the honest implementation, and it is why this provider has no backfill, cannot go
   * stale, and answers about a record the moment it is written.
   */
  override async index(_record: ChatIndexedRecord): Promise<void> { /* the records are the index */ }

  /** Never consulted — `needsIndexing` is false, so the manager does not ask. */
  override async indexedCount(): Promise<number> { return 0; }
}
