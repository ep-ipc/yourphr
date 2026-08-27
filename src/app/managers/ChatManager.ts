/**
 * Chat (yourphr#594): the one door to "ask a question about my own records and get an answer".
 *
 * Ported from the Go stack's `backend/pkg/search` + `handler/search.go`, with the topology changed.
 * There, the browser held the retrieval engine's API key and queried it directly; here the key
 * never leaves the process and every call arrives with an `ApiContext`, so `who(ctx)` is the owner
 * seam in exactly the place the rest of this stack keeps it (`RecordsManager.who`).
 *
 * The retrieval provider behind it is an OPTIONAL capability with an inert default, the same shape
 * as the source client (yourphr#612) and the glossary (yourphr#640): an instance with no sidecar
 * and no model binds `null`, everything else is unaffected, and a refusal says why rather than
 * looking like a model that had nothing to say.
 *
 * WHAT THIS MANAGER DOES NOT OWN: the records. It never reads the record store directly — the
 * backfill asks the Records door for them and hands each one down to be indexed. Two doors to the
 * same resource is the trap the architecture doc names, and an index is not an excuse for one.
 */
import { BaseManager, type BackupData } from '../../framework/BaseManager.js';
import type { Engine } from '../../framework/Engine.js';
import { ApiError, type ApiContext } from '../../framework/ApiContext.js';
import type {
  BaseChatProvider,
  ChatAnswer,
  ChatConversation,
  ChatIndexedRecord,
  ChatMessage,
} from '../providers/BaseChatProvider.js';
import type { StoredRecord } from '../providers/BaseRecordsProvider.js';
import { toResourceFhir } from '../../server.js';
import { textFor } from '../providers/record-text.js';

declare module '../../framework/Engine.js' {
  interface ManagerRegistry {
    chat: ChatManager;
  }
}

/** The longest question that will be accepted. Past this it is not a question, it is a payload. */
const MAX_QUESTION = 4_000;

/**
 * Record types kept OUT of the retrieval index: billing, not medicine.
 *
 * These are administrative artefacts of how care was paid for. They answer no question a person
 * asks about their own health, and in a real export they DOMINATE — in the Synthea bundle this was
 * first tried against, ExplanationOfBenefit and Claim were 10,917 of roughly 20,000 indexed
 * characters, more than half the index, against 193 characters for all three of the patient's
 * actual diagnoses. Retrieval is a fixed number of records, so every billing row that scores is a
 * clinical record that does not: asking "what conditions have I been diagnosed with" spent four of
 * its ten slots on untitled claims.
 *
 * Excluded here rather than filtered at query time so they never occupy the index at all.
 */
const NOT_CLINICAL = new Set(['Claim', 'ExplanationOfBenefit', 'Coverage', 'PaymentNotice', 'PaymentReconciliation', 'Invoice', 'ChargeItem', 'Account']);

/**
 * What each record type IS, in the words a patient would use.
 *
 * This is not decoration. Asked "what conditions have I been diagnosed with", the model answered
 * with a list of blood-test names — because nothing in the retrieved text distinguished a diagnosis
 * from a laboratory measurement. `Condition` and `Observation` are FHIR's words, they appear in a
 * field the model is told to ignore, and "Erythrocyte distribution width" reads exactly like a
 * finding if you cannot tell what kind of record you are looking at.
 *
 * Naming the kind in the text itself fixes both halves at once: retrieval matches "diagnosed"
 * against "Diagnosis", and the model can tell the two apart when it answers.
 */
const KIND: Record<string, string> = {
  Condition: 'Diagnosis',
  Observation: 'Test result or measurement',
  DiagnosticReport: 'Test report',
  MedicationRequest: 'Medication prescribed',
  MedicationStatement: 'Medication taken',
  MedicationDispense: 'Medication dispensed',
  Immunization: 'Vaccination',
  Procedure: 'Procedure',
  AllergyIntolerance: 'Allergy',
  Encounter: 'Visit',
  CarePlan: 'Care plan',
  CareTeam: 'Care team',
  Patient: 'Personal details',
  Practitioner: 'Clinician',
  Organization: 'Healthcare organisation',
  DocumentReference: 'Document',
  Goal: 'Care goal',
  ServiceRequest: 'Requested service',
};

export class ChatManager extends BaseManager {
  readonly name = 'chat';
  /** Records, because the backfill reads through that door rather than around it. */
  override readonly dependsOn = ['records'] as const;

  /** Set while a backfill is running, so two cannot overlap and double the work. */
  private backfilling = new Set<string>();

  constructor(
    engine: Engine,
    private readonly provider: BaseChatProvider,
    private readonly log: (line: string) => void = () => undefined
  ) {
    super(engine);
  }

