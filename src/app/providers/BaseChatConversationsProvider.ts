/**
 * Who owns which conversation (yourphr#594).
 *
 * This exists because of one thing the retrieval engine cannot do. Typesense writes the transcript
 * itself, into a collection whose schema it owns — `conversation_id`, `model_id`, `timestamp`,
 * `role`, `message` — and there is no field on it for an account. So the owner filter that scopes
 * every other read (`filter_by: user_id:=…`) has nothing to bind to on the transcript, and the Go
 * version simply did not scope it: every account's chat page listed every account's conversations.
 *
 * The ownership map is kept here instead, in the app database, and checked before any transcript is
 * read or deleted. It holds an account name, an opaque conversation id and a timestamp — and
 * deliberately NOT the first message, which is the one field that would be tempting to cache for
 * the conversation list and is also a question somebody asked about their own health. Transcripts
 * stay in the one place that already holds them; this table stays free of anything that is PHI.
 */

/** One conversation an account owns. */
export interface OwnedConversation {
  conversationId: string;
  /** Milliseconds since the epoch — when it was claimed. */
  at: number;
}

export abstract class BaseChatConversationsProvider {
  abstract initialize(): Promise<void>;

  /** Record that `conversationId` belongs to `userId`. Idempotent. */
  abstract claim(userId: string, conversationId: string, at: Date): Promise<void>;

  /** Does this account own it? The question asked before any transcript is read. */
  abstract owns(userId: string, conversationId: string): Promise<boolean>;

  /** Everything this account owns, newest first. */
  abstract list(userId: string): Promise<OwnedConversation[]>;

  /** Forget one. `false` when it was not theirs. */
  abstract release(userId: string, conversationId: string): Promise<boolean>;

  /** Forget all of an account's — the account is going. */
  abstract releaseAll(userId: string): Promise<number>;
}
