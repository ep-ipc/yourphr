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
export class BaseGlossaryProvider {
}
/** An instance that never reaches out. Serves cached explanations; fetches nothing new. */
export class NullGlossaryProvider extends BaseGlossaryProvider {
    name = 'null';
    available = false;
    unavailableReason = 'no glossary lookup is configured on this instance, so codes this instance has not seen before cannot be explained';
    async explain() { return undefined; }
}
/**
 * Where explanations already fetched are kept. A cache, not records: every row is re-fetchable and
 * nothing in it is PHI. It exists because MedlinePlus allows 100 requests a minute and one lab page
 * can carry dozens of codes — without it, opening the same page twice is two dozen outbound calls.
 */
export class BaseGlossaryCacheProvider {
}
//# sourceMappingURL=BaseGlossaryProvider.js.map