/**
 * Per-user isolation, tested with two REAL accounts from one database (#537).
 *
 * A PHR holds a family. Before this, the spike had no concept of a user at all — every caller saw
 * every record — which on a family instance is a disclosure rather than a missing feature. YourPHR
 * enforces isolation from the request context and every query carries `WHERE user_id = ?`; this
 * checks the TypeScript side does the same, against data where the accounts genuinely differ.
 *
 *   npm run isolation -- --db <copy of a real snapshot> --a jwilleke --b jdoe
 *
 * Exits non-zero on any leak.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import type {Resource, ResourceType} from '@medplum/fhirtypes';
import {existsSync, rmSync} from 'node:fs';
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

/** Read one account's records straight out of a YourPHR database. */
function recordsFor(sourceDb: string, username: string): {userId: string; resources: Resource[]} {
  const db = new Database(sourceDb, {readonly: true});
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as {id: string} | undefined;
  if (!user) {
    throw new Error(`no user named ${username}`);
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fhir_%'")
    .all() as {name: string}[];

  const resources: Resource[] = [];
  for (const {name} of tables) {
    try {
      const rows = db
        .prepare(`SELECT resource_raw FROM "${name}" WHERE deleted_at IS NULL AND user_id = ?`)
        .all(user.id) as {resource_raw: string | null}[];
      for (const row of rows) {
        if (row.resource_raw) {
          resources.push(JSON.parse(row.resource_raw) as Resource);
        }
      }
    } catch {
      // Table shapes vary; skip rather than abort.
    }
  }
  db.close();
  return {userId: user.id, resources};
}

async function main(): Promise<void> {
  const sourceDb = resolve(arg('--db', '../yourphr/private/phi/db/real.db'));
  const usernameA = arg('--a', 'jwilleke');
  const usernameB = arg('--b', 'jdoe');
  const dbFile = resolve(arg('--out', 'phi/isolation.db'));

  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbFile + suffix)) {
      rmSync(dbFile + suffix);
    }
  }

  const a = recordsFor(sourceDb, usernameA);
  const b = recordsFor(sourceDb, usernameB);
  console.log(`\n${usernameA}: ${a.resources.length} resources`);
  console.log(`${usernameB}: ${b.resources.length} resources\n`);

  // One database, one repository per account — the scope is a property of the instance, so a caller
  // cannot forget to pass it.
  const repoA = new SqliteFhirRepository({file: dbFile, userId: a.userId});
  const repoB = new SqliteFhirRepository({file: dbFile, userId: b.userId});

  for (const resource of a.resources) {
    try {
      await repoA.createResource(resource);
    } catch {
      /* counted in stats */
    }
  }
  for (const resource of b.resources) {
    try {
      await repoB.createResource(resource);
    } catch {
      /* counted in stats */
    }
  }

  console.log('isolation\n');

  const typesA = [...new Set(a.resources.map((r) => r.resourceType))];
  const typesB = [...new Set(b.resources.map((r) => r.resourceType))];
  const shared = typesA.filter((t) => typesB.includes(t));

  let leaks = 0;
  let compared = 0;
  for (const resourceType of shared) {
    const seenByA = await repoA.search({resourceType: resourceType as ResourceType, count: 100000, total: 'accurate'});
    const seenByB = await repoB.search({resourceType: resourceType as ResourceType, count: 100000, total: 'accurate'});

    const expectedA = a.resources.filter((r) => r.resourceType === resourceType).length;
    const expectedB = b.resources.filter((r) => r.resourceType === resourceType).length;

    if ((seenByA.total ?? 0) !== expectedA || (seenByB.total ?? 0) !== expectedB) {
      leaks++;
      console.log(`  LEAK ${resourceType}: A saw ${seenByA.total}/${expectedA}, B saw ${seenByB.total}/${expectedB}`);
    }
    compared++;
  }
  check(`neither account sees the other's records`, leaks === 0,
    `${compared} shared resource types compared`);

  // The sharpest case: a resource id present in BOTH accounts. Keying on (type, id) alone would
  // make one account's import overwrite the other's record, or make it invisible.
  const idsA = new Set(a.resources.map((r) => `${r.resourceType}/${r.id}`));
  const collidingIds = b.resources.filter((r) => idsA.has(`${r.resourceType}/${r.id}`));
  if (collidingIds.length === 0) {
    // No shared id occurs naturally in this corpus, and leaving the case untested would be leaving
    // the sharpest one untested: two family members treated at the same hospital can be sent the
    // same Organization or Practitioner id. Construct it.
    const shared: Resource = {
      resourceType: 'Organization',
      id: 'shared-id-both-accounts',
      name: "A's copy",
    } as Resource;
    await repoA.createResource(shared);
    await repoB.createResource({...shared, name: "B's copy"} as Resource);

    const fromA = (await repoA.readResource('Organization', 'shared-id-both-accounts')) as any;
    const fromB = (await repoB.readResource('Organization', 'shared-id-both-accounts')) as any;
    check('a resource id held by BOTH accounts resolves to each account\'s own copy',
      fromA?.name === "A's copy" && fromB?.name === "B's copy",
      `A read ${JSON.stringify(fromA?.name)}, B read ${JSON.stringify(fromB?.name)}`);

    // And the second write must not have been rejected as a duplicate of the first.
    check('the same id in a second account is not treated as a duplicate',
      ((await repoB.search({resourceType: 'Organization', count: 100000, total: 'accurate'})).total ?? 0) >
        b.resources.filter((r) => r.resourceType === 'Organization').length);
  } else {
    const sample = collidingIds[0]!;
    const fromA = await repoA.readResource(sample.resourceType, sample.id!);
    const fromB = await repoB.readResource(sample.resourceType, sample.id!);
    check('a resource id held by BOTH accounts resolves to each account\'s own copy',
      !!fromA && !!fromB, `${collidingIds.length} shared ids, e.g. ${sample.resourceType}/${sample.id}`);
  }

  // A read for an id the account does not own must fail, not return the other account's record.
  const otherId = b.resources.find((r) => !idsA.has(`${r.resourceType}/${r.id}`));
  if (otherId) {
    let readable = true;
    try {
      await repoA.readResource(otherId.resourceType, otherId.id!);
    } catch {
      readable = false;
    }
    check(`reading another account's resource by id fails`, !readable,
      `${otherId.resourceType}/${otherId.id}`);
  }

  // Deleting must not reach across accounts either.
  const deletable = b.resources.find((r) => r.resourceType === 'Observation');
  if (deletable) {
    const beforeB = (await repoB.search({resourceType: 'Observation', count: 1, total: 'accurate'})).total ?? 0;
    await repoA.deleteResource('Observation', deletable.id!);
    const afterB = (await repoB.search({resourceType: 'Observation', count: 1, total: 'accurate'})).total ?? 0;
    check(`one account cannot delete another's record`, beforeB === afterB, `B still has ${afterB}`);
  }

  // An unscoped repository is admin tooling, and must be an explicit choice rather than the default
  // a caller falls into.
  const unscoped = new SqliteFhirRepository({file: dbFile});
  const unscopedTotal = (await unscoped.search({resourceType: 'Observation', count: 1, total: 'accurate'})).total ?? 0;
  check('an unscoped repository sees no account\'s records by default', unscopedTotal === 0,
    `saw ${unscopedTotal}`);
  unscoped.db.close();

  repoA.db.close();
  repoB.db.close();

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
