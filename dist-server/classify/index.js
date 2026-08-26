function conceptText(cc) {
    if (!cc)
        return '';
    if (typeof cc['text'] === 'string' && cc['text'] !== '')
        return cc['text'];
    for (const coding of cc['coding'] ?? []) {
        if (typeof coding?.display === 'string' && coding.display !== '')
            return coding.display;
    }
    return '';
}
function datePart(value) {
    return typeof value === 'string' && value !== '' ? value.slice(0, 10) : '';
}
/** The Go legibleClass v3-ActCode map, verbatim. Unknown (vendor-local) codes return ''. */
export function legibleClass(code) {
    switch ((code ?? '').toUpperCase()) {
        case 'AMB': return 'Office visit';
        case 'IMP':
        case 'ACUTE':
        case 'NONAC': return 'Inpatient';
        case 'EMER': return 'Emergency';
        case 'VR': return 'Telehealth';
        case 'HH': return 'Home health';
        case 'OBSENC': return 'Observation';
        case 'SS': return 'Short stay';
        case 'PRENC': return 'Pre-admission';
        case 'FLD': return 'Field';
        default: return '';
    }
}
function stateWord(status) {
    switch ((status ?? '').toLowerCase()) {
        case 'active': return 'Active';
        case 'resolved':
        case 'inactive': return 'Resolved';
        case 'remission': return 'In remission';
        case 'completed':
        case 'finished': return 'Completed';
        case 'in-progress': return 'In progress';
        case 'planned': return 'Planned';
        case 'cancelled':
        case 'not-done': return 'Did not happen';
        case 'final': return 'Final';
        case 'preliminary': return 'Preliminary';
        default: return status ? status.charAt(0).toUpperCase() + status.slice(1) : '';
    }
}
function encounterTitle(r) {
    for (const t of r['type'] ?? []) {
        const text = conceptText(t);
        if (text !== '')
            return text;
    }
    const service = conceptText(r['serviceType']);
    if (service !== '')
        return service;
    if (r['class']?.display)
        return r['class'].display;
    return 'Encounter';
}
function encounterCategory(r) {
    if (!r['class'])
        return ''; // the record states no class — no guessing
    const known = legibleClass(r['class'].code);
    if (known !== '')
        return known;
    const title = encounterTitle(r);
    if (title !== '' && title !== 'Encounter')
        return title; // human text beats a cryptic local display
    return r['class'].display ?? '';
}
/** Clinical status for Condition/AllergyIntolerance lives in a nested CodeableConcept. */
function clinicalStatusWord(r) {
    return stateWord(r['clinicalStatus']?.coding?.[0]?.code ?? '');
}
export function classify(resource) {
    const r = resource;
    const status = (r['status'] ?? '').toLowerCase();
    if (status === 'entered-in-error') {
        return undefined; // retracted by its own source — not part of the patient's story
    }
    const base = { resourceType: resource.resourceType, id: resource.id ?? '', title: '', state: '', category: '', date: '' };
    switch (resource.resourceType) {
        case 'Condition':
            return {
                ...base,
                title: conceptText(r['code']) || 'Unnamed Condition',
                state: clinicalStatusWord(r),
                category: conceptText(r['category']?.[0]),
                date: datePart(r['recordedDate'] ?? r['onsetDateTime']),
            };
        case 'AllergyIntolerance':
            return {
                ...base,
                title: conceptText(r['code']) || 'Unnamed Allergy',
                state: clinicalStatusWord(r),
                category: Array.isArray(r['category']) && typeof r['category'][0] === 'string' ? r['category'][0] : '',
                date: datePart(r['recordedDate'] ?? r['onsetDateTime']),
            };
        case 'Immunization':
            return {
                ...base,
                title: conceptText(r['vaccineCode']) || 'Unnamed Immunization',
                state: status === 'completed' ? 'Given' : stateWord(status),
                category: '',
                date: datePart(r['occurrenceDateTime']),
            };
        case 'Procedure':
            return {
                ...base,
                title: conceptText(r['code']) || 'Unnamed Procedure',
                state: stateWord(status),
                category: conceptText(r['category']),
                date: datePart(r['performedDateTime'] ?? r['performedPeriod']?.start),
            };
        case 'DiagnosticReport':
            return {
                ...base,
                title: conceptText(r['code']) || 'Unnamed Report',
                state: stateWord(status),
                category: conceptText(r['category']?.[0]),
                date: datePart(r['effectiveDateTime'] ?? r['issued']),
            };
        case 'Encounter':
            return {
                ...base,
                title: encounterTitle(r),
                state: stateWord(status),
                category: encounterCategory(r),
                date: datePart(r['period']?.start),
            };
        default:
            return undefined; // an unbacked type is honestly unclassified, not vaguely labeled
    }
}
//# sourceMappingURL=index.js.map