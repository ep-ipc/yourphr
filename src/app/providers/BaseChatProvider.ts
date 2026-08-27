/**
 * The chat capability (yourphr#594): ask a question in plain language and get an answer drawn from
 * your own records — retrieval over the record store, then a language model that must answer from
 * what was retrieved and nothing else.
 *
 * OPTIONAL capability with an inert default, the same shape as the source client (yourphr#612) and
 * the glossary lookup (yourphr#640): an instance that has no search sidecar and no model binds
 * `null`, every other feature is unaffected, and the refusal says why rather than looking like an
 * empty answer.
 *
 * THE OWNER SEAM IS IN THE INTERFACE, NOT THE CALLER. Every method takes `userId` and a provider
 * must scope to it. This is deliberate and is the correction the port makes to the Go design it
 * replaces: there, the browser held the search engine's API key and queried the collection
 * directly, with no owner filter on either the retrieval or the conversation history — so on an
 * instance with more than one account, one member's question could retrieve another member's
 * records. A provider that cannot scope to an owner cannot implement this interface.
 */

/** One turn of a conversation. `role` is whose turn it was. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  message: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/** A conversation as the list on the left of the chat page shows it. */
export interface ChatConversation {
  id: string;
  /** The question that started it — what the list is labelled with. */
  firstMessage: string;
  at: number;
}

/** What one question produced. */
export interface ChatAnswer {
  /** The conversation this turn belongs to; new when the caller passed none. */
  conversationId: string;
  answer: string;
  /** The records the answer was drawn from, so the page can cite rather than assert. */
  citations: { resourceType: string; resourceId: string; sourceId: string; title: string }[];
}

export abstract class BaseChatProvider {
  /** For the boot log and the admin screen: which implementation this instance is bound to. */
  abstract readonly name: string;

  /** Whether this provider can actually answer. A Null provider says no and gives a reason. */
  abstract readonly available: boolean;

  /** Why it cannot answer, for the caller to show. Empty when it can. */
  abstract readonly unavailableReason: string;

  /** Whatever the provider needs standing before it can answer. Called once, at boot. */
  abstract initialize(): Promise<void>;

  /** Answer one question from `userId`'s records alone. */
  abstract ask(userId: string, question: string, conversationId?: string): Promise<ChatAnswer>;

  /** `userId`'s conversations, newest first. */
  abstract conversations(userId: string): Promise<ChatConversation[]>;

  /** Every turn of one of `userId`'s conversations, oldest first. Empty when it is not theirs. */
  abstract messages(userId: string, conversationId: string): Promise<ChatMessage[]>;

  /** Forget one conversation. `false` when it is not theirs to forget. */
  abstract forget(userId: string, conversationId: string): Promise<boolean>;

  /** Drop everything held for an account — its conversations and their transcripts. */
  abstract removeAll(userId: string): Promise<void>;
}

/** An instance with no chat. Answers nothing, and says why. */
export class NullChatProvider extends BaseChatProvider {
  readonly name = 'null';
  readonly available = false;
  readonly unavailableReason =
    'chat is not configured on this instance — it needs a search sidecar and a language model, which an operator turns on deliberately';

  async initialize(): Promise<void> { /* nothing to bring into being */ }
  async ask(): Promise<ChatAnswer> { throw new Error(this.unavailableReason); }
  async conversations(): Promise<ChatConversation[]> { return []; }
  async messages(): Promise<ChatMessage[]> { return []; }
  async forget(): Promise<boolean> { return false; }
  async removeAll(): Promise<void> { /* nothing held */ }
}
