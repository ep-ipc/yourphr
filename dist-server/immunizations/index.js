/**
 * Immunizations, classified (yourphr#595) — ported decision-for-decision from the Go
 * `immunization` package. Per record: a legible state (given / not given / unknown), who the
 * information came from (primarySource, never assumed), the dose details the record states. Then
 * the same vaccine repeated across records collapses on a standard code (CVX, NDC, SNOMED; else
 * the title): the most recent administration drives the displayed date and status, `doses` counts
 * the members (#289). Provenance is absent (not ported), never invented.
 */
import { conceptText, noteText, standardCodingsBy } from '../conditions/index.js';
const isStandardSystem = (system) => {
    const s = system.toLowerCase();
    return s.includes('cvx') || s.includes('ndc') || s.includes('snomed');
};
const firstNonEmpty = (...vals) => vals.find((v) => v.trim() !== '') ?? '';
function stateLabel(status) {
    switch (status.toLowerCase()) {
        case 'completed': return 'Completed';
        case 'not-done': return 'NotDone';
        default: return 'Unknown';
    }
}
function sourceAttribution(primarySource) {
    if (typeof primarySource !== 'boolean')
        return 'Unknown';
    return primarySource ? 'Recorded by provider' : 'Reported';
}
function classifyOne(res) {
    const raw = res.raw;
    if (!raw || typeof raw !== 'object')
        return undefined;
    const status = String(raw.status ?? '');
    if (status.toLowerCase() === 'entered-in-error')
        return undefined;
    const occurrence = String(raw.occurrenceDateTime || raw.occurrenceString || '');
    const recorded = String(raw.recorded ?? '');
    const ci = {
        sourceResourceType: res.sourceResourceType,
        sourceResourceId: res.sourceResourceId,
        sourceId: res.sourceId,
        title: conceptText(raw.vaccineCode) || 'Unknown vaccine',
        state: stateLabel(status),
        source: sourceAttribution(raw.primarySource),
        doses: 1,
    };
    const set = (k, v) => { if (v !== '')
        ci[k] = v; };
    set('reportOrigin', raw.primarySource === false ? conceptText(raw.reportOrigin) : '');
    set('status', status);
    set('statusReason', conceptText(raw.statusReason));
    set('occurrence', occurrence);
    set('recorded', recorded);
    set('lastActivity', firstNonEmpty(occurrence, recorded));
    set('manufacturer', String(raw.manufacturer?.display ?? ''));
    set('lotNumber', String(raw.lotNumber ?? ''));
    set('expirationDate', String(raw.expirationDate ?? ''));
    set('note', noteText(raw.note));
    const codings = standardCodingsBy(raw.vaccineCode, isStandardSystem);
    if (codings)
        ci.standardCodings = codings;
    return ci;
}
function dedupKey(c) {
    for (const cd of c.standardCodings ?? []) {
        if (cd.code)
            return `code:${(cd.system ?? '').toLowerCase()}|${cd.code.toLowerCase()}`;
    }
    return `title:${c.title.trim().toLowerCase()}`;
}
export function classifyImmunizations(resources) {
    const order = [];
    const groups = new Map();
    for (const res of resources) {
        const c = classifyOne(res);
        if (!c)
            continue;
        const k = dedupKey(c);
        if (!groups.has(k)) {
            order.push(k);
            groups.set(k, []);
        }
        groups.get(k).push(c);
    }
    return order.map((k) => {
        const g = groups.get(k);
        let rep = g[0];
        for (const c of g.slice(1))
            if ((c.lastActivity ?? '') > (rep.lastActivity ?? ''))
                rep = c;
        return { ...rep, doses: g.length };
    });
}
//# sourceMappingURL=index.js.map