/**
 * The native chat provider against a loopback stand-in for the model (yourphr#594).
 *
 * Asserts what leaves the process — the prompt, the retrieval terms, the owner passed to retrieval —
 * because that is where this kind of code goes wrong: not in the logic, but in what was actually
 * sent. The Go design's leak was a missing `filter_by` on a request nobody had looked at.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LocalChatProvider, type RetrievedRecord } from '../LocalChatProvider.js';
import { BaseChatConversationsProvider, type OwnedConversation } from '../BaseChatConversationsProvider.js';

class MemoryConversations extends BaseChatConversationsProvider {
  private readonly owners = new Map<string, { userId: string; at: number }>();
  private readonly turns = new Map<string, { role: 'user' | 'assistant'; message: string; at: number }[]>();
  async initialize(): Promise<void> { /* nothing */ }
  async claim(userId: string, id: string, at: Date): Promise<void> { if (!this.owners.has(id)) this.owners.set(id, { userId, at: at.getTime() }); }
  async owns(userId: string, id: string): Promise<boolean> { return this.owners.get(id)?.userId === userId; }
  async list(userId: string): Promise<OwnedConversation[]> {
    return [...this.owners.entries()].filter(([, v]) => v.userId === userId).map(([conversationId, v]) => ({ conversationId, at: v.at }));
  }
  async release(userId: string, id: string): Promise<boolean> {
    if (this.owners.get(id)?.userId !== userId) return false;
    this.owners.delete(id); this.turns.delete(id); return true;
  }
  async releaseAll(userId: string): Promise<number> {
    let n = 0;
    for (const [id, v] of [...this.owners.entries()]) if (v.userId === userId) { this.owners.delete(id); this.turns.delete(id); n++; }
    return n;
  }
  // Mirrors the SQLite provider's scoping, so a test that passes here means something about it.
  async append(userId: string, id: string, turn: { role: 'user' | 'assistant'; message: string; at: Date }): Promise<void> {
    if (this.owners.get(id)?.userId !== userId) throw new Error('cannot append to a conversation this account does not own');
    const list = this.turns.get(id) ?? [];
    list.push({ role: turn.role, message: turn.message, at: turn.at.getTime() });
    this.turns.set(id, list);
  }
  async transcript(userId: string, id: string): Promise<{ role: 'user' | 'assistant'; message: string; at: number }[]> {
    if (this.owners.get(id)?.userId !== userId) return [];
    return this.turns.get(id) ?? [];
  }
}

const record = (resourceId: string, title: string, text: string): RetrievedRecord =>
  ({ resourceType: 'Condition', resourceId, sourceId: 'source-1', title, text });

interface Sent { model: string; messages: { role: string; content: string }[]; maxTokens?: number }

let server: Server;
let base: string;
let sent: Sent[];
let replies: string[];
let status: number;
let retrievedFor: { userId: string; terms: string; limit: number }[];
let corpus: Record<string, RetrievedRecord[]>;
let conversations: MemoryConversations;
let provider: LocalChatProvider;
let ids: number;

beforeEach(async () => {
  sent = [];
  replies = [];
  status = 200;
  retrievedFor = [];
  ids = 0;
  corpus = { alice: [record('c1', 'Seizure disorder', 'Diagnosis: Seizure disorder — 2019-01-19')], bob: [] };
  conversations = new MemoryConversations();

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages: Sent['messages']; max_tokens?: number };
      sent.push({ model: body.model, messages: body.messages, ...(body.max_tokens === undefined ? {} : { maxTokens: body.max_tokens }) });
      res.writeHead(status, { 'content-type': 'application/json' });
      if (status !== 200) return res.end(JSON.stringify({ error: { message: 'model exploded' } }));
      res.end(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? 'an answer' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  provider = new LocalChatProvider(
    { url: base, name: 'test-model', maxRecords: 10, maxBytes: 10_000, allowInternal: true, newId: () => `conv-${++ids}`, now: () => new Date(0) },
    async (userId, terms, limit) => { retrievedFor.push({ userId, terms, limit }); return (corpus[userId] ?? []).slice(0, limit); },
    conversations
  );
});

afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

/**
 * Each ask() makes two calls: keywords first, then the answer. These name the MOST RECENT pair, so
 * an assertion after a follow-up reads that follow-up rather than the opening question.
 */
const answerCall = (): Sent => sent[sent.length - 1]!;
const termsCall = (): Sent => sent[sent.length - 2]!;

