/**
 * Manual upload, end to end (yourphr#654): a real HTTP multipart POST against a booted app, and the
 * records come back out through the ordinary record doors afterwards.
 *
 * Synthetic records only — the bundle here is built in this file, not read from anywhere.
 *
 *   npm run upload
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleApp } from '../src/app.js';
import { ApiContext } from '../src/framework/ApiContext.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const bundle = (ids: string[]): string => JSON.stringify({
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    ...ids.map((id) => ({ resource: { resourceType: 'Condition', id, code: { text: `Condition ${id}` }, recordedDate: '2024-01-01' } })),
    { request: { method: 'GET', url: 'Patient' } }, // not a resource: must be skipped, not fatal
  ],
});

function multipart(filename: string, body: string, boundary = 'BND'): { headers: Record<string, string>; body: Buffer } {
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--\r\n`;
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.from(payload) };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'upload-tests-'));
  const app = await assembleApp(dir, { env: { YOURPHR_DATABASE_ENCRYPTION_KEY: 'k', YOURPHR_BACKUP_ENCRYPTION_KEY: 'b' } });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const admin = ApiContext.system('upload-tests', 'admin', app.engine);
  await app.users.createUser(admin, 'alice', 'alice-long-enough-password');
  await app.users.createUser(admin, 'bob', 'bob-long-enough-password');

  const signIn = async (username: string, password: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  };
  const alice = await signIn('alice', 'alice-long-enough-password');
  const bob = await signIn('bob', 'bob-long-enough-password');

  const upload = async (cookie: string, filename: string, body: string): Promise<{ status: number; json: Record<string, unknown> }> => {
    const { headers, body: payload } = multipart(filename, body);
    const res = await fetch(`${base}/api/secure/source/manual`, { method: 'POST', headers: { ...headers, cookie }, body: payload });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  console.log('\nthe upload itself\n');
  const ok = await upload(alice, 'export.json', bundle(['c1', 'c2', 'c3']));
  check('a bundle uploads and answers 200', ok.status === 200, `status ${ok.status}`);
  const summary = ok.json['summary'] as Record<string, number> | undefined;
  check('every resource entry landed', summary?.created === 3, JSON.stringify(summary));
  check('a non-resource entry is skipped, not fatal', summary?.skipped === 1, JSON.stringify(summary));
  const source = ok.json['data'] as Record<string, unknown> | undefined;
  check('one manual source carries the imports', source?.['display'] === 'Manual upload', String(source?.['display']));

  console.log('\nthe records are real records afterwards\n');
  const aliceCtx = ApiContext.system('upload-tests', 'alice', app.engine);
  const conditions = await app.engine.managers.records.list(aliceCtx, 'Condition');
  check('they read back through the ordinary record door', conditions.length === 3, `${conditions.length} condition(s)`);
  const counts = await app.engine.managers.records.sourceCounts(aliceCtx, String(source?.['id']));
  check('they are attributed to the source that imported them', counts[0]?.count === 3, JSON.stringify(counts));
  // Searchable on what textFor() actually extracts. It skips the whole `code` subtree, so a
  // Condition's NAME is not in the index — a known upstream limitation of the dashboard's own
  // search (see ChatManager.textOf), not something this import introduces.
  const found = await app.engine.managers.records.searchText(aliceCtx, 'Condition');
  check('they are searchable immediately', found.length === 3, `${found.length} hit(s)`);

  console.log('\nre-uploading\n');
  const again = await upload(alice, 'export.json', bundle(['c1', 'c2', 'c3']));
  check('the same bundle again updates rather than colliding', (again.json['summary'] as Record<string, number>)?.updated === 3, JSON.stringify(again.json['summary']));
  check('re-uploading does not accumulate sources', (await app.sources.listShaped(aliceCtx)).length === 1);

  console.log('\nwhat it refuses\n');
  const notJson = await upload(alice, 'x.json', 'this is not json');
  check('a file that is not JSON is a 400 with a reason', notJson.status === 400 && String(notJson.json['error']).includes('not JSON'), String(notJson.json['error']));
  const notBundle = await upload(alice, 'x.json', JSON.stringify({ resourceType: 'Patient', id: 'p1' }));
  check('a resource that is not a Bundle is refused', notBundle.status === 400 && String(notBundle.json['error']).includes('Bundle'), String(notBundle.json['error']));
  const empty = await upload(alice, 'x.json', JSON.stringify({ resourceType: 'Bundle', entry: [] }));
  check('an empty bundle is refused', empty.status === 400, String(empty.json['error']));
  const noMultipart = await fetch(`${base}/api/secure/source/manual`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: alice }, body: '{}' });
  check('a body that is not multipart is a 400', noMultipart.status === 400, `status ${noMultipart.status}`);
  const anonymous = await fetch(`${base}/api/secure/source/manual`, { method: 'POST', headers: multipart('x.json', bundle(['z1'])).headers, body: multipart('x.json', bundle(['z1'])).body });
  check('an unauthenticated upload is refused', anonymous.status === 401 || anonymous.status === 403, `status ${anonymous.status}`);

  console.log('\nisolation\n');
  await upload(bob, 'bob.json', bundle(['b1']));
  const bobCtx = ApiContext.system('upload-tests', 'bob', app.engine);
  check("bob's upload is bob's alone", (await app.engine.managers.records.list(bobCtx, 'Condition')).length === 1);
  check("and alice cannot see it", (await app.engine.managers.records.list(aliceCtx, 'Condition')).length === 3);

  await app.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
