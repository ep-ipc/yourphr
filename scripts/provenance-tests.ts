/**
 * Provenance harness (yourphr#579). Loopback fake provider, synthetic records, no PHI.
 *
 * Runs the REAL pipeline — worker sync from a live fake — and then asks the provenance surface
 * the patient's question: where did this record come from, when, how often confirmed.
 *
 *   npm run provenance
 */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { SourceStore, runSyncPass } from '../src/worker/index.js';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';
import { legibleProvenance } from '../src/provenance/index.js';
import { Engine } from '../src/framework/Engine.js';
import { ApiContext } from '../src/framework/ApiContext.js';
import { RecordsManager } from '../src/app/managers/RecordsManager.js';
import { SqliteRecordsProvider } from '../src/app/providers/SqliteRecordsProvider.js';

import { repositoryWriter } from '../src/sync/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function startFakeProvider(token: string) {
  return createServer((req, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if ((req.headers['authorization'] ?? '') !== `Bearer ${token}`) {
      send(401, { error: 'nope' });
      return;
    }
    const type = url.pathname.replace('/', '');
    send(200, {
      resourceType: 'Bundle', type: 'searchset',
      entry: [{ resource: { resourceType: type, id: `${type.toLowerCase()}-1`, code: { text: `synthetic ${type}` } } }],
    });
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-prov-'));
  const db = new Database(join(dir, 'app.db'));
  const store = new SourceStore(db);
  const recordsFile = join(dir, 'records.db');
  const repos = new Map<string, SqliteFhirRepository>();
  const repoForUser = (u: string) => {
    let r = repos.get(u);
    if (!r) { r = new SqliteFhirRepository({ file: recordsFile, userId: u }); repos.set(u, r); }
    return r;
  };

  const server = startFakeProvider('tok');
  const base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });

  const source = store.add({
    userId: 'alice', display: 'Fake Regional Health', fhirBaseUrl: base, tokenUrl: `${base}/token`, clientId: 'cid',
    patient: 'pa', resourceTypes: ['Condition'], accessToken: 'tok', refreshToken: '', expiresAt: 99_999_999,
  });
  const deps = { store, repoForUser, writerFor: (u: string, sid: string) => repositoryWriter(repoForUser(u), sid), maxPages: 5, allowInternal: true };
  await runSyncPass(deps, 1_000_000);

  const repo = repoForUser('alice');
  const displayFor = (sourceId: string) => {
    const numeric = Number(sourceId.replace('source-', ''));
    return store.list().find((s) => s.id === numeric)?.display ?? '';
  };
  // Provenance is the Records manager's answer (yourphr#609) — asked through the door, for whoever is asking.
  const engine = new Engine();
  engine.register('records', new RecordsManager(engine, new SqliteRecordsProvider(recordsFile, undefined)));
  await engine.initialize();
  const records = engine.managers.records;
  records.sourceDisplay = displayFor;
  const alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
  const bob = ApiContext.from({ username: 'bob', role: 'user' }, engine);

  const first = await records.provenance(alice, 'Condition', 'condition-1');
  check('a synced record knows its source, by NAME', first?.sourceDisplay === 'Fake Regional Health', first?.sourceDisplay);
  check('and records when it first arrived', !!first?.firstReceivedAt && first.timesSeen === 1);

  await runSyncPass(deps, 1_000_100);
  await runSyncPass(deps, 1_000_200);
  const confirmed = (await records.provenance(alice, 'Condition', 'condition-1'))!;
  check('a resync reads as re-confirmation: source and first-received STABLE, timesSeen grows',
    confirmed.sourceId === first?.sourceId && confirmed.firstReceivedAt === first?.firstReceivedAt && confirmed.timesSeen === 3,
    `seen ${confirmed.timesSeen}`);
  check('lastConfirmed moves forward with the source', confirmed.lastConfirmedAt >= first!.lastConfirmedAt);

  // Manual entry: no source, honestly attributed to this instance.
  await repo.updateResource({ resourceType: 'Condition', id: 'hand-entered', code: { text: 'typed in by the patient' } } as never);
  const manual = (await records.provenance(alice, 'Condition', 'hand-entered'))!;
  check('a manually entered record is attributed to THIS INSTANCE — never a guessed provider',
    manual.sourceId === '' && manual.sourceDisplay === 'This instance (manual entry or upload)');

  // Unknown source id: raw id shown, not invented.
  records.sourceDisplay = () => '';
  const rawFallback = (await records.provenance(alice, 'Condition', 'condition-1'))!;
  records.sourceDisplay = displayFor;
  check('an unresolvable source shows its raw id, never an invented name', rawFallback.sourceDisplay === `source-${source.id}`);

  const line = legibleProvenance(confirmed);
  check('the legible line answers the patient\'s question in one sentence',
    line.startsWith('From Fake Regional Health · first received ') && line.includes('seen 3 times'), line);
  const singleLine = legibleProvenance(manual);
  check('a once-seen record keeps the line short (no redundant confirmed/seen)',
    !singleLine.includes('seen') && singleLine.startsWith('From This instance'));

  check('a record that does not exist yields no provenance, not a fabricated one',
    await records.provenance(alice, 'Condition', 'ghost') === undefined);

  // Isolation: bob cannot read alice's provenance.
  check('provenance is per-user isolated', await records.provenance(bob, 'Condition', 'condition-1') === undefined);

  server.close();
  await engine.shutdown();
  for (const r of repos.values()) r.db.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`provenance harness failed: ${(err as Error).message}`);
  process.exit(1);
});
