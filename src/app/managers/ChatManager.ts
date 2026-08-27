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
 * WHAT THIS MANAGER DOES NOT OWN: the records. It never reads the record store directly; retrieval
 * goes through the Records door, which is where the owner seam already lives. Two doors to the same
 * resource is the trap the architecture doc names, and a chat feature is not an excuse for one.
 */
import { BaseManager, type BackupData } from '../../framework/BaseManager.js';
import type { Engine } from '../../framework/Engine.js';
import { ApiError, type ApiContext } from '../../framework/ApiContext.js';
import type { BaseChatProvider, ChatAnswer, ChatConversation, ChatMessage } from '../providers/BaseChatProvider.js';
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
  /** Records, because retrieval reads through that door rather than around it. */
  override readonly dependsOn = ['records'] as const;

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

  /** Whether this record is the kind chat may answer from. Billing is not. */
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

  // --- what a record says ---

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
   * GET /api/secure/chat/status — what the page and the nav ask before offering chat at all.
   *
   * There is nothing to report beyond whether a question can be answered. Retrieval reads the
   * records where they already are, so there is no index to fill, no backfill to wait for, and no
   * readiness state that can be stale.
   */
  async status(ctx: ApiContext): Promise<{ available: boolean; reason: string }> {
    this.who(ctx);
    return this.available() ? { available: true, reason: '' } : { available: false, reason: this.unavailable() };
  }

  /** The account is going: its conversations and their transcripts go with it. */
  async removeAll(ctx: ApiContext): Promise<void> {
    const userId = this.who(ctx);
    if (!this.available()) return;
    try {
      await this.provider.removeAll(userId);
    } catch (err) {
      // Reported, not raised: the account deletion that called this must still finish. Stranded
      // chat data is a bug to fix, not a reason to leave an account half-deleted.
      this.log(`chat: failed to clear chat data for ${userId}: ${(err as Error).message}`);
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
