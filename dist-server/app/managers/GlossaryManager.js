/**
 * The glossary (yourphr#640): the one door to "what does this code actually mean".
 *
 * A record says `2160-0`. A person needs "Creatinine — a waste product filtered by your kidneys".
 * That translation is yourphr#262 — *would my mum understand this* — as a mechanism rather than a
 * principle, and it is deliberately NOT lab-shaped: any coded value on any screen can ask.
 *
 * Cache first, always. MedlinePlus allows 100 requests a minute and one lab page can carry dozens
 * of codes, so a code this instance has already explained must never cause another request.
 *
 * The lookup behind it is an OPTIONAL capability with an inert default (yourphr#612's shape): an
 * instance that must not reach the internet binds `null`, keeps serving everything it has already
 * cached, and says why a new code cannot be explained instead of showing an empty box.
 */
import { BaseManager } from '../../framework/BaseManager.js';
import { ApiError } from '../../framework/ApiContext.js';
/**
 * FHIR system URI -> the OID MedlinePlus speaks, carried from Go's `FindCodeSystem`
 * (`handler/glossary.go`). Source: https://terminology.hl7.org/external_terminologies.html
 */
const CODE_SYSTEMS = {
    'http://hl7.org/fhir/sid/icd-10-cm': '2.16.840.1.113883.6.90',
    'http://hl7.org/fhir/sid/icd-10': '2.16.840.1.113883.6.90',
    'http://terminology.hl7.org/CodeSystem/icd9cm': '2.16.840.1.113883.6.103',
    'http://snomed.info/sct': '2.16.840.1.113883.6.96',
    'http://www.nlm.nih.gov/research/umls/rxnorm': '2.16.840.1.113883.6.88',
    'http://hl7.org/fhir/sid/ndc': '2.16.840.1.113883.6.69',
    'http://loinc.org': '2.16.840.1.113883.6.1',
    'http://www.ama-assn.org/go/cpt': '2.16.840.1.113883.6.12',
};
/** An OID passed straight through, as Go does — the caller already speaks MedlinePlus. */
const OID_PREFIX = '2.16.840.1.113883.6.';
export class GlossaryManager extends BaseManager {
    provider;
    cache;
    log;
    name = 'glossary';
    dependsOn = [];
    constructor(engine, provider, cache, log = () => undefined) {
        super(engine);
        this.provider = provider;
        this.cache = cache;
        this.log = log;
    }
    async initialize(config = {}) {
        await super.initialize(config);
        this.log(`glossary: lookup provider '${this.provider.name}'${this.provider.available ? '' : ' — cached codes only'}, ${this.cache.count()} code(s) already explained`);
    }
    /** Map a FHIR system URI to the OID the lookup speaks. Throws 400 on one we do not know. */
    codeSystemOid(system) {
        if (system.startsWith(OID_PREFIX))
            return system;
        const oid = CODE_SYSTEMS[system];
        if (!oid)
            throw new ApiError(400, `code system not found: ${system}`);
        return oid;
    }
    /** Every code system this build can explain, for the UI to decide whether to offer the link. */
    supportedSystems() { return Object.keys(CODE_SYSTEMS); }
    /**
     * Explain one code. `undefined` means NO EXPLANATION IS AVAILABLE — a normal answer the screen
     * should render as such, not an error: neither the cache nor the source describes every code.
     *
     * A code is not PHI, but this asks on behalf of somebody looking at their record, so the caller
     * is still required — an unauthenticated endpoint that triggers an outbound request is an
     * amplification surface for no benefit.
     */
    async explain(ctx, code, system) {
        ctx.requireAuthenticated();
        if (code.trim() === '')
            throw new ApiError(400, 'code is required');
        const oid = this.codeSystemOid(system);
        const cached = this.cache.get(code, oid);
        if (cached)
            return { ...cached, code, codeSystem: oid, source: 'cache' };
        if (!this.provider.available)
            return undefined;
        let found;
        try {
            found = await this.provider.explain(code, oid);
        }
        catch (err) {
            // A lookup that fails is not a broken page. The record is still correct; only the
            // explanation is missing, and the screen says so.
            this.log(`glossary: lookup failed for ${code} (${oid}): ${err.message}`);
            return undefined;
        }
        if (!found)
            return undefined;
        this.cache.put(code, oid, found);
        return { ...found, code, codeSystem: oid, source: 'lookup' };
    }
    /** Why a new code cannot be explained, for the caller to show. Empty when it can. */
    unavailable() { return this.provider.available ? '' : this.provider.unavailableReason; }
    /** The cache lives in the app database, which the backup coordinator copies whole. */
    async backup() {
        return { manager: this.name, takenAt: new Date().toISOString() };
    }
    async restore() { }
}
//# sourceMappingURL=GlossaryManager.js.map