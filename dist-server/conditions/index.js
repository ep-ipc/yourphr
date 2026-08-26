/**
 * Conditions, classified and reconciled (yourphr#595) — ported decision-for-decision from the Go
 * `condition` package (its #262 display principles): every record gets a TIER (who asserted it),
 * a CATEGORY (what kind of thing it is) and a legible STATE; duplicates across sources collapse on
 * a standard code (SNOMED, then ICD), else on the title, keeping the most recently recorded one.
 *
 * Absent is a fact: an unparseable record is skipped, entered-in-error is honoured by omission, and
 * a status nobody stated is 'Unknown' — shown, never assumed. Provenance (Go's clinician
 * attribution resolver) is not ported here; the field is simply absent.
 */
export const CategoryProblem = 'problem-list-item';
export const CategorySDOH = 'sdoh';
export const CategoryHealthConcern = 'health-concern';
export const TierClinician = 'clinician';
export const TierSelfReported = 'self-reported';
export const TierProfile = 'profile';
export function conceptCode(cc) {
    for (const c of cc?.coding ?? []) {
        if (typeof c?.code === 'string' && c.code !== '')
            return c.code.toLowerCase();
    }
    return '';
}
export function conceptText(cc) {
    if (!cc)
        return '';
    if (typeof cc.text === 'string' && cc.text !== '')
        return cc.text;
    for (const c of cc.coding ?? []) {
        if (typeof c?.display === 'string' && c.display !== '')
            return c.display;
    }
    return '';
}
export function refIsType(ref, type) {
    return typeof ref?.reference === 'string' && ref.reference.includes(`${type}/`);
}
export function noteText(notes) {
    return (notes ?? []).map((n) => n?.text).filter((t) => typeof t === 'string' && t !== '').join('\n');
}
/** The Go standardCodings helper, parameterised by the systems each module calls "standard". */
export function standardCodingsBy(cc, isStandard) {
    const out = [];
    for (const c of cc?.coding ?? []) {
        if (isStandard(String(c?.system ?? ''))) {
            out.push({ ...(c.system ? { system: c.system } : {}), ...(c.code ? { code: c.code } : {}), ...(c.display ? { display: c.display } : {}) });
        }
    }
    return out.length ? out : undefined;
}
const isStandardSystem = (system) => {
    const s = system.toLowerCase();
    return s.includes('icd') || s.includes('snomed') || s.includes('loinc');
};
function existingCategory(cats) {
    for (const cc of cats ?? []) {
        for (const c of cc?.coding ?? []) {
            switch (String(c?.code ?? '').toLowerCase()) {
                case 'problem-list-item':
                case 'encounter-diagnosis': return CategoryProblem;
                case 'sdoh': return CategorySDOH;
                case 'health-concern': return CategoryHealthConcern;
            }
        }
    }
    return '';
}
function vendorTell(ids) {
    for (const id of ids ?? []) {
        const value = String(id?.value ?? '');
        const colon = value.lastIndexOf(':');
        if (colon === -1)
            continue;
        const rest = value.slice(colon + 1);
        const comma = rest.indexOf(',');
        if (comma === -1)
            continue;
        const tell = rest.slice(0, comma);
        if (tell === 'HealthCondition' || tell === 'PersonalHealthConsideration')
            return tell;
    }
    return '';
}
const hasStandardCode = (cc) => (cc?.coding ?? []).some((c) => isStandardSystem(String(c?.system ?? '')));
const hasAnyCoding = (cc) => Array.isArray(cc?.coding) && cc.coding.length > 0;
function classifyOne(raw) {
    const patientAsserted = refIsType(raw.asserter, 'Patient') || (!raw.asserter && refIsType(raw.recorder, 'Patient'));
    const existing = existingCategory(raw.category);
    if (existing !== '') {
        if (existing === CategorySDOH || existing === CategoryHealthConcern)
            return { tier: TierProfile, category: existing, selfReported: false };
        if (patientAsserted && !hasStandardCode(raw.code))
            return { tier: TierSelfReported, category: CategoryProblem, selfReported: true };
        return { tier: TierClinician, category: CategoryProblem, selfReported: false };
    }
    const tell = vendorTell(raw.identifier);
    const stdCode = hasStandardCode(raw.code);
    const anyCoding = hasAnyCoding(raw.code);
    const clinicianRecorder = refIsType(raw.asserter, 'Practitioner') || refIsType(raw.recorder, 'Practitioner');
    if (stdCode || tell === 'HealthCondition')
        return { tier: TierClinician, category: CategoryProblem, selfReported: false };
    if (anyCoding && patientAsserted)
        return { tier: TierSelfReported, category: CategoryProblem, selfReported: true };
    if (!anyCoding && tell === 'PersonalHealthConsideration' && !clinicianRecorder)
        return { tier: TierProfile, category: CategorySDOH, selfReported: false };
    return { tier: TierClinician, category: CategoryProblem, selfReported: false }; // safety bias
}
const onsetOf = (raw) => raw.onsetDateTime || raw.onsetPeriod?.start || '';
const abatedOf = (raw) => raw.abatementDateTime || raw.abatementPeriod?.end || raw.abatementPeriod?.start || raw.abatementString || '';
function resolveState(raw, verif) {
    if (verif === 'refuted')
        return 'RuledOut';
    switch (conceptCode(raw.clinicalStatus)) {
        case 'active':
        case 'recurrence':
        case 'relapse': return 'Active';
        case 'remission': return 'Remission';
        case 'resolved':
        case 'inactive': return 'Resolved';
        default: return abatedOf(raw) !== '' ? 'Resolved' : 'Unknown';
    }
}
const opt = (value) => (value === '' ? undefined : value);
export function classifyConditions(resources) {
    const out = [];
    for (const res of resources) {
        const raw = res.raw;
        if (!raw || typeof raw !== 'object')
            continue;
        const verif = conceptCode(raw.verificationStatus);
        if (verif === 'entered-in-error')
            continue;
        const { tier, category, selfReported } = classifyOne(raw);
        const cc = {
            sourceResourceType: res.sourceResourceType,
            sourceResourceId: res.sourceResourceId,
            sourceId: res.sourceId,
            title: conceptText(raw.code) || 'Unknown condition',
            category, tier,
            state: resolveState(raw, verif),
            selfReported,
        };
        const fields = [
            ['clinicalStatus', conceptCode(raw.clinicalStatus)], ['verificationStatus', verif], ['onset', onsetOf(raw)],
            ['recorded', String(raw.recordedDate ?? '')], ['abated', abatedOf(raw)], ['note', noteText(raw.note)],
        ];
        for (const [k, v] of fields)
            if (opt(v) !== undefined)
                cc[k] = v;
        const codings = standardCodingsBy(raw.code, isStandardSystem);
        if (codings)
            cc.standardCodings = codings;
        out.push(cc);
    }
    return out;
}
function dedupeKey(c) {
    let snomed = '';
    let icd = '';
    for (const cd of c.standardCodings ?? []) {
        const sys = (cd.system ?? '').toLowerCase();
        if (sys.includes('snomed') && snomed === '')
            snomed = `snomed|${cd.code ?? ''}`;
        else if (sys.includes('icd') && icd === '')
            icd = `icd|${cd.code ?? ''}`;
    }
    return snomed || icd || `title|${c.title.trim().toLowerCase()}`;
}
function preferCondition(a, b) {
    const ar = a.recorded ?? '';
    const br = b.recorded ?? '';
    if (ar !== br)
        return ar > br; // ISO dates sort lexically; '' (unknown) loses
    return (a.standardCodings?.length ?? 0) > (b.standardCodings?.length ?? 0);
}
/** Classify, then collapse duplicates across sources — the better representative keeps the original slot. */
export function reconcileConditions(resources) {
    const index = new Map();
    const out = [];
    for (const c of classifyConditions(resources)) {
        const key = dedupeKey(c);
        const pos = index.get(key);
        if (pos !== undefined) {
            if (preferCondition(c, out[pos]))
                out[pos] = c;
            continue;
        }
        index.set(key, out.length);
        out.push(c);
    }
    return out;
}
//# sourceMappingURL=index.js.map