/**
 * The one-command migration harness (yourphr#586). A synthetic Go database with the GORM shapes
 * production has — users, source_credentials, provider_catalog_entries, fhir_* tables, the custom
 * config file — migrated into stores opened exactly as the server opens them. No PHI: every
 * record is invented.
 *
 * Teeth, per the repo rule that a guard nobody has tried to defeat is not known to work: a row
 * deleted from the receiving side after migration MUST turn the verification red; a Go row whose
 * resource_raw contradicts itself MUST be rejected and MUST fail the gate; the CLI MUST exit 1 on
 * either.
 *
 *   npm run migrate:tool
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3-multiple-ciphers';
import bcrypt from 'bcryptjs';
import { openStores } from '../src/app.js';
import { ApiContext } from '../src/framework/ApiContext.js';
import { CATALOG_FIELDS_NOT_CARRIED, migrateFromGo, openGoDatabase, verifyAgainstGo } from '../src/migrate/tool.js';
import { isLegacyBcrypt } from '../src/framework/providers/PasswordAuthProvider.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const PASSWORD = 'correct-horse-battery';

/** A Go data root: go.db with GORM-shaped tables and config/app-custom-config.json. */
function makeGoInstance(root: string, options: { badRow?: boolean } = {}): string {
  mkdirSync(join(root, 'config'), { recursive: true });
  const path = join(root, 'go.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password TEXT, token_generation INTEGER, role TEXT, deleted_at TEXT)`);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, NULL)').run('u-1', 'jim', hash, 2, 'admin');
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, NULL)').run('u-2', 'pat', hash, 0, 'user');
  db.prepare("INSERT INTO users VALUES ('u-3', 'ghost', ?, 0, 'user', '2026-01-01')").run(hash);
  // The account's own records (yourphr#596): consent as a user setting, the access log as day buckets.
  db.exec(`CREATE TABLE user_settings (id TEXT PRIMARY KEY, user_id TEXT, setting_key_name TEXT, setting_value_string TEXT, deleted_at TEXT)`);
  db.prepare("INSERT INTO user_settings VALUES ('s-1', 'u-1', 'tos_privacy_accepted_at', '2026-03-01T10:00:00Z', NULL)").run();
  db.prepare("INSERT INTO user_settings VALUES ('s-2', 'u-2', 'tos_privacy_accepted_at', '', NULL)").run();
  db.exec(`CREATE TABLE access_events (id TEXT PRIMARY KEY, user_id TEXT, actor_username TEXT, category TEXT, day TEXT, count INTEGER, first_at TEXT, last_at TEXT, deleted_at TEXT)`);
  db.prepare("INSERT INTO access_events VALUES ('e-1', 'u-1', 'jim', 'Conditions', '2026-04-01', 3, '2026-04-01T08:00:00Z', '2026-04-01T09:00:00Z', NULL)").run();
  db.prepare("INSERT INTO access_events VALUES ('e-2', 'u-1', 'jim', 'Summary', '2026-04-02', 1, '2026-04-02T08:00:00Z', '2026-04-02T08:00:00Z', NULL)").run();
  db.prepare("INSERT INTO access_events VALUES ('e-3', 'u-3', 'ghost', 'Summary', '2026-04-02', 1, '2026-04-02T08:00:00Z', '2026-04-02T08:00:00Z', NULL)").run();

  db.exec(`CREATE TABLE source_credentials (id TEXT PRIMARY KEY, user_id TEXT, display TEXT, api_endpoint_base_url TEXT, client_id TEXT,
    patient TEXT, scopes TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, environment TEXT, deleted_at TEXT)`);
  db.prepare("INSERT INTO source_credentials VALUES ('src-1', 'u-1', 'Epic', 'https://fhir.example.org/r4', 'cid', 'pat-1', 'patient/*.read', 'tok', 'ref', 100, 'production', NULL)").run();
  db.prepare("INSERT INTO source_credentials VALUES ('src-2', 'u-1', 'Old Portal', 'https://old.example.org/r4', 'cid', 'pat-2', 'patient/*.read', 'tok', 'ref', 100, 'production', '2026-02-02')").run();
  db.prepare("INSERT INTO source_credentials VALUES ('src-3', 'u-2', 'Clinic', 'https://clinic.example.org/r4', 'cid', 'pat-3', 'patient/Condition.read', 'tok', 'ref', 100, 'production', NULL)").run();

  db.exec(`CREATE TABLE provider_catalog_entries (id TEXT PRIMARY KEY, display TEXT, environment TEXT, api_endpoint_base_url TEXT, scopes TEXT,
    platform_type TEXT, brand_logo_url TEXT, enabled INTEGER, client_id TEXT, client_secret TEXT, authorize_url_override TEXT,
    consent_policy TEXT, pre_connect_profile TEXT, deleted_at TEXT)`);
  db.prepare("INSERT INTO provider_catalog_entries VALUES ('c-1', 'Epic (Production)', 'production', 'https://fhir.example.org/r4', 'patient/*.read', 'epic', 'https://logo.example.org/e.png', 1, 'abc', 's3cret', '', 'required', 'auto', NULL)").run();
  db.prepare("INSERT INTO provider_catalog_entries VALUES ('c-2', 'Local Sandbox', 'sandbox', 'http://127.0.0.1:9999/fhir', 'patient/*.read', 'fhir', '', 1, 'sb', '', '', 'skip', 'generic', NULL)").run();
  db.prepare("INSERT INTO provider_catalog_entries VALUES ('c-3', 'Retired', 'production', 'https://gone.example.org', 'patient/*.read', 'x', '', 0, '', '', '', 'required', 'auto', '2026-03-03')").run();
  db.prepare("INSERT INTO provider_catalog_entries VALUES ('c-4', 'Bad Env', 'staging', 'https://stage.example.org', 'patient/*.read', 'x', '', 1, '', '', '', 'required', 'auto', NULL)").run();

  const recordTable = (name: string): void => {
    db.exec(`CREATE TABLE ${name} (id TEXT, user_id TEXT, source_id TEXT, source_resource_type TEXT, source_resource_id TEXT, resource_raw TEXT, deleted_at TEXT)`);
  };
  recordTable('fhir_condition');
  recordTable('fhir_observation');
  recordTable('fhir_patient');
  db.exec('CREATE TABLE fhir_legacy_shape (id TEXT, note TEXT)'); // no record columns — must be skipped by name

  const condition = (id: string, text: string): string => JSON.stringify({ resourceType: 'Condition', id, code: { text }, clinicalStatus: { coding: [{ code: 'active' }] } });
  const ins = db.prepare('INSERT INTO fhir_condition VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('r1', 'u-1', 'src-1', 'Condition', 'c-1', condition('c-1', 'synthetic one'), null);
  ins.run('r2', 'u-1', 'src-1', 'Condition', 'c-2', condition('c-2', 'synthetic two'), null);
  ins.run('r3', 'u-1', 'src-2', 'Condition', 'c-3', condition('c-3', 'from a disconnected source'), null); // unmapped source
  ins.run('r4', 'u-2', 'src-3', 'Condition', 'c-4', condition('c-4', 'pat’s record'), null);
  ins.run('r5', 'u-1', 'src-1', 'Condition', 'c-5', condition('c-5', 'soft-deleted'), '2026-04-04'); // must not migrate
  ins.run('r6', 'u-1', 'src-1', 'Condition', 'c-6', condition('other-id', 'raw id disagrees'), null); // id rewritten
  ins.run('r7', 'u-3', 'src-1', 'Condition', 'c-7', condition('c-7', 'ghost user'), null); // unknown user

  const obs = db.prepare('INSERT INTO fhir_observation VALUES (?, ?, ?, ?, ?, ?, ?)');
  obs.run('o1', 'u-1', 'src-1', 'Observation', 'o-1', JSON.stringify({ resourceType: 'Observation', id: 'o-1', status: 'final', code: { text: 'synthetic vital' } }), null);
  if (options.badRow) {
    obs.run('o2', 'u-1', 'src-1', 'Observation', 'o-bad', condition('o-bad', 'a Condition in the Observation table'), null);
  }
  db.prepare('INSERT INTO fhir_patient VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('p1', 'u-1', 'src-1', 'Patient', 'p-1', JSON.stringify({ resourceType: 'Patient', id: 'p-1', name: [{ family: 'Testcase' }] }), null);
  db.close();

  writeFileSync(join(root, 'config', 'app-custom-config.json'), JSON.stringify({
    _comment: 'synthetic',
    'jwt.session_ttl_minutes': 30,
    'backup.max-backups': 3,
    'theme.name': 'dusk',
    operator: { name: 'Nerds by the Hour' }, // the older nested shape, flattened on read
  }, null, 2));
  return path;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-migrate-tool-'));
  const goRoot = join(dir, 'go');
  const goPath = makeGoInstance(goRoot);
  const dataDir = join(dir, 'spike');
  mkdirSync(dataDir);

  // --- refusals at the door ---
  const notOurs = new Database(join(dir, 'other.db'));
  notOurs.exec('CREATE TABLE t (x)');
  notOurs.close();
  let refused = '';
  try { openGoDatabase(join(dir, 'other.db')); } catch (err) { refused = (err as Error).message; }
  check('a database without a users table is refused, named', refused.includes('no users table'));

  // --- the migration ---
  const goDb = openGoDatabase(goPath);
  const stores = await openStores(dataDir, {});
  const report = await migrateFromGo(goDb, stores, { goDataDir: goRoot, allowInternalUrls: true });

  check('users: both live accounts imported, the soft-deleted one left behind',
    report.users.imported.sort().join(',') === 'jim,pat' && report.users.goLive === 2 && report.users.admins.join(',') === 'jim');
  check('account data: the legal consent and the access log carry whole, per live user (yourphr#596)',
    report.account.consentsCarried.join(',') === 'jim' && report.account.accessEventsImported === 2 && stores.account.consentAcceptedAt('jim') === '2026-03-01T10:00:00Z'
      && stores.account.consentAcceptedAt('pat') === '' && stores.account.listAccess('jim').map((e) => `${e.day}:${e.category}:${e.count}`).join(',') === '2026-04-02:Summary:1,2026-04-01:Conditions:3'
      && stores.account.listAccess('ghost').length === 0);
  const signIn = await stores.sessions.signIn('jim', { password: PASSWORD }, { remoteAddr: '127.0.0.1', xff: undefined });
  const storedHash = (stores.db.prepare('SELECT password_hash FROM auth_users WHERE username = ?').get('jim') as { password_hash: string }).password_hash;
  check('a migrated account signs in with its Go password and is rehashed on the way (yourphr#583)', signIn.ok && !isLegacyBcrypt(storedHash));

  check('catalog: live entries imported, the retired one skipped, an unknown environment rejected by name',
    report.catalog.imported.sort().join(',') === 'Epic (Production),Local Sandbox' && report.catalog.rejected.length === 1 && report.catalog.rejected[0]!.display === 'Bad Env');
  const catalogCtx = ApiContext.system('test', 'admin', stores.engine);
  const catalogEntries = () => stores.catalog.entries(catalogCtx);
  const epicEntry = (await catalogEntries()).find((e) => e.display === 'Epic (Production)')!;
  check('catalog: the client secret lands (write-only) and enabled carries', epicEntry.hasClientSecret && (await stores.catalog.clientSecretFor(catalogCtx, epicEntry.id)) === 's3cret' && epicEntry.enabled);
  check('catalog: platform_type, brand_logo_url, consent_policy and pre_connect_profile are CARRIED (yourphr#603); nothing is listed as not carried',
    report.catalog.notCarried.length === 0 && CATALOG_FIELDS_NOT_CARRIED.length === 0 && epicEntry.platformType === 'epic' && epicEntry.brandLogoUrl === 'https://logo.example.org/e.png'
      && epicEntry.consentPolicy === 'required' && epicEntry.preConnectProfile === 'auto' && (await catalogEntries()).find((e) => e.display === 'Local Sandbox')?.consentPolicy === 'skip');

  check('sources: the two live sources imported with a Go id -> spike id map',
    report.sources.imported.length === 2 && Object.keys(report.sources.idMap).sort().join(',') === 'src-1,src-3');

  check('records: 7 imported — deleted row and ghost-user row left behind, counted',
    report.records.imported === 7 && report.records.rejectedTotal === 0 && report.records.read.unknownUser === 1 &&
    report.records.perType['Condition'] === 5 && report.records.perType['Observation'] === 1 && report.records.perType['Patient'] === 1,
    JSON.stringify({ imported: report.records.imported, perType: report.records.perType, read: report.records.read }));
  check('records: the table without record columns is skipped BY NAME', report.records.read.tablesSkipped.join(',') === 'fhir_legacy_shape');
  check('records: a raw id that disagrees with the row is counted and the row id wins', report.records.idRewritten === 1 &&
    (await stores.recordsProvider.read('jim', 'Condition', 'c-6')) !== undefined);
  // The witness reads the provider, below the manager — as the verification gate itself does.
  const sourceOf = async (id: string): Promise<string> => (await stores.recordsProvider.read('jim', 'Condition', id))?.sourceId ?? '<missing>';
  check('records: attribution survives — mapped source becomes source-<spike id>', (await sourceOf('c-1')) === `source-${report.sources.idMap['src-1']}`);
  check('records: a disconnected source keeps a legacy-<go id> attribution, counted, never blank', (await sourceOf('c-3')) === 'legacy-src-2' && report.records.unmappedSource === 1);
  const patConditions = await stores.recordsProvider.search('pat', { resourceType: 'Condition', count: 10, total: 'accurate' });
  const patSeesJim = await stores.recordsProvider.search('pat', { resourceType: 'Patient', count: 10, total: 'accurate' });
  check('records: per-user isolation holds across the migration', (patConditions.total ?? 0) === 1 && (patSeesJim.total ?? 0) === 0);

  check('config: the translatable keys are carried with their units converted',
    report.config.carried.length === 3 && stores.config.getInt('auth.session.sliding-seconds') === 1800 && stores.config.getInt('backup.max-backups') === 3);
  check('config: the operator contact is carried, nested shape flattened (yourphr#593)', stores.config.getString('operator.name') === 'Nerds by the Hour');
  check('config: everything else is LISTED as not carried, comments dropped',
    report.config.notCarried.join(',') === 'theme.name');

  check('VERIFY: every (user, type) id list agrees and the migration is ok',
    report.ok && report.verify.disagreements.length === 0 && report.verify.agreed === 4 && report.verify.typesCompared === 4 && report.verify.usersCompared.join(',') === 'jim,pat',
    JSON.stringify(report.verify));

  // --- idempotent ---
  const again = await migrateFromGo(goDb, stores, { goDataDir: goRoot, allowInternalUrls: true });
  check('re-run is one-way: nothing imported twice, nothing duplicated, still verified',
    again.ok && again.users.imported.length === 0 && again.users.skippedExisting.length === 2 && again.records.imported === 0 && again.records.skippedExisting === 7 &&
    again.catalog.imported.length === 0 && again.sources.imported.length === 0 && (await stores.sources.count()) === 2);

  // --- TOOTH 1: a record removed on the receiving side turns the gate red ---
  // Tampering happens OUTSIDE the door on purpose: a raw handle on the file, as an attacker or a
  // stray script would have — the gate must notice what the manager never saw.
  const raw = new Database(join(dataDir, 'records.db'));
  raw.prepare("DELETE FROM resources WHERE resource_type = 'Condition' AND id = 'c-2' AND user_id = 'jim'").run();
  raw.prepare("DELETE FROM search_index WHERE resource_type = 'Condition' AND resource_id = 'c-2' AND user_id = 'jim'").run();
  raw.close();
  const tampered = await verifyAgainstGo(goDb, stores, [{ id: 'u-1', username: 'jim' }, { id: 'u-2', username: 'pat' }]);
  check('TOOTH: a record missing here is a named disagreement',
    tampered.disagreements.length === 1 && tampered.disagreements[0]!.resourceType === 'Condition' && tampered.disagreements[0]!.missing.join(',') === 'c-2', JSON.stringify(tampered.disagreements));

  // --- TOOTH 2: go-answers (the TestShadowExport shape) is compared too ---
  const withAnswers = await verifyAgainstGo(goDb, stores, [{ id: 'u-2', username: 'pat' }], { username: 'pat', answers: { Condition: ['c-4', 'c-99'] } });
  check('TOOTH: go-answers disagreeing with this side is reported under its own label',
    withAnswers.disagreements.length === 1 && withAnswers.disagreements[0]!.note?.startsWith('go-answers') === true && withAnswers.disagreements[0]!.missing.join(',') === 'c-99');

  stores.close();
  goDb.close();

  // --- TOOTH 3: a Go row that contradicts itself is rejected AND fails the gate ---
  const badRoot = join(dir, 'go-bad');
  const badPath = makeGoInstance(badRoot, { badRow: true });
  const badDb = openGoDatabase(badPath);
  mkdirSync(join(dir, 'spike-bad'));
  const badStores = await openStores(join(dir, 'spike-bad'), {});
  const bad = await migrateFromGo(badDb, badStores, { goDataDir: badRoot, allowInternalUrls: true });
  check('TOOTH: resource_raw contradicting its row is REJECTED with the reason, not repaired',
    bad.records.rejectedTotal === 1 && bad.records.rejected[0]!.reason.includes('resourceType Condition') && bad.records.rejected[0]!.ref.endsWith('Observation/o-bad'));
  check('TOOTH: the rejected row fails verification — the gate does not pass a migration that left data behind',
    !bad.ok && bad.verify.disagreements.some((d) => d.resourceType === 'Observation' && d.go === 2 && d.ts === 1));
  badStores.close();
  badDb.close();

  // --- one account only ---
  const oneDb = openGoDatabase(goPath);
  mkdirSync(join(dir, 'spike-one'));
  const oneStores = await openStores(join(dir, 'spike-one'), {});
  const one = await migrateFromGo(oneDb, oneStores, { onlyUser: 'pat', goDataDir: goRoot, allowInternalUrls: true });
  check('--user migrates and verifies one account only', one.ok && one.users.imported.join(',') === 'pat' && one.records.imported === 1 && one.sources.imported.length === 1 && one.verify.usersCompared.join(',') === 'pat');
  let unknown = '';
  try { await migrateFromGo(oneDb, oneStores, { onlyUser: 'nobody' }); } catch (err) { unknown = (err as Error).message; }
  check('--user naming no live account is refused by name', unknown.includes('nobody'));
  oneStores.close();
  oneDb.close();

  // --- the CLI, end to end: exit codes are the contract a runbook keys off ---
  const cli = (args: string[]) => spawnSync('npx', ['tsx', 'scripts/migrate-from-go.ts', ...args], { encoding: 'utf8', timeout: 120_000 });
  const good = cli(['--go', goPath, '--data', join(dir, 'spike-cli'), '--go-data', goRoot, '--allow-internal']);
  check('CLI exits 0 on a verified migration and says so', good.status === 0 && good.stdout.includes('MIGRATION VERIFIED'), `status ${good.status}: ${good.stderr.slice(0, 200)}`);
  const badCli = cli(['--go', badPath, '--data', join(dir, 'spike-cli-bad'), '--go-data', badRoot, '--allow-internal']);
  check('CLI exits 1 when the gate fails and names the disagreement', badCli.status === 1 && badCli.stdout.includes('DISAGREEMENT') && badCli.stdout.includes('MIGRATION NOT VERIFIED'), `status ${badCli.status}`);
  const usage = cli(['--go', goPath]);
  check('CLI refuses to guess the data dir', usage.status === 2);

  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`migrate-tool harness failed: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
