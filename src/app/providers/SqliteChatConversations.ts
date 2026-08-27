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
    return (
      this.db
        .prepare('DELETE FROM chat_conversations WHERE conversation_id = ? AND user_id = ?')
        .run(conversationId, userId).changes > 0
    );
  }

  async releaseAll(userId: string): Promise<number> {
    return this.db.prepare('DELETE FROM chat_conversations WHERE user_id = ?').run(userId).changes;
  }
}
