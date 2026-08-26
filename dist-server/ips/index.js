/**
 * Order and grouping match Go's IPSSectionGroupsOrdered. vital_signs is deliberately unmapped for
 * now: the spike repository has no category-level Observation split, and double-listing every
 * Observation under two sections would misstate the record — recorded as not-yet rather than
 * guessed (yourphr#577).
 */
export const IPSSections = [
    { key: 'medication_summary', title: 'Medications', group: 'required', loinc: '10160-0', resourceTypes: ['MedicationRequest', 'MedicationStatement'] },
    { key: 'allergies_intolerances', title: 'Allergies', group: 'required', loinc: '48765-2', resourceTypes: ['AllergyIntolerance'] },
    { key: 'problem_list', title: 'Health problems', group: 'required', loinc: '11450-4', resourceTypes: ['Condition'] },
    { key: 'immunizations', title: 'Immunizations', group: 'recommended', loinc: '11369-6', resourceTypes: ['Immunization'] },
    { key: 'history_of_procedures', title: 'Procedures', group: 'recommended', loinc: '47519-4', resourceTypes: ['Procedure'] },
    { key: 'medical_devices', title: 'Medical devices', group: 'recommended', loinc: '46264-8', resourceTypes: ['Device', 'DeviceUseStatement'] },
    { key: 'diagnostic_results', title: 'Test results', group: 'recommended', loinc: '30954-2', resourceTypes: ['Observation', 'DiagnosticReport'] },
    { key: 'history_of_illness', title: 'Past illnesses', group: 'optional', loinc: '11348-0', resourceTypes: ['Encounter'] },
    { key: 'social_history', title: 'Social history', group: 'optional', loinc: '29762-2', resourceTypes: [] },
    { key: 'plan_of_care', title: 'Plan of care', group: 'optional', loinc: '18776-5', resourceTypes: ['CarePlan'] },
];
const EMPTY_STATEMENTS = {
    medication_summary: 'No medications are recorded in this summary.',
    allergies_intolerances: 'No known allergies are recorded in this summary.',
    problem_list: 'No health problems are recorded in this summary.',
};
function escapeXhtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * The one patient-legible line for a resource: its own stated display text, then its own stated
 * date. Nothing derived, nothing guessed (yourphr#262 + the no-guessing principle).
 */
export function legibleLine(resource) {
    const r = resource;
    const text = r['code']?.text ?? r['code']?.coding?.[0]?.display ??
        r['vaccineCode']?.text ?? r['vaccineCode']?.coding?.[0]?.display ??
        r['medicationCodeableConcept']?.text ?? r['medicationCodeableConcept']?.coding?.[0]?.display ??
        r['type']?.text ??
        `Unnamed ${resource.resourceType}`;
    const date = r['effectiveDateTime'] ?? r['occurrenceDateTime'] ?? r['recordedDate'] ?? r['performedDateTime'] ??
        r['period']?.start ?? r['date'] ?? r['authoredOn'];
    return date ? `${text} — ${String(date).slice(0, 10)}` : text;
}
function narrative(title, lines) {
    const items = lines.map((l) => `<li>${escapeXhtml(l)}</li>`).join('');
    return `<div xmlns="http://www.w3.org/1999/xhtml"><h2>${escapeXhtml(title)}</h2><ul>${items}</ul></div>`;
}
function emptyNarrative(title, statement) {
    return `<div xmlns="http://www.w3.org/1999/xhtml"><h2>${escapeXhtml(title)}</h2><p>${escapeXhtml(statement)}</p></div>`;
}
export async function buildIps(repo, now) {
    const patientBundle = await repo.search({ resourceType: 'Patient', count: 1 });
    const patient = patientBundle.entry?.[0]?.resource;
    const sections = [];
    const included = [];
    const presentKeys = [];
    for (const spec of IPSSections) {
        const resources = [];
        for (const type of spec.resourceTypes) {
            const found = await repo.search({ resourceType: type, count: 1000, total: 'accurate' });
            for (const entry of found.entry ?? []) {
                resources.push(entry.resource);
            }
        }
        // Deterministic order: by legible line, then id — never insertion order.
        resources.sort((a, b) => (legibleLine(a) + a.id).localeCompare(legibleLine(b) + b.id));
        if (resources.length === 0) {
            if (spec.group !== 'required') {
                continue; // an empty recommended/optional section is omitted, not fabricated
            }
            sections.push({
                title: spec.title,
                code: { coding: [{ system: 'http://loinc.org', code: spec.loinc }] },
                text: { status: 'generated', div: emptyNarrative(spec.title, EMPTY_STATEMENTS[spec.key] ?? 'Nothing recorded.') },
                emptyReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason', code: 'unavailable' }] },
            });
            presentKeys.push(spec.key);
            continue;
        }
        sections.push({
            title: spec.title,
            code: { coding: [{ system: 'http://loinc.org', code: spec.loinc }] },
            text: { status: 'generated', div: narrative(spec.title, resources.map(legibleLine)) },
            entry: resources.map((r) => ({ reference: `${r.resourceType}/${r.id}` })),
        });
        included.push(...resources);
        presentKeys.push(spec.key);
    }
    const composition = {
        resourceType: 'Composition',
        id: 'ips-composition',
        status: 'final',
        type: { coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient summary Document' }] },
        date: now.toISOString(),
        title: 'International Patient Summary',
        author: [{ display: 'YourPHR (self-hosted personal health record)' }],
        subject: patient ? { reference: `Patient/${patient.id}` } : undefined,
        section: sections,
    };
    const entries = [{ resource: composition }];
    if (patient) {
        entries.push({ resource: patient });
    }
    const seen = new Set();
    for (const resource of included) {
        const key = `${resource.resourceType}/${resource.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            entries.push({ resource });
        }
    }
    const bundle = {
        resourceType: 'Bundle',
        type: 'document',
        timestamp: now.toISOString(),
        entry: entries,
    };
    return { bundle, sections: presentKeys };
}
//# sourceMappingURL=index.js.map