describe('LocalChatProvider — no sidecar, and what actually leaves the process', () => {
  it('expands the question into keywords, then searches on those', async () => {
    replies.push('seizure clonazepam anticonvulsant', 'You take clonazepam.');
    await provider.ask('alice', 'what am I taking for my fits?');
    // This is what stands in for the embeddings the sidecar had: the question shares no word with a
    // clonazepam record, so the model supplies the missing ones.
    expect(termsCall().messages[0]!.content).toContain('Extract search keywords');
    expect(termsCall().maxTokens).toBe(60);
    // One search PER TERM, not one search for all of them: the shared query builder ANDs its words,
    // so a single call with eight keywords would demand a record containing all eight.
    expect(retrievedFor.map((r) => r.terms).sort()).toEqual(['anticonvulsant', 'clonazepam', 'fits', 'seizure', 'taking']);
    expect(retrievedFor.every((r) => r.userId === 'alice')).toBe(true);
  });

  it('RETRIEVES FOR THE ASKING ACCOUNT AND NO OTHER', async () => {
    replies.push('terms', 'answer');
    await provider.ask('bob', 'what are my diagnoses?');
    expect(retrievedFor.every((r) => r.userId === 'bob')).toBe(true);
    // Nothing of alice's reaches the prompt.
    expect(answerCall().messages.at(-1)!.content).not.toContain('Seizure disorder');
    expect(answerCall().messages.at(-1)!.content).toContain('No records were found');
  });

  it('puts the retrieved records in the prompt, and cites them', async () => {
    replies.push('seizure', 'You were diagnosed with a seizure disorder.');
    const answer = await provider.ask('alice', 'what are my diagnoses?');
    expect(answerCall().messages.at(-1)!.content).toContain('Diagnosis: Seizure disorder — 2019-01-19');
    expect(answer.answer).toBe('You were diagnosed with a seizure disorder.');
    expect(answer.citations).toEqual([{ resourceType: 'Condition', resourceId: 'c1', sourceId: 'source-1', title: 'Seizure disorder' }]);
  });

  it('sends a system prompt carrying NO example date', async () => {
    replies.push('terms', 'answer');
    await provider.ask('alice', 'when was I diagnosed?');
    const system = answerCall().messages[0]!.content;
    // The prompt this replaces illustrated date formatting with "March 3, 2019", and a model then
    // reported that as the date of a prescription. An example is, to a model, just more context.
    expect(system).not.toMatch(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/);
    expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(system).toContain('never supply a date');
  });

  it('carries the conversation history into a follow-up', async () => {
    replies.push('terms', 'You take clonazepam.');
    const first = await provider.ask('alice', 'what am I taking?');
    replies.push('terms', 'Since 2019.');
    await provider.ask('alice', 'since when?', first.conversationId);
    const roles = answerCall().messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(answerCall().messages[1]!.content).toBe('what am I taking?');
    expect(answerCall().messages[2]!.content).toBe('You take clonazepam.');
  });

  it('stores the transcript in order, question before answer', async () => {
    replies.push('terms', 'You take clonazepam.');
    const { conversationId } = await provider.ask('alice', 'what am I taking?');
    const turns = await provider.messages('alice', conversationId);
    // Both turns share a timestamp; insertion order is what separates them, not the clock. The
    // design this replaced got this wrong and rendered the answer above its own question.
    expect(turns.map((t) => [t.role, t.message])).toEqual([
      ['user', 'what am I taking?'],
      ['assistant', 'You take clonazepam.'],
    ]);
  });

  it('will not continue, read or forget another account’s conversation', async () => {
    replies.push('terms', 'answer');
    const { conversationId } = await provider.ask('alice', 'mine');
    await expect(provider.ask('bob', 'go on', conversationId)).rejects.toThrow('conversation not found');
    expect(await provider.messages('bob', conversationId)).toEqual([]);
    expect(await provider.forget('bob', conversationId)).toBe(false);
    expect(await provider.messages('alice', conversationId)).toHaveLength(2);
  });

  it('lists only the caller’s conversations, labelled by their first question', async () => {
    replies.push('terms', 'answer');
    await provider.ask('alice', 'my first question');
    expect((await provider.conversations('alice')).map((c) => c.firstMessage)).toEqual(['my first question']);
    expect(await provider.conversations('bob')).toEqual([]);
  });

  it('still answers when the keyword call fails — a worse search beats no answer', async () => {
    // First call fails, second succeeds: the provider must fall back to the question as typed.
    let first = true;
    server.close();
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (first) { first = false; res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'an answer' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    provider = new LocalChatProvider(
      { url: `http://127.0.0.1:${port}`, name: 'm', maxRecords: 10, maxBytes: 10_000, allowInternal: true, newId: () => 'c1', now: () => new Date(0) },
      async (userId, terms, limit) => { retrievedFor.push({ userId, terms, limit }); return (corpus[userId] ?? []).slice(0, limit); },
      conversations
    );
    const answer = await provider.ask('alice', 'what are my diagnoses?');
    expect(answer.answer).toBe('an answer');
    expect(retrievedFor.map((r) => r.terms).sort()).toEqual(['diagnoses']);
  });

  it('ranks a record matching more terms above one matching fewer', async () => {
    corpus['alice'] = [record('c1', 'Seizure disorder', 'seizure'), record('c2', 'Clonazepam', 'seizure clonazepam')];
    // Every term returns the whole (tiny) corpus, so coverage is what separates them: c2 matches
    // both 'seizure' and 'clonazepam', c1 only 'seizure'.
    provider = new LocalChatProvider(
      { url: base, name: 'm', maxRecords: 1, maxBytes: 10_000, allowInternal: true, newId: () => 'c1', now: () => new Date(0) },
      async (userId, terms) => (corpus[userId] ?? []).filter((r) => r.text.includes(terms)),
      conversations
    );
    replies.push('seizure clonazepam', 'answer');
    const answer = await provider.ask('alice', 'anything?');
    expect(answer.citations.map((c) => c.resourceId)).toEqual(['c2']);
  });

  it('reports a model failure rather than inventing an answer', async () => {
    status = 500;
    await expect(provider.ask('alice', 'anything?')).rejects.toThrow(/HTTP 500/);
  });

  it('caps the record text the prompt carries', async () => {
    corpus['alice'] = [record('c1', 'A', 'x'.repeat(300)), record('c2', 'B', 'y'.repeat(300))];
    provider = new LocalChatProvider(
      { url: base, name: 'm', maxRecords: 10, maxBytes: 320, allowInternal: true, newId: () => 'c1', now: () => new Date(0) },
      async (userId, terms, limit) => (corpus[userId] ?? []).slice(0, limit),
      conversations
    );
    replies.push('terms', 'answer');
    await provider.ask('alice', 'anything?');
    const prompt = answerCall().messages.at(-1)!.content;
    expect(prompt).toContain('x'.repeat(300));
    expect(prompt).not.toContain('y'.repeat(300));
  });
});
