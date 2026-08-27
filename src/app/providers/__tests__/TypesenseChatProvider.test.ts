/**
 * The Typesense chat provider against a loopback stand-in (yourphr#594).
 *
 * The point of testing at this level rather than mocking the client: the thing that went wrong in
 * the Go version was not logic, it was WHAT WENT ON THE WIRE — a search with no `filter_by`. So
 * these assert the actual request the sidecar would receive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { TypesenseChatProvider } from '../TypesenseChatProvider.js';
import { BaseChatConversationsProvider, type OwnedConversation } from '../BaseChatConversationsProvider.js';

/** The ownership map, in memory. */
class FakeConversations extends BaseChatConversationsProvider {
  private readonly owners = new Map<string, { userId: string; at: number }>();
  async initialize(): Promise<void> { /* nothing */ }
  async claim(userId: string, conversationId: string, at: Date): Promise<void> {
    if (!this.owners.has(conversationId)) this.owners.set(conversationId, { userId, at: at.getTime() });
  }
  async owns(userId: string, conversationId: string): Promise<boolean> {
    return this.owners.get(conversationId)?.userId === userId;
  }
  async list(userId: string): Promise<OwnedConversation[]> {
    return [...this.owners.entries()].filter(([, v]) => v.userId === userId).map(([conversationId, v]) => ({ conversationId, at: v.at }));
  }
  async release(userId: string, conversationId: string): Promise<boolean> {
    if (this.owners.get(conversationId)?.userId !== userId) return false;
    this.owners.delete(conversationId);
    return true;
  }
  async releaseAll(userId: string): Promise<number> {
    let n = 0;
    for (const [id, v] of [...this.owners.entries()]) if (v.userId === userId) { this.owners.delete(id); n++; }
    return n;
  }
  // Unused by this provider: Typesense keeps its own transcript. Present because the seam is shared.
  async append(): Promise<void> { throw new Error('the Typesense provider does not store transcripts here'); }
  async transcript(): Promise<{ role: 'user' | 'assistant'; message: string; at: number }[]> { return []; }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
}

interface Seen { method: string; path: string; query: URLSearchParams; body: unknown; apiKey: string }

let server: Server;
let base: string;
let seen: Seen[];
let existing: Set<string>;
let conversations: FakeConversations;
let provider: TypesenseChatProvider;

