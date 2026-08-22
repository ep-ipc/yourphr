/**
 * The record pages (yourphr#595): conditions reconciled, allergies and immunizations classified,
 * the recent list, favourites, and the typed query — each against a real repository with the
 * search index the query runs over. Ported decisions are checked as decisions, not as code.
 *
 *   npm run records
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Resource } from '@medplum/fhirtypes';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';
import { reconcileConditions, type InputResource } from '../src/conditions/index.js';
import { classifyAllergies } from '../src/allergies/index.js';
import { classifyImmunizations } from '../src/immunizations/index.js';
import { Engine } from '../src/framework/Engine.js';
import { ApiContext, ApiError } from '../src/framework/ApiContext.js';
import { RecordsManager, type AggregationRow } from '../src/app/managers/RecordsManager.js';
import { SqliteRecordsProvider } from '../src/app/providers/SqliteRecordsProvider.js';
import { FavoriteStore } from '../src/favorites/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const SNOMED = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const input = (raw: Record<string, unknown>, sourceId = 'source-1'): InputResource =>
  ({ sourceResourceType: String(raw['resourceType']), sourceResourceId: String(raw['id']), sourceId, raw });

async function main(): Promise<void> {
  // --- conditions: tier, category, state, dedupe ---
  const conditions = reconcileConditions([
    input({ resourceType: 'Condition', id: 'c1', code: { text: 'Hypertension', coding: [{ system: SNOMED, code: '38341003' }] },
      clinicalStatus: { coding: [{ code: 'active' }] }, verificationStatus: { coding: [{ code: 'confirmed' }] }, recordedDate: '2023-01-01',
      category: [{ coding: [{ code: 'problem-list-item' }] }] }),
    input({ resourceType: 'Condition', id: 'c2', code: { text: 'HTN', coding: [{ system: SNOMED, code: '38341003' }] },
      clinicalStatus: { coding: [{ code: 'active' }] }, recordedDate: '2024-06-01' }, 'source-2'),
    input({ resourceType: 'Condition', id: 'c3', code: { text: 'Gets headaches after screens', coding: [{ system: 'urn:local', code: 'x' }] },
      asserter: { reference: 'Patient/p' }, clinicalStatus: { coding: [{ code: 'active' }] } }),
    input({ resourceType: 'Condition', id: 'c4', code: { text: 'Lives alone' }, identifier: [{ value: 'urn:vendor:PersonalHealthConsideration,77' }] }),
    input({ resourceType: 'Condition', id: 'c5', code: { text: 'Old fracture' }, abatementDateTime: '2010-01-01' }),
    input({ resourceType: 'Condition', id: 'c6', code: { text: 'Mistake' }, verificationStatus: { coding: [{ code: 'entered-in-error' }] } }),
    input({ resourceType: 'Condition', id: 'c7', code: { text: 'Not pneumonia' }, verificationStatus: { coding: [{ code: 'refuted' }] } }),
    input({ resourceType: 'Condition', id: 'c8' }),
  ]);
  const byId = (id: string) => conditions.find((c) => c.sourceResourceId === id);
  check('the same SNOMED code across two sources collapses to ONE row, the more recently recorded one',
    conditions.filter((c) => c.standardCodings?.[0]?.code === '38341003').length === 1 && byId('c2') !== undefined && byId('c1') === undefined);
  check('a coded clinician problem is clinician tier / problem-list-item / Active',
    byId('c2')?.tier === 'clinician' && byId('c2')?.category === 'problem-list-item' && byId('c2')?.state === 'Active');
  check('a patient-asserted, non-standard-coded condition is self-reported', byId('c3')?.tier === 'self-reported' && byId('c3')?.selfReported === true);
  check('the vendor PersonalHealthConsideration tell with no coding is profile / sdoh', byId('c4')?.tier === 'profile' && byId('c4')?.category === 'sdoh');
  check('abated with no status reads Resolved; entered-in-error is omitted; refuted is RuledOut; nameless is "Unknown condition"',
    byId('c5')?.state === 'Resolved' && byId('c6') === undefined && byId('c7')?.state === 'RuledOut' && byId('c8')?.title === 'Unknown condition' && byId('c8')?.state === 'Unknown');
  check('provenance is ABSENT, not invented', conditions.every((c) => !('provenance' in c)));

  // --- allergies: state, verification, no-known, dedupe merge ---
  const allergies = classifyAllergies([
    input({ resourceType: 'AllergyIntolerance', id: 'a1', code: { text: 'Penicillin', coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '7980' }] },
      clinicalStatus: { coding: [{ code: 'active' }] }, verificationStatus: { coding: [{ code: 'confirmed' }] }, category: ['medication'],
      recordedDate: '2020-01-01', reaction: [{ manifestation: [{ text: 'Hives' }], severity: 'Moderate' }] }),
    input({ resourceType: 'AllergyIntolerance', id: 'a2', code: { text: 'PENICILLIN G', coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '7980' }] },
      clinicalStatus: { coding: [{ code: 'active' }] }, recordedDate: '2024-01-01', lastOccurrence: '2024-03-01', category: ['medication'],
      reaction: [{ manifestation: [{ text: 'Rash' }] }] }, 'source-2'),
    input({ resourceType: 'AllergyIntolerance', id: 'a3', code: { text: 'No known allergies', coding: [{ system: SNOMED, code: '716186003' }] } }),
    input({ resourceType: 'AllergyIntolerance', id: 'a4', code: { text: 'Peanut' }, asserter: { reference: 'RelatedPerson/mom' } }),
  ]);
  const pen = allergies.find((a) => a.standardCodings?.[0]?.code === '7980');
  check('the same RxNorm allergy across sources merges: 2 occurrences, earliest start, latest end, reactions unioned, newest record drives status',
    allergies.length === 3 && pen?.occurrences === 2 && pen.start === '2020-01-01' && pen.end === '2024-03-01' && pen.lastActivity === '2024-03-01'
      && pen.sourceResourceId === 'a2' && pen.reactions?.length === 2 && pen.verification === 'Unknown');
  check('a "no known allergy" negation is flagged noKnown; a RelatedPerson-asserted one is self-reported with Unknown state',
    allergies.find((a) => a.sourceResourceId === 'a3')?.noKnown === true && allergies.find((a) => a.sourceResourceId === 'a4')?.selfReported === true
      && allergies.find((a) => a.sourceResourceId === 'a4')?.state === 'Unknown');

  // --- immunizations: doses, state, source attribution ---
  const immunizations = classifyImmunizations([
    input({ resourceType: 'Immunization', id: 'i1', status: 'completed', vaccineCode: { text: 'Flu shot', coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '140' }] },
      occurrenceDateTime: '2022-10-01', primarySource: true }),
    input({ resourceType: 'Immunization', id: 'i2', status: 'completed', vaccineCode: { text: 'Influenza', coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '140' }] },
      occurrenceDateTime: '2023-10-01', primarySource: false, reportOrigin: { text: 'Patient' } }, 'source-2'),
    input({ resourceType: 'Immunization', id: 'i3', status: 'not-done', vaccineCode: { text: 'MMR' }, statusReason: { text: 'Patient declined' } }),
    input({ resourceType: 'Immunization', id: 'i4', status: 'entered-in-error', vaccineCode: { text: 'Oops' } }),
  ]);
  const flu = immunizations.find((i) => i.standardCodings?.[0]?.code === '140');
  check('the same CVX vaccine repeated merges: doses=2, the most recent administration is shown, its source attribution legible',
    immunizations.length === 2 && flu?.doses === 2 && flu.sourceResourceId === 'i2' && flu.occurrence === '2023-10-01' && flu.source === 'Reported' && flu.reportOrigin === 'Patient');
  check('not-done is NotDone with the stated reason; entered-in-error is omitted',
    immunizations.find((i) => i.sourceResourceId === 'i3')?.state === 'NotDone' && immunizations.find((i) => i.sourceResourceId === 'i3')?.statusReason === 'Patient declined'
      && !immunizations.some((i) => i.sourceResourceId === 'i4'));

  // --- the repository: query, recent, favourites ---
  const dir = mkdtempSync(join(tmpdir(), 'spike-records-'));
  const file = join(dir, 'records.db');
  const repo = new SqliteFhirRepository({ file, userId: 'alice', sourceId: 'source-1' });
  const other = new SqliteFhirRepository({ file, userId: 'bob', sourceId: 'source-9' });
  const obs = (id: string, code: string, display: string, date: string, system = LOINC): Resource =>
    ({ resourceType: 'Observation', id, status: 'final', code: { coding: [{ system, code, display }] }, effectiveDateTime: date } as Resource);
  await repo.createResource(obs('o1', '718-7', 'Hemoglobin', '2024-01-10'));
  await repo.createResource(obs('o2', '718-7', 'Hemoglobin', '2024-05-10'));
  await repo.createResource(obs('o3', '2345-7', 'Glucose', '2024-03-10'));
  await repo.createResource(obs('o4', 'BP', 'Blood pressure', '2024-09-10', 'urn:local'));
  await repo.createResource({ resourceType: 'DiagnosticReport', id: 'd1', status: 'final', code: { text: 'CBC' }, issued: '2024-05-11',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }] } as Resource);
  await repo.createResource({ resourceType: 'DiagnosticReport', id: 'd2', status: 'final', code: { text: 'Chest X-ray' }, issued: '2024-06-11',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'RAD' }] }] } as Resource);
  await repo.createResource({ resourceType: 'Condition', id: 'c1', code: { text: 'Sprain' }, recordedDate: '2024-07-01' } as Resource);
  await other.createResource(obs('o9', '718-7', 'Hemoglobin', '2025-01-01'));
  // The door (yourphr#609): the typed query and the recent list are Records-manager methods over the provider.
  const engine = new Engine();
  engine.register('records', new RecordsManager(engine, new SqliteRecordsProvider(file, undefined)));
  await engine.initialize();
  const records = engine.managers.records;
  const ctx = ApiContext.from({ username: 'alice', role: 'user' }, engine);

  // The labs page's first question: every LOINC-coded observation, grouped by code, newest first.
  const grouped = await records.query(ctx, { select: [], from: 'Observation', where: { code: `${LOINC}|,urn:oid:2.16.840.1.113883.6.1|` },
    aggregations: { order_by: { field: 'sort_date', fn: 'max' }, group_by: { field: 'code' } } }) as AggregationRow[];
  check('group_by code with max(sort_date): one label per system|code, value = latest date, newest first; system-only tokens match any code in the system; other users excluded',
    grouped.map((g) => `${g.label}=${g.value}`).join(';') === `${LOINC}|718-7=2024-05-10;${LOINC}|2345-7=2024-03-10`);
  // Its second: the observations behind those codes, by the labels it was given.
  const byCodes = await records.query(ctx, { select: [], from: 'Observation', where: { code: grouped.map((g) => g.label).join(',') } }) as Record<string, unknown>[];
  check('where code=a,b ORs the alternatives and returns resource_fhir rows, sort_date DESC',
    byCodes.map((r) => r['source_resource_id']).join(',') === 'o2,o3,o1' && byCodes.every((r) => r['source_id'] === 'source-1' && (r['resource_raw'] as Resource).resourceType === 'Observation'));
  // Its third: the last lab reports.
  const labs = await records.query(ctx, { select: ['*'], from: 'DiagnosticReport', where: { category: 'http://terminology.hl7.org/CodeSystem/v2-0074|LAB' }, limit: 10 }) as Record<string, unknown>[];
  check('a system|code token matches exactly that coding; limit honoured', labs.length === 1 && labs[0]!['source_resource_id'] === 'd1');
  const counted = await records.query(ctx, { from: 'Observation', aggregations: { count_by: { field: 'code' } } }) as AggregationRow[];
  check('count_by is group_by + count, most frequent first', counted[0]?.label === `${LOINC}|718-7` && counted[0].value === 2 && counted.length === 3);
  let refused: unknown;
  try { await records.query(ctx, { from: 'Observation; DROP TABLE resources' }); } catch (err) { refused = err; }
  check('a malformed resource type is refused with a 400, not interpolated', refused instanceof ApiError && refused.status === 400 && refused.message.includes('resource type'));

  const recent = await records.recent(ctx, 3);
  check('recent: newest across every type, Go\'s list-item shape, limited',
    recent.map((r) => `${r.source_resource_type}/${r.source_resource_id}@${r.date}`).join(',') === 'Observation/o4@2024-09-10,Condition/c1@2024-07-01,DiagnosticReport/d2@2024-06-11'
      && recent[0]?.title === 'Blood pressure' && recent[0].source_id === 'source-1');

  const app = new Database(join(dir, 'app.db'));
  const favorites = new FavoriteStore(app);
  favorites.add('alice', { source_id: 'source-1', resource_type: 'Practitioner', resource_id: 'dr-1' });
  favorites.add('alice', { source_id: 'source-1', resource_type: 'Practitioner', resource_id: 'dr-1' }); // twice: still one
  favorites.add('bob', { source_id: 'source-9', resource_type: 'Practitioner', resource_id: 'dr-2' });
  check('favourites are per user and idempotent',
    favorites.list('alice', 'Practitioner').map((f) => f.resource_id).join(',') === 'dr-1' && favorites.list('bob', 'Practitioner').length === 1);
  check('removing one reports whether it was there; Practitioner is the only kind accepted',
    favorites.remove('alice', { source_id: 'source-1', resource_type: 'Practitioner', resource_id: 'dr-1' }) === true
      && favorites.remove('alice', { source_id: 'source-1', resource_type: 'Practitioner', resource_id: 'dr-1' }) === false
      && FavoriteStore.supports('Practitioner') && !FavoriteStore.supports('Patient'));

  app.close();
  await engine.shutdown();
  repo.db.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`records harness failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
