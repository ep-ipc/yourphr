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

/** One record as the retrieval index holds it. Shaped by `toResourceFhir`, minus what a model has no use for. */
export interface ChatIndexedRecord {
  /** Stable across re-indexing: `${sourceId}-${resourceType}-${id}`, as the Go indexer composed it. */
  id: string;
  userId: string;
  sourceId: string;
  resourceType: string;
  resourceId: string;
  /** Milliseconds since the epoch; 0 when the record carries no date. */
  sortDate: number;
  sortTitle: string;
  sourceUri: string;
  /**
   * The record's human-readable text — `textFor()`, the same extraction the dashboard's own search
   * indexes. What the model is allowed to read, and the only thing it may answer from.
   *
   * NOT the raw FHIR JSON, for two reasons found the hard way. A retrieval engine infers the types
   * of a nested object's fields from the first document it sees, and FHIR is far too heterogeneous
   * for that to hold — one Synthea bundle refused six of its own ExplanationOfBenefit records
   * because an adjudication amount was an integer in the first and a decimal in the rest. And a
   * model handed raw JSON narrates the plumbing back at the patient, which the system prompt then
   * has to spend half its length forbidding.
   */
  text: string;
}

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

  /**
   * Whether this provider keeps a SEPARATE COPY of the records that has to be filled and kept up to
   * date. True for an engine holding its own index; false for one that reads the records where they
   * already live.
   *
   * The manager reads this to decide whether a backfill exists at all. It is not a performance hint:
   * a provider that needs no index cannot go stale, has nothing to re-index, and can answer about a
   * record the moment it is written — so asking it "how many are indexed" and offering to fix the
   * answer would be inventing a problem it does not have.
   */
  abstract readonly needsIndexing: boolean;

  /**
   * Bring the retrieval index and the conversation model into being. Idempotent: an index that
   * already exists is left alone, which is what makes this safe to run at every boot.
   */
  abstract initialize(): Promise<void>;

  /** Put one record into the retrieval index, replacing any earlier version of it. */
  abstract index(record: ChatIndexedRecord): Promise<void>;

  /** How many of this account's records the index holds — what tells a backfill whether to run. */
  abstract indexedCount(userId: string): Promise<number>;

  /** Answer one question from `userId`'s records alone. */
  abstract ask(userId: string, question: string, conversationId?: string): Promise<ChatAnswer>;

  /** `userId`'s conversations, newest first. */
  abstract conversations(userId: string): Promise<ChatConversation[]>;

  /** Every turn of one of `userId`'s conversations, oldest first. Empty when it is not theirs. */
  abstract messages(userId: string, conversationId: string): Promise<ChatMessage[]>;

  /** Forget one conversation. `false` when it is not theirs to forget. */
  abstract forget(userId: string, conversationId: string): Promise<boolean>;

  /** Drop everything held for an account: its indexed records and its conversations. */
  abstract removeAll(userId: string): Promise<void>;
}

/** An instance with no chat. Answers nothing, indexes nothing, and says which. */
export class NullChatProvider extends BaseChatProvider {
  readonly name = 'null';
  readonly available = false;
  readonly needsIndexing = false;
  readonly unavailableReason =
    'chat is not configured on this instance — it needs a search sidecar and a language model, which an operator turns on deliberately';

  async initialize(): Promise<void> { /* nothing to bring into being */ }
  async index(): Promise<void> { /* nothing indexes */ }
  async indexedCount(): Promise<number> { return 0; }
  async ask(): Promise<ChatAnswer> { throw new Error(this.unavailableReason); }
  async conversations(): Promise<ChatConversation[]> { return []; }
  async messages(): Promise<ChatMessage[]> { return []; }
  async forget(): Promise<boolean> { return false; }
  async removeAll(): Promise<void> { /* nothing held */ }
}