beforeEach(async () => {
  seen = [];
  existing = new Set();
  conversations = new FakeConversations();

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        body: raw === '' ? undefined : JSON.parse(raw),
        apiKey: String(req.headers['x-typesense-api-key'] ?? ''),
      });
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (url.pathname === '/collections' && req.method === 'GET') return send(200, []);
      if (url.pathname === '/collections' && req.method === 'POST') {
        existing.add((JSON.parse(raw) as { name: string }).name);
        return send(201, { name: (JSON.parse(raw) as { name: string }).name });
      }
      if (url.pathname === '/conversations/models' && req.method === 'POST') return send(201, { id: 'm1' });
      if (url.pathname.startsWith('/conversations/models/')) return send(404, { message: 'Not Found' });
      if (url.pathname.endsWith('/documents/search')) {
        if (url.pathname.includes('conversation_store')) {
          // Deliberately the wrong way round, and on the SAME second — which is what the real
          // engine returns, because it stamps both turns of an exchange with one timestamp.
          return send(200, {
            found: 2,
            hits: [
              { document: { role: 'assistant', message: 'You take Lisinopril.', timestamp: 5 } },
              { document: { role: 'user', message: 'what am I taking?', timestamp: 5 } },
            ],
          });
        }
        return send(200, {
          found: 1,
          hits: [{ document: { source_resource_type: 'MedicationStatement', source_resource_id: 'ms-1', source_id: 'source-1', sort_title: 'Lisinopril 10 MG', role: 'user', message: 'hello', timestamp: 5 } }],
          conversation: { answer: 'You take Lisinopril.', conversation_id: 'conv-1' },
        });
      }
      if (url.pathname.endsWith('/documents') && req.method === 'POST') return send(201, { id: 'ok' });
      if (url.pathname.endsWith('/documents') && req.method === 'DELETE') return send(200, { num_deleted: 1 });
      const collection = /^\/collections\/([^/]+)$/.exec(url.pathname);
      if (collection && req.method === 'GET') {
        return existing.has(decodeURIComponent(collection[1]!)) ? send(200, { name: collection[1] }) : send(404, { message: 'Not Found' });
      }
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  provider = new TypesenseChatProvider(
    {
      uri: base,
      apiKey: 'test-key',
      collection: 'resources',
      conversationCollection: 'conversation_store',
      model: { id: 'm1', name: 'medgemma:4b', vllmUrl: 'http://model.invalid:11434', maxBytes: 57_344 },
      maxRecords: 10,
      allowInternal: true,
    },
    conversations
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const searches = (): Seen[] => seen.filter((s) => s.path.endsWith('/documents/search'));

describe('TypesenseChatProvider — what actually goes on the wire', () => {
  it('creates both collections and the conversation model, once, and authenticates every call', async () => {
    await provider.initialize();
    const created = seen.filter((s) => s.path === '/collections' && s.method === 'POST').map((s) => (s.body as { name: string }).name);
    expect(created).toEqual(['resources', 'conversation_store']);
    expect(seen.some((s) => s.path === '/conversations/models' && s.method === 'POST')).toBe(true);
    expect(seen.every((s) => s.apiKey === 'test-key')).toBe(true);
  });

  it('freezes the operator’s model settings into the conversation model', async () => {
    await provider.initialize();
    const model = seen.find((s) => s.path === '/conversations/models' && s.method === 'POST')!.body as Record<string, unknown>;
    // The `vllm/` prefix is this engine's own convention and is added by the provider — an operator
    // configures the bare model name. Without the prefix Typesense calls OpenAI's hosted API
    // instead of the operator's endpoint, which would send the records off the premises.
    expect(model['model_name']).toBe('vllm/medgemma:4b');
    expect(model['vllm_url']).toBe('http://model.invalid:11434');
    expect(model['max_bytes']).toBe(57_344);
    expect(model['history_collection']).toBe('conversation_store');
    expect(String(model['system_prompt'])).toContain('using only the context provided');
  });

  it('puts NO example date in the system prompt', async () => {
    await provider.initialize();
    const prompt = String((seen.find((s) => s.path === '/conversations/models' && s.method === 'POST')!.body as Record<string, unknown>)['system_prompt']);
    // A 27B model asked when a medication was prescribed answered "around March 3, 2019" — the
    // example date the prompt used to carry — when the real date was 21 May 2019. An illustrative
    // date in a prompt about dates is, to the model, just another date it has been handed.
    expect(prompt).not.toMatch(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The instruction itself must survive — it is what stops raw timestamps reaching the patient.
    expect(prompt).toContain('never supply a date that is not in the context');
  });

  it('leaves a collection that already exists alone', async () => {
    existing.add('resources');
    existing.add('conversation_store');
    await provider.initialize();
    expect(seen.filter((s) => s.path === '/collections' && s.method === 'POST')).toHaveLength(0);
  });

  it('SCOPES EVERY SEARCH TO THE ASKING ACCOUNT — the leak this port closes', async () => {
    await provider.ask('alice', 'what am I taking?');
    const search = searches().at(-1)!;
    expect(search.query.get('filter_by')).toBe('user_id:=`alice`');
    expect(search.query.get('conversation')).toBe('true');
    expect(search.query.get('conversation_model_id')).toBe('m1');
    // The configured depth, verbatim — see per_page in the provider for why this is tuned, not maximal.
    expect(search.query.get('per_page')).toBe('10');
  });

  it('quotes the account name so it cannot rewrite the owner filter', async () => {
    await provider.ask('alice`|| user_id:=bob', 'sneaky');
    // The backtick that would close the literal is dropped, not passed through.
    expect(searches().at(-1)!.query.get('filter_by')).toBe('user_id:=`alice|| user_id:=bob`');
  });

  it('records ownership of a new conversation, and returns the answer and its citations', async () => {
    const answer = await provider.ask('alice', 'what am I taking?');
    expect(answer.conversationId).toBe('conv-1');
    expect(answer.answer).toBe('You take Lisinopril.');
    expect(answer.citations[0]).toMatchObject({ resourceType: 'MedicationStatement', resourceId: 'ms-1', title: 'Lisinopril 10 MG' });
    expect(await conversations.owns('alice', 'conv-1')).toBe(true);
  });

  it('refuses to continue, read or delete a conversation another account owns', async () => {
    await provider.ask('alice', 'mine');
    const before = searches().length;
    await expect(provider.ask('bob', 'let me see', 'conv-1')).rejects.toThrow('conversation not found');
    // Refused BEFORE the sidecar was asked: alice's transcript never entered bob's context.
    expect(searches()).toHaveLength(before);
    expect(await provider.messages('bob', 'conv-1')).toEqual([]);
    expect(await provider.forget('bob', 'conv-1')).toBe(false);
  });

  it('puts a question before the answer it produced, even on the same timestamp', async () => {
    await provider.ask('alice', 'what am I taking?');
    const turns = await provider.messages('alice', 'conv-1');
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0]!.message).toBe('what am I taking?');
  });

  it('indexes a record with the owner on the document', async () => {
    await provider.index({
      id: 'source-1-Observation-o1', userId: 'alice', sourceId: 'source-1', resourceType: 'Observation',
      resourceId: 'o1', sortDate: 1_700_000_000_000, sortTitle: 'Hemoglobin', sourceUri: 'http://x/y',
      text: 'Observation final Hemoglobin 13.5 g/dL',
    });
    const upsert = seen.find((s) => s.method === 'POST' && s.path.endsWith('/documents'))!;
    expect(upsert.query.get('action')).toBe('upsert');
    expect(upsert.body).toMatchObject({ id: 'source-1-Observation-o1', user_id: 'alice', sort_title: 'Hemoglobin', sort_date: 1_700_000_000_000, text: 'Observation final Hemoglobin 13.5 g/dL' });
    // The raw resource is NOT sent: a nested FHIR object breaks the engine's type inference.
    expect(upsert.body).not.toContain('resource_raw');
  });

  it('counts only the asking account’s indexed records', async () => {
    expect(await provider.indexedCount('alice')).toBe(1);
    expect(searches().at(-1)!.query.get('filter_by')).toBe('user_id:=`alice`');
  });

  it('deletes an account’s documents by owner when the account goes', async () => {
    await provider.ask('alice', 'mine');
    await provider.removeAll('alice');
    const deletes = seen.filter((s) => s.method === 'DELETE');
    expect(deletes[0]!.query.get('filter_by')).toBe('user_id:=`alice`');
    expect(await conversations.list('alice')).toEqual([]);
  });
});
