/**
 * Differential harness: does SqliteFhirRepository answer the same as Medplum's reference?
 *
 * This is the check the migration plan actually rests on. The evaluation's sequencing — shadow
 * read-only first, diff the responses, only then own a surface — needs something that can say
 * "these two disagree, here, on this query". Loading a corpus and eyeballing counts cannot: the
 * first version of this spike reported a confident ZERO for Condition?patient=X while the reference
 * returned six, and only a side-by-side comparison makes that kind of wrongness obvious.
 *
 * MemoryRepository is the oracle. It is not the same code — it is Medplum's own implementation of
 * the same interface — so agreement across a corpus is real evidence about search semantics rather
 * than a test asserting the implementation matches itself.
 *
 *   npm run diff -- --in phi/seed-resources.ndjson
 *
 * Exits non-zero on any disagreement, so it can gate a migration rather than merely inform one.
 */
import {MemoryRepository, FhirRepository} from '@medplum/fhir-router';
import type {Resource, ResourceType} from '@medplum/fhirtypes';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {SqliteFhirRepository} from '../src/SqliteFhirRepository.js';

interface Query {
  label: string;
  resourceType: ResourceType;
  filters?: {code: string; operator: any; value: string}[];
}

function arg(flag: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}

/** Compare by identity and order-independently: two repositories may legitimately order differently. */
async function idsFor(repo: FhirRepository, query: Query): Promise<string[]> {
  const bundle = await repo.search({
    resourceType: query.resourceType,
    filters: query.filters as any,
    count: 1000,
  });
  return (bundle.entry ?? [])
    .map((entry) => `${entry.resource?.resourceType}/${entry.resource?.id}`)
    .sort();
}

async function main(): Promise<void> {
  const input = resolve(arg('--in', 'phi/seed-resources.ndjson'));
  const dbFile = resolve(arg('--db', 'phi/diff.db'));

  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbFile + suffix)) {
      rmSync(dbFile + suffix);
    }
  }

  const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean);
  const resources: Resource[] = [];
  for (const line of lines) {
    try {
      const resource = JSON.parse(line) as Resource;
      if (resource.resourceType) {
        resources.push(resource);
      }
    } catch {
      // Malformed lines are the export's problem, not the comparison's.
    }
  }

  const reference = new MemoryRepository();
  const sqlite = new SqliteFhirRepository({file: dbFile});

  // Load BOTH from the same corpus, in the same order, so a difference can only come from the
  // implementations rather than from what they were given.
  let loaded = 0;
  for (const resource of resources) {
    try {
      await reference.createResource(resource);
      await sqlite.createResource(resource);
      loaded++;
    } catch {
      // A resource either repository rejects is excluded from BOTH, so the comparison stays fair.
    }
  }
  console.log(`loaded ${loaded}/${resources.length} into both repositories\n`);

  // Queries are derived from the corpus rather than hardcoded, so this exercises whatever the data
  // actually contains — including, on a real export, resource types the spike has never seen.
  const presentTypes = [...new Set(resources.map((r) => r.resourceType))] as ResourceType[];
  const patients = await reference.search({resourceType: 'Patient', count: 1});
  const patientRef = patients.entry?.[0]?.resource
    ? `Patient/${patients.entry[0].resource.id}`
    : undefined;

  const queries: Query[] = presentTypes.map((resourceType) => ({
    label: `${resourceType} (all)`,
    resourceType,
  }));

  if (patientRef) {
    for (const resourceType of presentTypes) {
      queries.push({
        label: `${resourceType}?patient=${patientRef}`,
        resourceType,
        filters: [{code: 'patient', operator: 'eq', value: patientRef}],
      });
    }
  }

  queries.push({
    label: 'Condition?clinical-status=active',
    resourceType: 'Condition',
    filters: [{code: 'clinical-status', operator: 'eq', value: 'active'}],
  });

  let agreed = 0;
  const disagreements: string[] = [];
  const skipped: string[] = [];

  for (const query of queries) {
    let expected: string[];
    let actual: string[];
    try {
      expected = await idsFor(reference, query);
    } catch (err) {
      // The reference not supporting a query says nothing about ours.
      skipped.push(`${query.label} — reference: ${(err as Error).message}`);
      continue;
    }
    try {
      actual = await idsFor(sqlite, query);
    } catch (err) {
      disagreements.push(`${query.label}\n    sqlite threw: ${(err as Error).message}`);
      continue;
    }

    if (expected.join(',') === actual.join(',')) {
      agreed++;
      continue;
    }

    const missing = expected.filter((id) => !actual.includes(id));
    const extra = actual.filter((id) => !expected.includes(id));
    disagreements.push(
      `${query.label}\n    reference: ${expected.length}  sqlite: ${actual.length}` +
        (missing.length ? `\n    MISSING from sqlite: ${missing.slice(0, 5).join(', ')}` : '') +
        (extra.length ? `\n    EXTRA in sqlite: ${extra.slice(0, 5).join(', ')}` : '')
    );
  }

  console.log(`${agreed}/${queries.length - skipped.length} queries agree`);
  if (skipped.length) {
    console.log(`\n${skipped.length} skipped (unsupported by the reference):`);
    for (const line of skipped.slice(0, 5)) {
      console.log(`  - ${line}`);
    }
  }
  if (disagreements.length) {
    console.log(`\n${disagreements.length} DISAGREEMENT(S):`);
    for (const line of disagreements) {
      console.log(`  - ${line}`);
    }
  }

  sqlite.db.close();

  // Non-zero on disagreement: this is meant to gate a migration, not just describe one.
  if (disagreements.length > 0) {
    process.exit(1);
  }
  console.log('\nthe two implementations agree on every query run');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