  override async initialize(config: Record<string, unknown> = {}): Promise<void> {
    if (this.provider.available) {
      try {
        await this.provider.initialize();
      } catch (err) {
        // A sidecar that is down must not take the instance with it. Chat is one page; records,
        // sources and the dashboard are the product. The refusal is loud in the log and every chat
        // request answers with the reason — which is the failure yourphr#546 asks for, visible
        // rather than silent.
        this.degraded = `chat is configured but its search sidecar could not be reached: ${(err as Error).message}`;
        this.log(`chat: DEGRADED — ${this.degraded}`);
      }
    }
    await super.initialize(config);
    this.log(`chat: provider '${this.provider.name}'${this.available() ? '' : ' — unavailable'}`);
  }

  /** Set when a configured provider failed to come up. Empty when it did, or when none is configured. */
  private degraded = '';

  private who(ctx: ApiContext): string {
    ctx.requireAuthenticated();
    return ctx.username;
  }

  /** Whether this record is the kind chat indexes at all. Billing is not. */
  static isClinical(resourceType: string): boolean {
    return !NOT_CLINICAL.has(resourceType);
  }

  /** Whether a question can actually be answered right now. */
  available(): boolean {
    return this.provider.available && this.degraded === '';
  }

  /** Why it cannot be, for the caller to show. Empty when it can. */
  unavailable(): string {
    if (this.degraded !== '') return this.degraded;
    return this.provider.available ? '' : this.provider.unavailableReason;
  }

  private requireAvailable(): void {
    if (!this.available()) throw new ApiError(503, this.unavailable());
  }

  // --- asking ---

  /** POST /api/secure/chat — one question, answered from the caller's records and nothing else. */
  async ask(ctx: ApiContext, question: string, conversationId?: string): Promise<ChatAnswer> {
    const userId = this.who(ctx);
    this.requireAvailable();
    const q = question.trim();
    if (q === '') throw new ApiError(400, 'a question is required');
    if (q.length > MAX_QUESTION) throw new ApiError(400, `a question may be at most ${MAX_QUESTION} characters`);
    try {
      return await this.provider.ask(userId, q, conversationId);
    } catch (err) {
      const message = (err as Error).message;
      // The caller asked to continue a conversation that is not theirs, or does not exist. Told
      // apart from a sidecar failure so the page can say "gone" rather than "try again later".
      if (message === 'conversation not found') throw new ApiError(404, 'conversation not found');
      this.log(`chat: ask failed for ${userId}: ${message}`);
      throw new ApiError(502, `the assistant could not answer: ${message}`);
    }
  }

  /** GET /api/secure/chat/conversations — the list down the side of the chat page. */
  async conversations(ctx: ApiContext): Promise<ChatConversation[]> {
    const userId = this.who(ctx);
    if (!this.available()) return [];
    return this.provider.conversations(userId);
  }

  /** GET /api/secure/chat/conversations/:id — one transcript, oldest turn first. */
  async messages(ctx: ApiContext, conversationId: string): Promise<ChatMessage[]> {
    const userId = this.who(ctx);
    this.requireAvailable();
    if (conversationId.trim() === '') throw new ApiError(400, 'a conversation id is required');
    return this.provider.messages(userId, conversationId);
  }

  /** DELETE /api/secure/chat/conversations/:id. */
  async forget(ctx: ApiContext, conversationId: string): Promise<boolean> {
    const userId = this.who(ctx);
    this.requireAvailable();
    return this.provider.forget(userId, conversationId);
  }

  // --- the index ---

