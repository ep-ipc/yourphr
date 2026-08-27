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
 * read or deleted.
 *
 * TRANSCRIPTS THEMSELVES depend on the provider. A retrieval engine that runs the conversation
 * writes and keeps its own (`TypesenseChatProvider`), and for that one this is ownership only — an
 * account name, an opaque id and a timestamp, nothing that is PHI. A provider that runs the
 * conversation ITSELF (`LocalChatProvider`) has nowhere else to put the turns, and stores them here
 * through `append`/`transcript` below — in the app database, which is encrypted at rest, rather
 * than in a sidecar's unencrypted volume.
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

  // --- transcripts, for a provider that runs the conversation itself ---
  //
  // Unused by a provider whose engine keeps its own; see the header.

  /** Append one turn. `at` is the wall clock, and ordering within it is insertion order. */
  abstract append(conversationId: string, turn: { role: 'user' | 'assistant'; message: string; at: Date }): Promise<void>;

  /** Every turn of one conversation, oldest first. Ownership is the caller's to check. */
  abstract transcript(conversationId: string): Promise<{ role: 'user' | 'assistant'; message: string; at: number }[]>;
}
