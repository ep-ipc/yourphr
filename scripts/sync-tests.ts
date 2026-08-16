/**
 * Does a resync duplicate? (yourphr#539, gate 5)
 *
 * The failure this exists to rule out is a record list that doubles every time somebody presses
 * refresh — worse than one that fails, because it looks like it worked.
 *
 * Driven by a fake FHIR server on loopback and a temporary SQLite file: no network, no credentials,
 * no patient data, so it runs in CI.
 *
 *   npm run sync
 */
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bundle } from '@medplum/fhirtypes';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';
import { syncFrom, nextPageUrl } from '../src/sync/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function condition(id: string, text: string) {
  return {
    resourceType: 'Condition' as const,
    id,
    subject: { reference: 'Patient/p1' },
    code: { text },
    recordedDate: '2026-01-01',
  };
}

/** Serves two pages of Conditions, linked by `next`, plus a Patient. */
function startFhirServer(pageTwoText = 'Asthma') {
  let requests = 0;
  const server = createServer((req, res: ServerResponse) => {
    requests++;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (bundle: Bundle) => {
      res.writeHead(200, { 'content-type': 'application/fhir+json' });
      res.end(JSON.stringify(bundle));
    };

    if (req.url?.startsWith('/Everything?page=2')) {
      send({
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: condition('c3', pageTwoText) }, { resource: { resourceType: 'Patient', id: 'p1' } }],
      });
      return;
    }
    if (req.url?.startsWith('/Everything')) {
      send({
        resourceType: 'Bundle',
        type: 'searchset',
        link: [{ relation: 'next', url: `${base}/Everything?page=2` }],
        entry: [{ resource: condition('c1', 'Hypertension') }, { resource: condition('c2', 'Diabetes') }],
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, requestCount: () => requests };
}

function listen(server: ReturnType<typeof startFhirServer>['server']): Promise<string> {
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  );
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-sync-'));
  const dbFile = join(dir, 'sync.db');
  const repo = new SqliteFhirRepository({ file: dbFile, userId: 'user-a' });

  console.log('\nnext-link handling\n');
  const sameOrigin: Bundle = {
    resourceType: 'Bundle',
    type: 'searchset',
    link: [{ relation: 'next', url: 'https://fhir.example.com/Everything?page=2' }],
  };
  check(
    'follows a next link on the same origin',
    nextPageUrl(sameOrigin, 'https://fhir.example.com/Everything') === 'https://fhir.example.com/Everything?page=2'
  );
  check('returns nothing when there is no next link', nextPageUrl({ resourceType: 'Bundle', type: 'searchset' }, 'https://fhir.example.com/x') === undefined);

  // A provider paging the client onto another host would be handed the Authorization header.
  const offOrigin: Bundle = {
    resourceType: 'Bundle',
    type: 'searchset',
    link: [{ relation: 'next', url: 'https://evil.example.net/steal' }],
  };
  let leftOrigin = '';
  try {
    nextPageUrl(offOrigin, 'https://fhir.example.com/Everything');
  } catch (err) {
    leftOrigin = (err as Error).message;
  }
  check('refuses a next link that leaves the origin', leftOrigin.includes('leaves the origin'), leftOrigin);

  const relative: Bundle = {
    resourceType: 'Bundle',
    type: 'searchset',
    link: [{ relation: 'next', url: '/Everything?page=2' }],
  };
  check(
    'resolves a relative next link against the current page',
    nextPageUrl(relative, 'https://fhir.example.com/Everything') === 'https://fhir.example.com/Everything?page=2'
  );

  console.log('\nfirst sync\n');
  const provider = startFhirServer();
  const base = await listen(provider.server);

  const first = await syncFrom(`${base}/Everything`, { repo, accessToken: 'at-1', allowInternal: true });
  check('follows the next link across pages', first.pages === 2, `${first.pages} pages`);
  check('receives every resource', first.received === 4, `${first.received}`);
  check('creates all four on a first run', first.created === 4 && first.updated === 0, `${first.created} created, ${first.updated} updated`);

  const afterFirst = await repo.search({ resourceType: 'Condition', count: 100, total: 'accurate' });
  check('three Conditions stored', afterFirst.total === 3, `${afterFirst.total}`);

  console.log('\nresync — the gate\n');
  const second = await syncFrom(`${base}/Everything`, { repo, accessToken: 'at-1', allowInternal: true });
  check('a resync creates nothing new', second.created === 0, `${second.created} created`);
  check('a resync updates what it already had', second.updated === 4, `${second.updated} updated`);

  const afterSecond = await repo.search({ resourceType: 'Condition', count: 100, total: 'accurate' });
  check('the record count is unchanged after a resync', afterSecond.total === 3, `${afterSecond.total} (was ${afterFirst.total})`);

  const third = await syncFrom(`${base}/Everything`, { repo, accessToken: 'at-1', allowInternal: true });
  const afterThird = await repo.search({ resourceType: 'Condition', count: 100, total: 'accurate' });
  check('and after a third', afterThird.total === 3, `${afterThird.total}`);
  check('a third sync still creates nothing', third.created === 0);

  console.log('\nchanged records update rather than duplicate\n');
  provider.server.close();
  const revised = startFhirServer('Asthma, resolved');
  const revisedBase = await listen(revised.server);
  await syncFrom(`${revisedBase}/Everything`, { repo, accessToken: 'at-1', allowInternal: true });

  const c3 = (await repo.readResource('Condition', 'c3')) as { code?: { text?: string } };
  check('the updated text replaced the old one', c3.code?.text === 'Asthma, resolved', c3.code?.text ?? 'missing');
  const afterUpdate = await repo.search({ resourceType: 'Condition', count: 100, total: 'accurate' });
  check('a changed record did not add a row', afterUpdate.total === 3, `${afterUpdate.total}`);
  revised.server.close();

  console.log('\nrecords that cannot be synced safely\n');
  const idless = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/fhir+json' });
    res.end(
      JSON.stringify({
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Condition', code: { text: 'no id' } } }, { resource: null }],
      })
    );
  });
  const idlessBase = await listen(idless as never);
  const idlessReport = await syncFrom(`${idlessBase}/Everything`, { repo, accessToken: 'at-1', allowInternal: true });
  check('a resource with no id is skipped, not stored', idlessReport.created === 0, `${idlessReport.created} created`);
  check('and the skip is reported rather than silent', idlessReport.skipped.length === 2, `${idlessReport.skipped.length} skipped`);
  idless.close();

  console.log('\nKNOWN GAP: two providers, one resource id\n');

  // Characterises current behaviour rather than endorsing it.
  //
  // The store keys on (resource_type, id, user_id) — there is no source dimension. YourPHR's Go
  // backend keys on (source_id, source_resource_type, source_resource_id), and the difference only
  // shows when two providers issue the SAME id to the same person. The earlier shadow run measured
  // 0 collisions across 8 real sources, but that is a property of one person's data, not a
  // guarantee: nothing stops Epic and Cerner both calling something Condition/c1.
  //
  // The failure is worse than a duplicate. The second sync silently OVERWRITES the first provider's
  // record, so a record does not double — it disappears. Deciding whether to add a source column is
  // real work, so this test exists to make the gap fail loudly the day the key changes.
  const providerA = startFhirServer();
  const aBase = await listen(providerA.server);
  await syncFrom(`${aBase}/Everything`, { repo, accessToken: 'at-a', allowInternal: true });
  providerA.server.close();

  const collide = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/fhir+json' });
    res.end(
      JSON.stringify({
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Condition', id: 'c1', code: { text: 'A DIFFERENT PROVIDER' } } }],
      })
    );
  });
  const collideBase = await listen(collide as never);
  const collision = await syncFrom(`${collideBase}/Everything`, { repo, accessToken: 'at-b', allowInternal: true });
  collide.close();

  const c1 = (await repo.readResource('Condition', 'c1')) as { code?: { text?: string } };
  check(
    'a second provider OVERWRITES a colliding id (known gap, not desired)',
    collision.created === 0 && c1.code?.text === 'A DIFFERENT PROVIDER',
    `Condition/c1 now reads "${c1.code?.text}" — the first provider's record is gone`
  );

  repo.db.close();
  rmSync(dir, { recursive: true, force: true });

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
