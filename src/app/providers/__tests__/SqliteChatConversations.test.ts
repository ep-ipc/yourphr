/**
 * The conversation store's own guarantees (yourphr#594).
 *
 * These call the store DIRECTLY, with no ownership check in front of them, because that is the
 * whole point: `transcript()` and `append()` used to take a conversation id alone and trust the
 * caller. Every caller did check — and the leak was one forgotten check away, in code nobody had
 * written yet. Scoping the queries turned that convention into an invariant, and these tests are
 * what say so.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteChatConversations } from '../SqliteChatConversations.js';

let store: SqliteChatConversations;
const at = new Date(1_700_000_000_000);

beforeEach(async () => {
  store = new SqliteChatConversations(new Database(':memory:'));
  await store.initialize();
  await store.claim('alice', 'conv-a', at);
  await store.claim('bob', 'conv-b', at);
  await store.append('alice', 'conv-a', { role: 'user', message: 'my seizure medication is clonazepam', at });
  await store.append('alice', 'conv-a', { role: 'assistant', message: 'noted', at });
  await store.append('bob', 'conv-b', { role: 'user', message: 'my blood pressure medication', at });
});

describe('SqliteChatConversations — scoped by account in the query, not by the caller', () => {
  it('hands back a transcript to its owner', async () => {
    expect((await store.transcript('alice', 'conv-a')).map((t) => t.message)).toEqual(['my seizure medication is clonazepam', 'noted']);
  });

  it('HANDS BACK NOTHING FOR ANOTHER ACCOUNT’S CONVERSATION, with no check in front of it', async () => {
    expect(await store.transcript('bob', 'conv-a')).toEqual([]);
    expect(await store.transcript('alice', 'conv-b')).toEqual([]);
    expect(await store.transcript('nobody', 'conv-a')).toEqual([]);
  });

  it('REFUSES A WRITE INTO ANOTHER ACCOUNT’S CONVERSATION', async () => {
    await expect(store.append('bob', 'conv-a', { role: 'user', message: 'injected', at })).rejects.toThrow(/does not own/);
    // And the refusal left nothing behind.
    expect((await store.transcript('alice', 'conv-a')).map((t) => t.message)).not.toContain('injected');
  });

  it('refuses a write into a conversation that does not exist', async () => {
    await expect(store.append('alice', 'no-such-conversation', { role: 'user', message: 'x', at })).rejects.toThrow(/does not own/);
  });

  it('keeps turns in insertion order, not clock order', async () => {
    // Both turns above share `at` to the millisecond, which is what happens in practice: a question
    // and its answer land in the same instant, and only the sequence separates them.
    expect((await store.transcript('alice', 'conv-a')).map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('lists only the caller’s conversations', async () => {
    expect((await store.list('alice')).map((c) => c.conversationId)).toEqual(['conv-a']);
    expect((await store.list('bob')).map((c) => c.conversationId)).toEqual(['conv-b']);
  });

  it('answers ownership honestly', async () => {
    expect(await store.owns('alice', 'conv-a')).toBe(true);
    expect(await store.owns('bob', 'conv-a')).toBe(false);
  });

  it('will not let a second account claim a conversation that is already owned', async () => {
    await store.claim('bob', 'conv-a', at);
    expect(await store.owns('bob', 'conv-a')).toBe(false);
    expect(await store.owns('alice', 'conv-a')).toBe(true);
  });

  it('releases only the caller’s own, and takes the turns with it', async () => {
    expect(await store.release('bob', 'conv-a')).toBe(false);
    expect(await store.transcript('alice', 'conv-a')).toHaveLength(2);
    expect(await store.release('alice', 'conv-a')).toBe(true);
    expect(await store.transcript('alice', 'conv-a')).toEqual([]);
    // Bob's is untouched.
    expect(await store.transcript('bob', 'conv-b')).toHaveLength(1);
  });

  it('clears one account entirely and leaves the other whole', async () => {
    expect(await store.releaseAll('alice')).toBe(1);
    expect(await store.list('alice')).toEqual([]);
    expect(await store.transcript('alice', 'conv-a')).toEqual([]);
    expect(await store.transcript('bob', 'conv-b')).toHaveLength(1);
  });
});
