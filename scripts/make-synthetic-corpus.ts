/**
 * Emits a deterministic, fully synthetic FHIR corpus as NDJSON (yourphr#540) so the read-stack
 * harnesses can run in CI with no patient data anywhere near them. Everything here is invented:
 * names from placeholder words, dates chosen arbitrarily, codes from public terminologies.
 *
 * Deterministic on purpose — no randomness — so a CI failure reproduces locally byte for byte.
 *
 *   npx tsx scripts/make-synthetic-corpus.ts --out /tmp/corpus.ndjson
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const at = argv.indexOf('--out');
const out = resolve(at === -1 ? 'tmp-synthetic-corpus.ndjson' : (argv[at + 1] ?? 'tmp-synthetic-corpus.ndjson'));

/**
 * Optional shape, added for the demo baseline (yourphr#646): `--patients 1 --months 24`.
 *
 * The DEFAULTS ARE THE OLD BEHAVIOUR — two patients, six months — so every harness that reads this
 * corpus sees byte-for-byte what it saw before. The demo needs a fuller record than a test does: a
 * visitor landing on three conditions and nothing else cannot tell whether the product works.
 */
function option(name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(argv[i + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}
const monthCount = option('months', 6);
const patientCount = option('patients', 2);

/**
 * Month N as a real calendar date, counting back from a fixed start so a longer run reaches into
 * earlier years. The dates used to be built as `2024-0${month}`, which is correct for one digit and
 * silently produces `2024-012-15` for the twelfth — an invalid date nobody notices until a record
 * page sorts wrong.
 */
function monthly(index: number, day: number): string {
  // The LAST month is always June 2024, so a longer run reaches further back rather than forward
  // into invented future dates — and the six-month default lands on January..June 2024 exactly as
  // it did when these were string literals. Defaults byte-for-byte unchanged.
  const d = new Date(Date.UTC(2024, 5 - (monthCount - index), day));
  return d.toISOString().slice(0, 10);
}

const resources: Record<string, unknown>[] = [];

const patients = [
  { id: 'syn-patient-1', family: 'Testcase', given: 'Alpha', dob: '1970-01-01', gender: 'female' },
  { id: 'syn-patient-2', family: 'Testcase', given: 'Beta', dob: '1985-06-15', gender: 'male' },
];

for (const p of patients.slice(0, patientCount)) {
  resources.push({
    resourceType: 'Patient',
    id: p.id,
    name: [{ family: p.family, given: [p.given] }],
    birthDate: p.dob,
    gender: p.gender,
  });
}

resources.push({ resourceType: 'Practitioner', id: 'syn-prac-1', name: [{ family: 'Placeholder', given: ['Doc'] }] });
resources.push({ resourceType: 'Organization', id: 'syn-org-1', name: 'Synthetic General Hospital' });

const conditionCodes = [
  { code: '38341003', display: 'Hypertension' },
  { code: '44054006', display: 'Diabetes mellitus type 2' },
  { code: '195967001', display: 'Asthma' },
];
const loinc = [
  { code: '8867-4', display: 'Heart rate', value: 72, unit: '/min' },
  { code: '8480-6', display: 'Systolic blood pressure', value: 120, unit: 'mm[Hg]' },
  { code: '29463-7', display: 'Body weight', value: 70, unit: 'kg' },
];

let serial = 0;
for (const p of patients.slice(0, patientCount)) {
  const subject = { reference: `Patient/${p.id}` };

  conditionCodes.forEach((c, i) => {
    serial++;
    resources.push({
      resourceType: 'Condition',
      id: `syn-cond-${serial}`,
      subject,
      code: { coding: [{ system: 'http://snomed.info/sct', code: c.code, display: c.display }], text: c.display },
      clinicalStatus: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          code: i % 2 === 0 ? 'active' : 'resolved',
        }],
      },
      recordedDate: monthly(i + 1, 10),
    });
  });

  for (let month = 1; month <= monthCount; month++) {
    for (const l of loinc) {
      serial++;
      resources.push({
        resourceType: 'Observation',
        id: `syn-obs-${serial}`,
        status: 'final',
        subject,
        code: { coding: [{ system: 'http://loinc.org', code: l.code, display: l.display }], text: l.display },
        effectiveDateTime: `${monthly(month, 15)}T09:00:00Z`,
        valueQuantity: { value: l.value + serial % 7, unit: l.unit },
      });
    }
  }

  for (let e = 1; e <= Math.max(4, Math.floor(monthCount / 2)); e++) {
    serial++;
    resources.push({
      resourceType: 'Encounter',
      id: `syn-enc-${serial}`,
      status: 'finished',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
      subject,
      period: { start: `${monthly(e, 5)}T10:00:00Z`, end: `${monthly(e, 5)}T10:30:00Z` },
      serviceProvider: { reference: 'Organization/syn-org-1' },
    });
  }

  serial++;
  resources.push({
    resourceType: 'Immunization',
    id: `syn-imm-${serial}`,
    status: 'completed',
    patient: subject,
    vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '140', display: 'Influenza, seasonal' }] },
    occurrenceDateTime: '2023-10-01',
  });

  serial++;
  resources.push({
    resourceType: 'AllergyIntolerance',
    id: `syn-all-${serial}`,
    patient: subject,
    code: { coding: [{ system: 'http://snomed.info/sct', code: '91936005', display: 'Penicillin allergy' }] },
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
  });

  serial++;
  resources.push({
    resourceType: 'DocumentReference',
    id: `syn-doc-${serial}`,
    status: 'current',
    subject,
    type: { text: 'Discharge summary' },
    date: '2024-03-01T12:00:00Z',
    content: [{ attachment: { contentType: 'text/plain', title: 'synthetic-note.txt' } }],
  });
}

writeFileSync(out, resources.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`${resources.length} synthetic resources -> ${out}`);
