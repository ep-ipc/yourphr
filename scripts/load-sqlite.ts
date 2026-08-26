/**
 * The actual spike: load a corpus through SqliteFhirRepository and see whether generic indexing
 * answers real searches.
 *
 * Success criteria, from the README, judged here rather than by feel:
 *   1. the same load the MemoryRepository smoke test does, but persisted to SQLite
 *   2. one clinically meaningful search — by patient, by clinical status — with no per-resource-type
 *      hand-written columns anywhere
 *
 *   npm run load -- --in phi/seed-resources.ndjson --db phi/spike.db [--key <sqlcipher key>]
 */
import type { Patient, Resource, ResourceType } from '@medplum/fhirtypes';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';

function arg(flag: string, fallback?: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
}

async function main(): Promise<void> {
  const input = resolve(arg('--in', 'phi/seed-resources.ndjson') as string);
  const dbFile = resolve(arg('--db', 'phi/spike.db') as string);
  const key = arg('--key') ?? process.env.YOURPHR_DB_KEY;

  // Always start clean: a half-loaded database would make the collision count meaningless.
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbFile + suffix)) {
      rmSync(dbFile + suffix);
    }
  }

  const repo = new SqliteFhirRepository({ file: dbFile, key });
  const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean);

  const counts: Record<string, number> = {};
  const rejected: { line: number; reason: string }[] = [];
  const started = process.hrtime.bigint();

  for (const [index, line] of lines.entries()) {
    let resource: Resource;
    try {
      resource = JSON.parse(line) as Resource;
    } catch (err) {
      rejected.push({ line: index + 1, reason: `unparseable JSON: ${(err as Error).message}` });
      continue;
    }
    try {
      await repo.createResource(resource);
      counts[resource.resourceType] = (counts[resource.resourceType] ?? 0) + 1;
    } catch (err) {
      rejected.push({ line: index + 1, reason: `${resource.resourceType}: ${(err as Error).message}` });
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const loaded = lines.length - rejected.length;

  console.log(`loaded ${loaded}/${lines.length} resources in ${elapsedMs.toFixed(0)}ms -> ${dbFile}`);
  console.log(`${repo.stats.indexRows} index rows written from FHIR's own SearchParameter definitions`);
  console.log(`${repo.stats.collisions} id collision(s)\n`);

  for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(7)}  ${type}`);
  }

  if (rejected.length > 0) {
    console.log(`\n${rejected.length} rejected — first 10:`);
    for (const r of rejected.slice(0, 10)) {
      console.log(`  line ${r.line}: ${r.reason}`);
    }
  }

  const failed = Object.entries(repo.stats.failedExpressions);
  if (failed.length > 0) {
    console.log(`\n${failed.length} SearchParameter expression(s) failed to evaluate — first 5:`);
    for (const [code, reason] of failed.slice(0, 5)) {
      console.log(`  ${code}: ${reason}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Criterion 2: clinically meaningful searches, derived from whatever is actually in the corpus
  // ------------------------------------------------------------------------------------------
  console.log('\nsearches:');

  const patients = await repo.search<Patient>({ resourceType: 'Patient', count: 1 });
  const patient = patients.entry?.[0]?.resource;

  if (patient) {
    const patientRef = `Patient/${patient.id}`;
    for (const type of ['Condition', 'Observation', 'Immunization', 'Encounter'] as ResourceType[]) {
      if (!counts[type]) {
        continue;
      }
      const bundle = await repo.search({
        resourceType: type,
        filters: [{ code: 'patient', operator: 'eq', value: patientRef }],
        count: 3,
      });
      console.log(`  ${type}?patient=${patientRef} -> ${bundle.total} match(es)`);
    }

    const active = await repo.search({
      resourceType: 'Condition',
      filters: [{ code: 'clinical-status', operator: 'eq', value: 'active' }],
      count: 5,
    });
    console.log(`  Condition?clinical-status=active -> ${active.total} match(es)`);

    const missingOnset = await repo.search({
      resourceType: 'Condition',
      filters: [{ code: 'onset-date', operator: 'missing', value: 'true' }],
      count: 5,
    });
    console.log(`  Condition?onset-date:missing=true -> ${missingOnset.total} match(es)`);
  } else {
    console.log('  (no Patient in the corpus — skipped the by-patient searches)');
  }

  // Plain per-type counts, comparable with the MemoryRepository smoke run.
  for (const type of Object.keys(counts).slice(0, 3)) {
    const bundle = await repo.search({ resourceType: type as ResourceType, count: 3 });
    console.log(`  ${type}?_count=3 -> ${bundle.entry?.length ?? 0} entries (total ${bundle.total})`);
  }

  repo.db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
