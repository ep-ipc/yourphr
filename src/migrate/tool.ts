/**
 * One command migrates a frozen Go instance into this stack (yourphr#586; Phase 5 rung four).
 *
 *   users -> catalog -> sources -> records -> config -> VERIFY
 *
 * Every step is one-way and idempotent: what already exists on the receiving side is skipped and
 * reported, never overwritten, so the command can be re-run after a partial failure without
 * doubling anything. The Go database is opened READ-ONLY; this tool changes nothing on the side it
 * migrates from.
 *
 * The exit criterion is the verification, not the import. A migration is done when, for every
 * user and every resource type, the spike answers exactly the id list the Go stack holds — the
 * same bar the shadow comparison set (29/29 resource types, yourphr#539) — and not when the last
 * INSERT returns. `ok` is false on any disagreement or any record the import could not carry.
 *
 * Two honesty rules carried from the earlier rungs:
 *   - Nothing is invented. A Go field with no counterpart here (catalog platform_type, a theme
 *     name) is REPORTED as not carried; a record whose resource_raw disagrees with its own row is
 *     REJECTED and counted, not repaired.
 *   - Attribution survives. Every fhir_* row is written under the spike source its Go source_id
 *     maps to, so provenance ("which source said what") works on migrated records the same as on
 *     synced ones. A row whose source is gone (disconnected, soft-deleted) keeps a `legacy-<id>`
 *     attribution rather than an empty one.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Resource, ResourceType } from '@medplum/fhirtypes';
import { readGoUsers, importLegacyUsers, type ImportReport as UserImportReport } from '../auth/index.js';
import { readGoSources, importLegacySources, type SourceImportReport } from './index.js';
import type { CatalogWrite, ProviderCatalog } from '../catalog/index.js';
import type { ConfigStore, ConfigValue } from '../config/index.js';
import type { SqliteFhirRepository } from '../SqliteFhirRepository.js';
import type { Stores } from '../app.js';

type GoDb = InstanceType<typeof Database>;

// ---------------------------------------------------------------------------------------------
// The Go database
// ---------------------------------------------------------------------------------------------

/** Opens a Go (GORM) YourPHR database read-only, refusing anything that is not one. */
export function openGoDatabase(path: string, key?: string): GoDb {
  if (!existsSync(path)) {
    throw new Error(`${path}: no such file`);
  }
  const db = new Database(path, { readonly: true });
  if (key) {
    db.pragma("cipher='sqlcipher'");
    db.pragma(`key='${key.replace(/'/g, "''")}'`);
  }
  let hasUsers = false;
  try {
    hasUsers = tableExists(db, 'users');
  } catch (err) {
    db.close();
    throw new Error(`${path}: cannot be read (${(err as Error).message}) — encrypted with a different key?`);
  }
  if (!hasUsers) {
    db.close();
    throw new Error(`${path}: no users table — not a YourPHR database`);
  }
  return db;
}

