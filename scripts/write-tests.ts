/**
 * Write-path testing against REAL records.
 *
 * Every number this spike has produced so far is read-path: load a corpus, query it back. That is
 * half the story, and the easier half. A store that answers correctly but corrupts on the second
 * import, or leaves stale index rows after an update, is worse than useless for a PHR — records
 * arrive repeatedly, from providers that resend the same resource with small changes.
 *
 *   npm run writes -- --in phi/account.ndjson
 *
 * Exits non-zero on failure. Each check states what would be WRONG in the product if it failed,
 * because "assert equal" tells a later reader nothing about why anybody cared.
 */
import type {Resource, ResourceType} from '@medplum/fhirtypes';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {SqliteFhirRepository} from '../src/SqliteFhirRepository.js';

function arg(flag: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}

const results: {name: string; ok: boolean; detail: string}[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({name, ok, detail});
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const input = resolve(arg('--in', 'phi/jwilleke.ndjson'));
  const dbFile = resolve(arg('--db', 'phi/write-tests.db'));

  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbFile + suffix)) {
      rmSync(dbFile + suffix);
    }
  }

  const resources = readFileSync(input, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Resource)
    .filter((resource) => resource.resourceType);

  const repo = new SqliteFhirRepository({file: dbFile});

  console.log(`\nfirst import — ${resources.length} real resources\n`);
  const started = Date.now();
  let created = 0;
  for (const resource of resources) {
    try {
      await repo.createResource(resource);
      created++;
    } catch {
      // Counted by repo.stats.collisions.
    }
  }
  console.log(`  ${created} created in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
    `${repo.stats.collisions} collisions, ${repo.stats.indexRows} index rows\n`);

  const countOf = async (resourceType: string): Promise<number> =>
    (await repo.search({resourceType: resourceType as ResourceType, count: 1, total: 'accurate'})).total ?? 0;

  const sampleType = 'Condition';
  const baseline = await countOf(sampleType);

  // ---------------------------------------------------------------------------------------------
  console.log('re-import — the same records arriving a second time\n');

  // A provider resync sends the whole set again. If a second import doubled the record count, a
  // patient would see every condition twice (#252 in the product repo).
  let secondCollisions = 0;
  for (const resource of resources) {
    try {
      await repo.createResource(resource);
    } catch {
      secondCollisions++;
    }
  }
  check(
    're-importing the same corpus creates no duplicates',
    (await countOf(sampleType)) === baseline,
    `${sampleType} still ${baseline}`
  );
  check(
    'every re-imported resource is recognised as already present',
    secondCollisions === created,
    `${secondCollisions}/${created} rejected as duplicates`
  );

  // ---------------------------------------------------------------------------------------------
  console.log('\nupdate — a provider resends a resource with a change\n');

  const conditions = await repo.search({resourceType: 'Condition', count: 1});
  const original = conditions.entry?.[0]?.resource as any;
  if (!original) {
    console.log('  (no Condition in this corpus — update checks skipped)');
  } else {
    const originalStatus = original.clinicalStatus?.coding?.[0]?.code;
    const updated = {
      ...original,
      clinicalStatus: {coding: [{system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'resolved'}]},
    };
    await repo.updateResource(updated);

    const readBack = (await repo.readResource('Condition', original.id)) as any;
    check(
      'an update is visible on read',
      readBack?.clinicalStatus?.coding?.[0]?.code === 'resolved',
      `was ${originalStatus ?? 'unset'}, now ${readBack?.clinicalStatus?.coding?.[0]?.code}`
    );

    check(
      'an update does not create a second copy',
      (await countOf('Condition')) === baseline,
      `Condition still ${baseline}`
    );

    // THE ONE THAT MATTERS. If the old index rows survive an update, a resolved condition keeps
    // answering a search for active ones — the record looks right when opened and wrong in every
    // list, which is the hardest kind of wrong to notice.
    const stillActive = await repo.search({
      resourceType: 'Condition',
      filters: [{code: 'clinical-status', operator: 'eq' as any, value: originalStatus ?? 'active'}],
      count: 5000,
      total: 'accurate',
    });
    const stale = (stillActive.entry ?? []).some((entry) => entry.resource?.id === original.id);
    check('the OLD indexed value no longer matches after an update', !stale,
      stale ? 'stale index row survived' : 'reindexed cleanly');

    const nowResolved = await repo.search({
      resourceType: 'Condition',
      filters: [{code: 'clinical-status', operator: 'eq' as any, value: 'resolved'}],
      count: 5000,
      total: 'accurate',
    });
    check('the NEW indexed value matches after an update',
      (nowResolved.entry ?? []).some((entry) => entry.resource?.id === original.id));
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\ndelete\n');

  const toDelete = (await repo.search({resourceType: 'Observation', count: 1})).entry?.[0]?.resource;
  if (!toDelete) {
    console.log('  (no Observation in this corpus — delete checks skipped)');
  } else {
    const before = await countOf('Observation');
    await repo.deleteResource('Observation', toDelete.id!);

    check('a deleted resource is gone from search', (await countOf('Observation')) === before - 1,
      `${before} -> ${await countOf('Observation')}`);

    let readable = true;
    try {
      await repo.readResource('Observation', toDelete.id!);
    } catch {
      readable = false;
    }
    check('a deleted resource cannot be read back', !readable);

    // A delete that leaves its index rows behind makes the resource keep matching searches while
    // being unreadable — a row a patient can see in a list and cannot open.
    const indexRows = repo.db
      .prepare('SELECT COUNT(*) AS n FROM search_index WHERE resource_type = ? AND resource_id = ?')
      .get('Observation', toDelete.id) as {n: number};
    check('a delete removes the index rows too', indexRows.n === 0, `${indexRows.n} rows left`);
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\nreindex — rebuilding every index row from stored content\n');

  const indexedBefore = (repo.db.prepare('SELECT COUNT(*) AS n FROM search_index').get() as {n: number}).n;
  repo.reindexAll();
  const indexedAfter = (repo.db.prepare('SELECT COUNT(*) AS n FROM search_index').get() as {n: number}).n;

  // Only possible because the resource is stored whole. It is what makes an indexing bug a
  // non-event: fix the code, rebuild, rather than re-import from providers.
  check('a full reindex reproduces the same index', indexedAfter === indexedBefore,
    `${indexedBefore} -> ${indexedAfter}`);

  const afterReindex = await countOf('Condition');
  check('search still answers correctly after a reindex', afterReindex === baseline,
    `Condition ${afterReindex}`);

  repo.db.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
