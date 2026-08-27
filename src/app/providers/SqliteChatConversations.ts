/** The conversation-ownership table in the app database (yourphr#594). No PHI — see the base. */
import type Database from 'better-sqlite3-multiple-ciphers';
import { BaseChatConversationsProvider, type OwnedConversation } from './BaseChatConversationsProvider.js';

export class SqliteChatConversations extends BaseChatConversationsProvider {
  constructor(private readonly db: InstanceType<typeof Database>) {
    super();
    // The conversation id is the primary key, not (user_id, conversation_id): a conversation has
    // exactly one owner, and making the pair unique would let the same id be claimed twice and
    // turn `owns()` into "one of the owners", which is not the question being asked.
    db.exec(`CREATE TABLE IF NOT EXISTS chat_conversations (
      conversation_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS chat_conversations_user ON chat_conversations (user_id, created_at DESC)');
    // The turns, for a provider that runs the conversation itself. `seq` rather than a timestamp is
    // the ordering: a question and its answer land in the same millisecond often enough that a
    // clock cannot separate them. The design this replaced ordered on a whole-second timestamp and
    // duly returned the answer above the question that produced it.
    db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    )`);
  }

  async initialize(): Promise<void> { /* schema ensured in the constructor */ }

  async claim(userId: string, conversationId: string, at: Date): Promise<void> {
    this.db
      .prepare('INSERT OR IGNORE INTO chat_conversations (conversation_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(conversationId, userId, at.getTime());
  }

  async owns(userId: string, conversationId: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM chat_conversations WHERE conversation_id = ? AND user_id = ?')
      .get(conversationId, userId) as { ok: number } | undefined;
    return row !== undefined;
  }

  async list(userId: string): Promise<OwnedConversation[]> {
    return (
      this.db
        .prepare('SELECT conversation_id AS conversationId, created_at AS at FROM chat_conversations WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId) as OwnedConversation[]
    );
  }

  async release(userId: string, conversationId: string): Promise<boolean> {
    const gone = this.db.prepare('DELETE FROM chat_conversations WHERE conversation_id = ? AND user_id = ?').run(conversationId, userId).changes > 0;
    if (gone) this.db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(conversationId);
    return gone;
  }

  async releaseAll(userId: string): Promise<number> {
    const ids = this.db.prepare('SELECT conversation_id FROM chat_conversations WHERE user_id = ?').all(userId) as { conversation_id: string }[];
    const dropTurns = this.db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?');
    for (const row of ids) dropTurns.run(row.conversation_id);
    return this.db.prepare('DELETE FROM chat_conversations WHERE user_id = ?').run(userId).changes;
  }

  async append(userId: string, conversationId: string, turn: { role: 'user' | 'assistant'; message: string; at: Date }): Promise<void> {
    // The WHERE EXISTS is the guard, in the statement rather than in front of it: a turn cannot be
    // written into a conversation the account does not own, whatever the caller believed.
    const written = this.db
      .prepare(`INSERT INTO chat_messages (conversation_id, seq, role, message, created_at)
        SELECT ?, COALESCE((SELECT MAX(seq) FROM chat_messages WHERE conversation_id = ?), 0) + 1, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM chat_conversations WHERE conversation_id = ? AND user_id = ?)`)
      .run(conversationId, conversationId, turn.role, turn.message, turn.at.getTime(), conversationId, userId).changes;
    if (written === 0) throw new Error('cannot append to a conversation this account does not own');
  }

  async transcript(userId: string, conversationId: string): Promise<{ role: 'user' | 'assistant'; message: string; at: number }[]> {
    return (
      this.db
        .prepare(`SELECT m.role, m.message, m.created_at AS at
          FROM chat_messages m
          JOIN chat_conversations c ON c.conversation_id = m.conversation_id
          WHERE m.conversation_id = ? AND c.user_id = ?
          ORDER BY m.seq`)
        .all(conversationId, userId) as { role: 'user' | 'assistant'; message: string; at: number }[]
    );
  }
}
