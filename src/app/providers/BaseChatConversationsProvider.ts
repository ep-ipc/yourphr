/**
 * Who owns which conversation (yourphr#594).
 *
 * It is a table of its own, rather than a column on something else, because of where this started.
 * An earlier design had a search-engine sidecar run the conversation and keep the transcript in a
 * collection whose schema it owned — no field on it for an account — so there was nothing for an
 * owner filter to bind to, and the version that shipped simply did not scope it: every account's
 * chat page listed every account's conversations.
 *
 * The ownership map is kept here instead, in the app database, and checked before any transcript is
 * read or deleted.
 *
 * TRANSCRIPTS live here too, through `append`/`transcript` below — in the app database, which is
 * encrypted at rest along with everything else. The questions people ask about their own bodies are
 * PHI, and an earlier design that let a search-engine sidecar keep them in its own unencrypted
 * volume is exactly what this avoids.
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

  /**
   * Append one turn. `at` is the wall clock; ordering within it is insertion order.
   *
   * Takes the account and REFUSES a conversation that is not theirs, rather than trusting the caller
   * to have checked. Throws, because by the time a turn is being written the ownership question has
   * already been answered somewhere upstream — a failure here means a caller got it wrong, and a
   * silent no-op would hide that until someone noticed a transcript with holes in it.
   */
  abstract append(userId: string, conversationId: string, turn: { role: 'user' | 'assistant'; message: string; at: Date }): Promise<void>;

  /**
   * Every turn of one of `userId`'s conversations, oldest first. Empty when it is not theirs.
   *
   * The account is a parameter and not an assumption. These two methods used to take a conversation
   * id alone and leave the ownership check to whoever called them: correct in every caller, and one
   * forgotten check away from handing somebody another person's transcript. Scoping the query is
   * the difference between a convention and an invariant.
   */
  abstract transcript(userId: string, conversationId: string): Promise<{ role: 'user' | 'assistant'; message: string; at: number }[]>;
}