function tableExists(db: GoDb, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function columnsOf(db: GoDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export interface GoUser {
  id: string;
  username: string;
}

/** Live (not soft-deleted) accounts, id and name — the join key every other table uses. */
export function readGoUserIds(goDb: GoDb): GoUser[] {
  return goDb.prepare('SELECT id, username FROM users WHERE deleted_at IS NULL ORDER BY username').all() as GoUser[];
}

// ---------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------

/** Go catalog columns with no counterpart here. Reported, never silently dropped. */
export const CATALOG_FIELDS_NOT_CARRIED = ['platform_type', 'brand_logo_url', 'consent_policy', 'pre_connect_profile'] as const;

export interface LegacyCatalogEntry {
  display: string;
  environment: string;
  fhirBaseUrl: string;
  scopes: string;
  clientId: string;
  clientSecret: string;
  enabled: boolean;
  authorizeUrlOverride: string;
}

export function readGoCatalog(goDb: GoDb): LegacyCatalogEntry[] {
  if (!tableExists(goDb, 'provider_catalog_entries')) {
    return [];
  }
  const rows = goDb.prepare('SELECT * FROM provider_catalog_entries WHERE deleted_at IS NULL ORDER BY display').all() as Record<string, unknown>[];
  const str = (r: Record<string, unknown>, k: string): string => (r[k] === null || r[k] === undefined ? '' : String(r[k]));
  return rows.map((r) => ({
    display: str(r, 'display'),
    environment: str(r, 'environment') || 'production',
    fhirBaseUrl: str(r, 'api_endpoint_base_url'),
    scopes: str(r, 'scopes'),
    clientId: str(r, 'client_id'),
    clientSecret: str(r, 'client_secret'),
    enabled: r['enabled'] === 1 || r['enabled'] === true || r['enabled'] === 'true' || r['enabled'] === '1',
    authorizeUrlOverride: str(r, 'authorize_url_override'),
  }));
}

export interface CatalogImportReport {
  imported: string[];
  skippedExisting: string[];
  rejected: { display: string; reason: string }[];
  notCarried: readonly string[];
}

/** One-way by display name; an operator's existing entry is never touched. */
export function importLegacyCatalog(catalog: ProviderCatalog, entries: LegacyCatalogEntry[], options: { allowInternal?: boolean } = {}): CatalogImportReport {
  const report: CatalogImportReport = { imported: [], skippedExisting: [], rejected: [], notCarried: CATALOG_FIELDS_NOT_CARRIED };
  const existing = new Set(catalog.list().map((e) => e.display));
  for (const e of entries) {
    if (existing.has(e.display)) {
      report.skippedExisting.push(e.display);
      continue;
    }
    if (e.environment !== 'sandbox' && e.environment !== 'production') {
      report.rejected.push({ display: e.display, reason: `environment "${e.environment}" is neither sandbox nor production` });
      continue;
    }
    const write: CatalogWrite = {
      display: e.display,
      environment: e.environment,
      fhirBaseUrl: e.fhirBaseUrl,
      scopes: e.scopes,
      clientId: e.clientId,
      clientSecret: e.clientSecret,
      enabled: e.enabled,
      authorizeUrlOverride: e.authorizeUrlOverride,
      allowInternal: options.allowInternal ?? false,
    };
    try {
      catalog.create(write);
      existing.add(e.display);
      report.imported.push(e.display);
    } catch (err) {
      report.rejected.push({ display: e.display, reason: (err as Error).message });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface LegacyRecord {
  username: string;
  goSourceId: string;
  resourceType: string;
  resourceId: string;
  raw: string;
}

export interface RecordReadStats {
  tablesRead: number;
  /** fhir_* tables without the columns a record needs — named, so a schema surprise is visible. */
  tablesSkipped: string[];
  /** Rows owned by an account that is not live — a soft-deleted user's records stay behind. */
  unknownUser: number;
  emptyRaw: number;
}

export function newReadStats(): RecordReadStats {
  return { tablesRead: 0, tablesSkipped: [], unknownUser: 0, emptyRaw: 0 };
}

const RECORD_COLUMNS = ['user_id', 'source_id', 'source_resource_type', 'source_resource_id', 'resource_raw'];

/**
 * Streams every live row of every fhir_* table. resource_raw is handed on UNPARSED — the same
 * property the whole spike rests on (export-resources.ts): nothing is reinterpreted on the way.
 */
export function* readGoRecords(goDb: GoDb, usernameById: Map<string, string>, stats: RecordReadStats, onlyUser?: string): Generator<LegacyRecord> {
  const tables = goDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fhir_%' ORDER BY name")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const cols = columnsOf(goDb, name);
    if (!RECORD_COLUMNS.every((c) => cols.has(c))) {
      stats.tablesSkipped.push(name);
      continue;
    }
    stats.tablesRead++;
    const where = cols.has('deleted_at') ? 'WHERE deleted_at IS NULL' : '';
    const stmt = goDb.prepare(`SELECT user_id, source_id, source_resource_type, source_resource_id, resource_raw FROM "${name}" ${where}`);
    // Streamed, not .all(): a DocumentReference table carries the documents' text, and one user's
    // export has run past 15,000 of them. The local Statement typing predates iterate().
    const rows = (stmt as unknown as { iterate(): Iterable<Record<string, unknown>> }).iterate();
    for (const row of rows) {
      const username = usernameById.get(String(row['user_id']));
      if (username === undefined) {
        stats.unknownUser++;
        continue;
      }
      if (onlyUser !== undefined && username !== onlyUser) {
        continue;
      }
      const raw = row['resource_raw'];
      if (raw === null || raw === undefined || raw === '') {
        stats.emptyRaw++;
        continue;
      }
      yield {
        username,
        goSourceId: String(row['source_id']),
        resourceType: String(row['source_resource_type']),
        resourceId: String(row['source_resource_id']),
        raw: typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : JSON.stringify(raw),
      };
    }
  }
}

export interface RecordImportReport {
  imported: number;
  skippedExisting: number;
  /** The first few rejections in full; rejectedTotal carries the count past that. */
  rejected: { ref: string; reason: string }[];
  rejectedTotal: number;
  /** Rows whose Go source is not a live connected source — attributed `legacy-<go id>`. */
  unmappedSource: number;
  /** resource_raw.id differed from source_resource_id; the row's id (what Go serves) wins. */
  idRewritten: number;
  perType: Record<string, number>;
  read: RecordReadStats;
}

const REJECTIONS_KEPT = 20;

export async function importLegacyRecords(
  records: Iterable<LegacyRecord>,
  repoForUser: (username: string) => SqliteFhirRepository,
  sourceIdMap: Record<string, number>,
  read: RecordReadStats
): Promise<RecordImportReport> {
  const report: RecordImportReport = { imported: 0, skippedExisting: 0, rejected: [], rejectedTotal: 0, unmappedSource: 0, idRewritten: 0, perType: {}, read };
  const reject = (ref: string, reason: string): void => {
    report.rejectedTotal++;
    if (report.rejected.length < REJECTIONS_KEPT) report.rejected.push({ ref, reason });
  };

  for (const r of records) {
    const ref = `${r.username} ${r.resourceType}/${r.resourceId}`;
    let resource: Resource;
    try {
      resource = JSON.parse(r.raw) as Resource;
    } catch (err) {
      reject(ref, `resource_raw is not JSON: ${(err as Error).message}`);
      continue;
    }
    if (!resource || typeof resource !== 'object' || resource.resourceType !== r.resourceType) {
      reject(ref, `resource_raw says resourceType ${(resource as { resourceType?: string } | null)?.resourceType ?? 'none'}, the row says ${r.resourceType}`);
      continue;
    }
    if (resource.id !== r.resourceId) {
      report.idRewritten++;
      resource = { ...resource, id: r.resourceId };
    }

    const repo = repoForUser(r.username);
    const exists = repo.db
      .prepare('SELECT 1 FROM resources WHERE resource_type = ? AND id = ? AND user_id = ?')
      .get(r.resourceType, r.resourceId, r.username);
    if (exists) {
      report.skippedExisting++;
      continue;
    }

    const mapped = sourceIdMap[r.goSourceId];
    if (mapped === undefined) report.unmappedSource++;
    repo.sourceId = mapped === undefined ? `legacy-${r.goSourceId}` : `source-${mapped}`;
    try {
      await repo.createResource(resource);
      report.imported++;
      report.perType[r.resourceType] = (report.perType[r.resourceType] ?? 0) + 1;
    } catch (err) {
      reject(ref, (err as Error).message);
    } finally {
      repo.sourceId = undefined;
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface ConfigTranslation {
  go: string;
  ts: string;
  convert: (value: unknown) => ConfigValue;
  note: string;
}

/**
 * The only Go settings with a counterpart here. Everything else in the Go overlay is reported as
 * not carried — listed by name, so the operator can see what they will be setting again.
 */
export const CONFIG_TRANSLATIONS: ConfigTranslation[] = [
  { go: 'backup.max-backups', ts: 'backup.max-backups', convert: (v) => Number(v), note: 'same meaning' },
  { go: 'backup.destination', ts: 'backup.destination', convert: (v) => String(v), note: 'same meaning' },
  { go: 'jwt.session_ttl_minutes', ts: 'auth.session.sliding-seconds', convert: (v) => Number(v) * 60, note: 'minutes -> seconds' },
  { go: 'jwt.session_absolute_hours', ts: 'auth.session.absolute-seconds', convert: (v) => Number(v) * 3600, note: 'hours -> seconds' },
  { go: 'operator.name', ts: 'operator.name', convert: (v) => String(v), note: 'same meaning (yourphr#593)' },
  { go: 'operator.contact_email', ts: 'operator.contact_email', convert: (v) => String(v), note: 'same meaning (yourphr#593)' },
  { go: 'operator.contact_url', ts: 'operator.contact_url', convert: (v) => String(v), note: 'same meaning (yourphr#593)' },
];

/** Reads <go data dir>/config/app-custom-config.json, flat dotted (post-#456) or nested (older). */
export function readGoCustomConfig(goDataDir: string): { path: string; values: Record<string, unknown> | undefined } {
  const path = join(goDataDir, 'config', 'app-custom-config.json');
  if (!existsSync(path)) {
    return { path, values: undefined };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return { path, values: flattenConfig(parsed) };
}

function flattenConfig(values: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('_comment')) continue;
    const full = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenConfig(value as Record<string, unknown>, full, out);
    } else {
      out[full] = value;
    }
  }
  return out;
}

export interface ConfigImportReport {
  path: string | undefined;
  carried: { from: string; to: string; value: ConfigValue }[];
  refused: { key: string; reason: string }[];
  notCarried: string[];
}

export function importLegacyConfig(config: ConfigStore, goConfig: { path: string; values: Record<string, unknown> | undefined } | undefined): ConfigImportReport {
  const report: ConfigImportReport = { path: goConfig?.path, carried: [], refused: [], notCarried: [] };
  const values = goConfig?.values;
  if (!values) {
    return report;
  }
  const translated = new Set<string>();
  for (const t of CONFIG_TRANSLATIONS) {
    if (!(t.go in values)) continue;
    translated.add(t.go);
    let value: ConfigValue;
    try {
      value = t.convert(values[t.go]);
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(`${t.go} = ${JSON.stringify(values[t.go])} is not a number`);
      }
      config.set(t.ts, value);
      report.carried.push({ from: t.go, to: t.ts, value });
    } catch (err) {
      report.refused.push({ key: t.go, reason: (err as Error).message });
    }
  }
  report.notCarried = Object.keys(values).filter((k) => !translated.has(k)).sort();
  return report;
}

// ---------------------------------------------------------------------------------------------
// Verification — the exit criterion
// ---------------------------------------------------------------------------------------------

export interface Disagreement {
  username: string;
  resourceType: string;
  go: number;
  ts: number;
  missing: string[];
  extra: string[];
  note?: string;
}

export interface VerifyReport {
  usersCompared: string[];
  typesCompared: number;
  agreed: number;
  disagreements: Disagreement[];
  counts: { goUsers: number; tsUsers: number; goSources: number; tsSources: number };
}

/** The Go side's answer, read straight from the tables: per type, the sorted live ids of one user. */
export function readGoIdSets(goDb: GoDb, userId: string): Map<string, string[]> {
  const sets = new Map<string, string[]>();
  const tables = goDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fhir_%' ORDER BY name")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const cols = columnsOf(goDb, name);
    if (!RECORD_COLUMNS.every((c) => cols.has(c))) continue;
    const deleted = cols.has('deleted_at') ? 'AND deleted_at IS NULL' : '';
    const rows = goDb
      .prepare(`SELECT source_resource_type AS t, source_resource_id AS id FROM "${name}" WHERE user_id = ? ${deleted}`)
      .all(userId) as { t: string; id: string }[];
    for (const row of rows) {
      const list = sets.get(row.t) ?? [];
      list.push(row.id);
      sets.set(row.t, list);
    }
  }
  for (const list of sets.values()) list.sort();
  return sets;
}

/** Items of a not matched one-for-one in b — duplicates count, the way the shadow comparison counted them. */
function multisetMissing(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of b) counts.set(id, (counts.get(id) ?? 0) + 1);
  const missing: string[] = [];
  for (const id of a) {
    const n = counts.get(id) ?? 0;
    if (n > 0) counts.set(id, n - 1);
    else missing.push(id);
  }
  return missing;
}

async function compareUser(repo: SqliteFhirRepository, username: string, expected: Map<string, string[]>, report: VerifyReport, note?: string): Promise<void> {
  for (const [resourceType, ids] of expected) {
    report.typesCompared++;
    let actual: string[];
    try {
      // Ask for more than the corpus holds so nothing is truncated — a page-limited comparison is
      // what produced three false disagreements the first time the shadow harness met real data.
      const bundle = await repo.search({ resourceType: resourceType as ResourceType, count: ids.length + 1000 });
      actual = (bundle.entry ?? []).map((e) => e.resource?.id ?? '').sort();
    } catch (err) {
      report.disagreements.push({ username, resourceType, go: ids.length, ts: 0, missing: ids.slice(0, 5), extra: [], note: `${note ?? ''}search threw: ${(err as Error).message}`.trim() });
      continue;
    }
    if (ids.join(',') === actual.join(',')) {
      report.agreed++;
      continue;
    }
    report.disagreements.push({
      username,
      resourceType,
      go: ids.length,
      ts: actual.length,
      missing: multisetMissing(ids, actual).slice(0, 5),
      extra: multisetMissing(actual, ids).slice(0, 5),
      ...(note ? { note } : {}),
    });
  }
  // Types this side holds that the other does not — extra data is a disagreement too.
  const tsTypes = repo.db
    .prepare('SELECT resource_type AS t, COUNT(*) AS n FROM resources WHERE user_id = ? AND deleted = 0 GROUP BY resource_type')
    .all(username) as { t: string; n: number }[];
  for (const { t, n } of tsTypes) {
    if (expected.has(t)) continue;
    report.typesCompared++;
    const extra = repo.db.prepare('SELECT id FROM resources WHERE user_id = ? AND resource_type = ? AND deleted = 0 ORDER BY id LIMIT 5').all(username, t) as { id: string }[];
    report.disagreements.push({ username, resourceType: t, go: 0, ts: n, missing: [], extra: extra.map((r) => r.id), note: `${note ?? ''}type absent on the Go side`.trim() });
  }
}

/**
 * Per user, per type: the sorted id list the Go tables hold versus what this stack's SEARCH path
 * returns — the path the API serves, not a table read. Optionally also against `goAnswers`, the
 * output of the product repo's TestShadowExport, which reads through GormRepository itself and is
 * therefore the stronger witness for what Go actually answers.
 */
export async function verifyAgainstGo(goDb: GoDb, stores: Stores, users: GoUser[], goAnswers?: { username: string; answers: Record<string, string[]> }): Promise<VerifyReport> {
  const report: VerifyReport = {
    usersCompared: users.map((u) => u.username),
    typesCompared: 0,
    agreed: 0,
    disagreements: [],
    counts: {
      goUsers: readGoUserIds(goDb).length,
      tsUsers: (stores.db.prepare('SELECT COUNT(*) AS n FROM auth_users').get() as { n: number }).n,
      goSources: readGoSources(goDb).length,
      tsSources: stores.sources.list().length,
    },
  };
  for (const user of users) {
    await compareUser(stores.repoForUser(user.username), user.username, readGoIdSets(goDb, user.id), report);
  }
  if (goAnswers) {
    const expected = new Map(Object.entries(goAnswers.answers).map(([t, ids]) => [t, [...ids].sort()]));
    await compareUser(stores.repoForUser(goAnswers.username), goAnswers.username, expected, report, 'go-answers: ');
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

export interface MigrationOptions {
  /** Migrate one account only. */
  onlyUser?: string;
  /** The Go instance's data root — where config/app-custom-config.json lives. */
  goDataDir?: string;
  /** Accept catalog URLs the SSRF guard would refuse (loopback sandboxes). Never in production. */
  allowInternalUrls?: boolean;
  /** TestShadowExport output for one account, for the stronger verification. */
  goAnswers?: { username: string; answers: Record<string, string[]> };
  log?: (line: string) => void;
}

export interface MigrationReport {
  users: UserImportReport & { goLive: number };
  catalog: CatalogImportReport;
  sources: SourceImportReport;
  records: RecordImportReport;
  config: ConfigImportReport;
  verify: VerifyReport;
  /** The exit criterion: no disagreement, no record left behind, every selected account present. */
  ok: boolean;
}

export async function migrateFromGo(goDb: GoDb, stores: Stores, options: MigrationOptions = {}): Promise<MigrationReport> {
  const log = options.log ?? ((): void => undefined);

  const liveUsers = readGoUserIds(goDb);
  const selectedUsers = options.onlyUser === undefined ? liveUsers : liveUsers.filter((u) => u.username === options.onlyUser);
  if (options.onlyUser !== undefined && selectedUsers.length === 0) {
    throw new Error(`no live account named ${options.onlyUser} in the Go database`);
  }
  const selected = new Set(selectedUsers.map((u) => u.username));

  log(`users: ${selectedUsers.length} of ${liveUsers.length} live accounts selected`);
  const users = { ...importLegacyUsers(stores.auth, readGoUsers(goDb).filter((u) => selected.has(u.username))), goLive: liveUsers.length };

  log('catalog');
  const catalog = importLegacyCatalog(stores.catalog, readGoCatalog(goDb), { allowInternal: options.allowInternalUrls });

  log('sources');
  const sources = importLegacySources(stores.sources, readGoSources(goDb).filter((s) => selected.has(s.username)));

  log('records');
  const read = newReadStats();
  const usernameById = new Map(liveUsers.map((u) => [u.id, u.username]));
  const records = await importLegacyRecords(readGoRecords(goDb, usernameById, read, options.onlyUser), stores.repoForUser, sources.idMap, read);

  log('config');
  const config = importLegacyConfig(stores.config, options.goDataDir ? readGoCustomConfig(options.goDataDir) : undefined);

  log('verify');
  const verify = await verifyAgainstGo(goDb, stores, selectedUsers, options.goAnswers);

  const ok =
    verify.disagreements.length === 0 &&
    records.rejectedTotal === 0 &&
    users.imported.length + users.skippedExisting.length === selectedUsers.length;

  return { users, catalog, sources, records, config, verify, ok };
}

export function formatReport(r: MigrationReport): string {
  const lines: string[] = [];
  const section = (title: string): void => { lines.push('', title); };

  section('users');
  lines.push(`  imported ${r.users.imported.length}, already present ${r.users.skippedExisting.length} (Go has ${r.users.goLive} live)`);
  if (r.users.admins.length) lines.push(`  Go admins carried as admin here: ${r.users.admins.join(', ')}`);

  section('catalog');
  lines.push(`  imported ${r.catalog.imported.length}, already present ${r.catalog.skippedExisting.length}, rejected ${r.catalog.rejected.length}`);
  for (const x of r.catalog.rejected) lines.push(`    REJECTED ${x.display}: ${x.reason}`);
  lines.push(`  not carried (no counterpart here): ${r.catalog.notCarried.join(', ')}`);

  section('sources');
  lines.push(`  imported ${r.sources.imported.length}, already present ${r.sources.skippedExisting.length}`);
  if (r.sources.needsReconnect.length) lines.push(`  no refresh token — reconnect at first expiry: ${r.sources.needsReconnect.join(', ')}`);

  section('records');
  lines.push(`  imported ${r.records.imported}, already present ${r.records.skippedExisting}, rejected ${r.records.rejectedTotal}`);
  for (const [type, n] of Object.entries(r.records.perType).sort((a, b) => b[1] - a[1])) lines.push(`    ${String(n).padStart(7)}  ${type}`);
  if (r.records.idRewritten) lines.push(`  ${r.records.idRewritten} row(s) whose resource_raw.id differed from source_resource_id — the row's id kept`);
  if (r.records.unmappedSource) lines.push(`  ${r.records.unmappedSource} row(s) from a source that is not live — attributed legacy-<go id>`);
  if (r.records.read.unknownUser) lines.push(`  ${r.records.read.unknownUser} row(s) owned by a non-live account — left behind`);
  if (r.records.read.emptyRaw) lines.push(`  ${r.records.read.emptyRaw} row(s) with empty resource_raw — nothing to carry`);
  if (r.records.read.tablesSkipped.length) lines.push(`  tables without record columns, skipped: ${r.records.read.tablesSkipped.join(', ')}`);
  for (const x of r.records.rejected) lines.push(`    REJECTED ${x.ref}: ${x.reason}`);
  if (r.records.rejectedTotal > r.records.rejected.length) lines.push(`    … and ${r.records.rejectedTotal - r.records.rejected.length} more`);

  section('config');
  if (!r.config.path) lines.push('  no Go data dir given — nothing read');
  else if (r.config.carried.length === 0 && r.config.notCarried.length === 0 && r.config.refused.length === 0) lines.push(`  ${r.config.path}: no custom settings`);
  for (const c of r.config.carried) lines.push(`  ${c.from} -> ${c.to} = ${JSON.stringify(c.value)}`);
  for (const x of r.config.refused) lines.push(`  REFUSED ${x.key}: ${x.reason}`);
  if (r.config.notCarried.length) lines.push(`  not carried (set again by hand if still wanted): ${r.config.notCarried.join(', ')}`);

  section('verify');
  const c = r.verify.counts;
  lines.push(`  accounts: Go ${c.goUsers}, here ${c.tsUsers}; sources: Go ${c.goSources}, here ${c.tsSources}`);
  lines.push(`  ${r.verify.agreed}/${r.verify.typesCompared} (user, resource type) id lists agree across ${r.verify.usersCompared.length} account(s)`);
  if (r.verify.disagreements.length) {
    lines.push(`  ${r.verify.disagreements.length} DISAGREEMENT(S):`);
    for (const d of r.verify.disagreements) {
      lines.push(`    ${d.username} ${d.resourceType}: go=${d.go} ts=${d.ts}` + (d.note ? ` (${d.note})` : ''));
      if (d.missing.length) lines.push(`      missing here: ${d.missing.join(', ')}`);
      if (d.extra.length) lines.push(`      extra here: ${d.extra.join(', ')}`);
    }
  }

  lines.push('', r.ok ? 'MIGRATION VERIFIED — the spike answers what the Go stack holds' : 'MIGRATION NOT VERIFIED — see above; the command is safe to re-run');
  return lines.join('\n');
}
