/**
 * The glossary lookup (yourphr#640): where a plain-language explanation of a medical code comes
 * from. A lab result carries `2160-0` in LOINC; the glossary turns that into "Creatinine — a waste
 * product filtered by your kidneys", with a link to read more.
 *
 * OPTIONAL capability with an inert default, the same shape as the source client (yourphr#612): an
 * instance that must not reach the internet binds `null`, every other feature is unaffected, and
 * each refusal says why rather than looking like an empty result.
 *
 * This is the only read path in the stack that leaves the LAN for something other than a provider
 * sync, so an implementation goes through the guarded HTTP client like everything else.
 */

/** What an explanation looks like. Go returns a FHIR ValueSet; these are its populated fields. */
export interface GlossaryEntry {
  /** The term as the source names it — "Creatinine (Blood)". */
  title: string;
  /** Plain-language description. The whole point of the feature. */
  description: string;
  /** Where a person can read more. */
  url: string;
  /** Who wrote it, so the screen can attribute rather than appear to be giving advice itself. */
  publisher: string;
  /** When the source last updated it, ISO 8601. */
  updatedAt: string;
}

export abstract class BaseGlossaryProvider {
  /** For the boot log and the admin screen: which lookup this instance is bound to. */
  abstract readonly name: string;

  /** Whether this provider can actually answer. A Null provider says no and gives a reason. */
  abstract readonly available: boolean;

  /** Why it cannot answer, for the caller to show. Empty when it can. */
  abstract readonly unavailableReason: string;

  /**
   * Explain one code. `undefined` means NO EXPLANATION EXISTS — a normal answer, not a failure:
   * the sources do not describe every code, and the screen must say "not available" rather than
   * render an empty box. Throwing is reserved for the lookup itself failing.
   */
  abstract explain(code: string, codeSystemOid: string): Promise<GlossaryEntry | undefined>;
}

/** An instance that never reaches out. Serves cached explanations; fetches nothing new. */
export class NullGlossaryProvider extends BaseGlossaryProvider {
  readonly name = 'null';
  readonly available = false;
  readonly unavailableReason = 'no glossary lookup is configured on this instance, so codes this instance has not seen before cannot be explained';
  async explain(): Promise<undefined> { return undefined; }
}

/**
 * Where explanations already fetched are kept. A cache, not records: every row is re-fetchable and
 * nothing in it is PHI. It exists because MedlinePlus allows 100 requests a minute and one lab page
 * can carry dozens of codes — without it, opening the same page twice is two dozen outbound calls.
 */
export abstract class BaseGlossaryCacheProvider {
  abstract get(code: string, codeSystemOid: string): GlossaryEntry | undefined;
  abstract put(code: string, codeSystemOid: string, entry: GlossaryEntry, now?: Date): void;
  /** How many codes this instance has ever explained — the number yourphr#606 turned on. */
  abstract count(): number;
}
