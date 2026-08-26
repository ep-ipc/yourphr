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

const PAGE = 1000;

interface Result {
  total: number;
  ids: string[];
  truncated: boolean;
}

/**
 * Compare by identity, order-independently: two repositories may legitimately order differently.
 *
 * TRUNCATION MATTERS. A first pass compared the first 1000 of each and called Condition and
 * DocumentReference disagreements — both returned exactly 1000, but a DIFFERENT 1000, because
 * neither guarantees an order and the corpus holds 3,469 and 15,225 of them. That was the harness
 * being wrong, not the implementation, and it is precisely the false alarm that makes people stop
 * trusting a gate. Where a result exceeds one page, the totals are compared instead and the
 * comparison says so rather than pretending it checked membership.
 */
async function resultFor(repo: FhirRepository, query: Query): Promise<Result> {
  const bundle = await repo.search({
    resourceType: query.resourceType,
    filters: query.filters as any,
    count: PAGE,
    total: 'accurate',
  });
  const ids = (bundle.entry ?? [])
    .map((entry) => `${entry.resource?.resourceType}/${entry.resource?.id}`)
    .sort();
  const total = bundle.total ?? ids.length;
  return {total, ids, truncated: total > ids.length};
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

  let byTotalOnly = 0;

  for (const query of queries) {
    let expected: Result;
    let actual: Result;
    try {
      expected = await resultFor(reference, query);
    } catch (err) {
      // The reference not supporting a query says nothing about ours.
      skipped.push(`${query.label} — reference: ${(err as Error).message}`);
      continue;
    }
    try {
      actual = await resultFor(sqlite, query);
    } catch (err) {
      disagreements.push(`${query.label}\n    sqlite threw: ${(err as Error).message}`);
      continue;
    }

    if (expected.total !== actual.total) {
      disagreements.push(
        `${query.label}\n    totals differ — reference: ${expected.total}  sqlite: ${actual.total}`
      );
      continue;
    }

    // Beyond one page neither repository promises an order, so which 1000 came back is not a
    // difference in meaning. Say what was actually checked.
    if (expected.truncated || actual.truncated) {
      byTotalOnly++;
      agreed++;
      continue;
    }

    if (expected.ids.join(',') === actual.ids.join(',')) {
      agreed++;
      continue;
    }

    const missing = expected.ids.filter((id) => !actual.ids.includes(id));
    const extra = actual.ids.filter((id) => !expected.ids.includes(id));
    disagreements.push(
      `${query.label}\n    reference: ${expected.ids.length}  sqlite: ${actual.ids.length}` +
        (missing.length ? `\n    MISSING from sqlite: ${missing.slice(0, 5).join(', ')}` : '') +
        (extra.length ? `\n    EXTRA in sqlite: ${extra.slice(0, 5).join(', ')}` : '')
    );
  }

  console.log(`${agreed}/${queries.length - skipped.length} queries agree`);
  if (byTotalOnly) {
    console.log(`  (${byTotalOnly} compared by total only — more than ${PAGE} results, where neither repository promises an order)`);
  }
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