  /**
   * Index one record. Called on the write path, so it must never throw INTO a sync: a search index
   * that missed a row is a worse search, while a sync that failed because of one is lost records.
   * Returns whether it landed, for the backfill's count.
   */
  async index(userId: string, record: StoredRecord): Promise<boolean> {
    if (!this.available()) return false;
    if (NOT_CLINICAL.has(record.resourceType)) return false;
    try {
      await this.provider.index(ChatManager.documentFor(userId, record));
      return true;
    } catch (err) {
      this.log(`chat: failed to index ${record.resourceType}/${record.id} for ${userId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * A stored record as the index holds it.
   *
   * `toResourceFhir` is what computes `sort_title` and `sort_date`, and reusing it is the point:
   * the Go port had to copy those three fields back onto a second object by hand after the search
   * extractor computed them on a different one, and when that copy was missing every document
   * indexed with an empty title and search matched nothing. Here there is one shaping function and
   * both the record pages and the index read it.
   */
  static documentFor(userId: string, record: StoredRecord): ChatIndexedRecord {
    const shaped = toResourceFhir(record.resource, record.sourceId);
    const sortDate = Date.parse(String(shaped['sort_date'] ?? ''));
    return {
      id: `${record.sourceId}-${record.resourceType}-${record.id}`,
      userId,
      sourceId: record.sourceId,
      resourceType: record.resourceType,
      resourceId: record.id,
      sortDate: Number.isFinite(sortDate) ? sortDate : 0,
      sortTitle: String(shaped['sort_title'] ?? ''),
      sourceUri: String(shaped['source_uri'] ?? ''),
      text: ChatManager.textOf(record, shaped),
    };
  }

  /**
   * What one record SAYS, as the model will read it: its display title, then the extracted text.
   *
   * The title is prepended rather than left to a separate field because a retrieved chunk has to be
   * self-describing — and because `textFor()` alone does not carry the record's NAME. That function
   * skips the whole `code` subtree (`SKIP_KEYS` in record-text.ts) to avoid matching bare code
   * values, which also drops `code.text` and `code.coding[].display` — so an Observation reduces to
   * "Observation final 13.5 g/dL 2024-01-10" and a Condition to "Condition 2024-07-01", with no
   * hint of haemoglobin or hypertension anywhere in it.
   *
   * That is worth reporting against the dashboard's own search, which indexes the same function and
   * so cannot match a condition by name either. It is NOT worth fixing from here: record-text.ts is
   * shared with that search, and changing what it extracts changes what that search finds. Chat
   * composes around it instead, and the report goes upstream.
   */
  static textOf(record: StoredRecord, shaped: Record<string, unknown>): string {
    const kind = KIND[record.resourceType] ?? record.resourceType.replace(/([a-z])([A-Z])/g, '$1 $2');
    const title = String(shaped['sort_title'] ?? '').trim();
    const body = textFor(record.resource);
    // Avoid saying the title twice when the extraction already opens with it.
    const rest = title === '' || body.toLowerCase().startsWith(title.toLowerCase()) ? body : `${title} — ${body}`;
    return `${kind}: ${rest}`;
  }

  /**
   * Put everything the caller already holds into the index.
   *
   * Chat is retrieval-first: without this, turning the feature on answers "I do not have enough
   * information" about every record imported before it was switched on, and the only way to fix
   * that is to re-sync every source. The Go stack grew `ListAllResources` for exactly this and
   * never wired it to anything.
   *
   * Reads through the Records door, one page at a time, so a large account does not assemble every
   * record it owns in memory at once.
   */
  async reindex(ctx: ApiContext, options: { force?: boolean } = {}): Promise<{ indexed: number; skipped: boolean }> {
    const userId = this.who(ctx);
    this.requireAvailable();
    if (this.backfilling.has(userId)) return { indexed: 0, skipped: true };
    if (!options.force && (await this.provider.indexedCount(userId)) > 0) return { indexed: 0, skipped: true };

    this.backfilling.add(userId);
    try {
      const records = (await this.engine.managers.records.storedFor(ctx)).filter((r) => !NOT_CLINICAL.has(r.resourceType));
      let indexed = 0;
      for (const record of records) {
        if (await this.index(userId, record)) indexed++;
      }
      this.log(`chat: backfilled ${indexed}/${records.length} clinical record(s) for ${userId}`);
      return { indexed, skipped: false };
    } finally {
      this.backfilling.delete(userId);
    }
  }

  /**
   * GET /api/secure/chat/status — what the page asks before it renders anything, and the trigger
   * for the one-off backfill.
   *
   * The backfill is started here rather than inside `ask()` on purpose: a first question that
   * silently blocks while several thousand records are indexed looks like a model that hung. This
   * runs it in the background when the page opens, so by the time somebody has typed a question it
   * is usually done, and the page can say what is happening in the meantime.
   */
  async status(ctx: ApiContext): Promise<{ available: boolean; reason: string; indexed: number; indexing: boolean }> {
    const userId = this.who(ctx);
    if (!this.available()) return { available: false, reason: this.unavailable(), indexed: 0, indexing: false };
    let indexed = 0;
    try {
      indexed = await this.provider.indexedCount(userId);
    } catch (err) {
      return { available: false, reason: `the search sidecar did not answer: ${(err as Error).message}`, indexed: 0, indexing: false };
    }
    if (indexed === 0 && !this.backfilling.has(userId)) {
      // Not awaited: the page gets its answer now and watches `indexing` go false on a later poll.
      void this.reindex(ctx).catch((err: Error) => this.log(`chat: backfill failed for ${userId}: ${err.message}`));
    }
    return { available: true, reason: '', indexed, indexing: this.backfilling.has(userId) };
  }

  /** The account is going: its indexed records and conversations go with it. */
  async removeAll(ctx: ApiContext): Promise<void> {
    const userId = this.who(ctx);
    if (!this.available()) return;
    try {
      await this.provider.removeAll(userId);
    } catch (err) {
      // Reported, not raised: the account deletion that called this must still finish. A stranded
      // index entry is a bug to fix, not a reason to leave an account half-deleted.
      this.log(`chat: failed to clear the index for ${userId}: ${(err as Error).message}`);
    }
  }

  // --- the base contract ---

  /**
   * Nothing to copy. The transcripts live in the sidecar, which is a cache of the record store plus
   * a chat history an operator can regenerate by asking again; the ownership map lives in the app
   * database, which the backup coordinator copies whole. Saying so here is the point of the
   * abstract method — a manager cannot exist without answering the question.
   */
  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString() };
  }

  async restore(): Promise<void> { /* the ownership map is restored with the app database */ }
}
