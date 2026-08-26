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
import { readGoUsers, readGoSources, importLegacySources, readGoAccountData, importLegacyAccountData } from './index.js';
import { ApiContext } from '../framework/ApiContext.js';
// ---------------------------------------------------------------------------------------------
// The Go database
// ---------------------------------------------------------------------------------------------
/** Opens a Go (GORM) YourPHR database read-only, refusing anything that is not one. */
export function openGoDatabase(path, key) {
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
    }
    catch (err) {
        db.close();
        throw new Error(`${path}: cannot be read (${err.message}) — encrypted with a different key?`);
    }
    if (!hasUsers) {
        db.close();
        throw new Error(`${path}: no users table — not a YourPHR database`);
    }
    return db;
}
function tableExists(db, name) {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function columnsOf(db, table) {
    const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all();
    return new Set(rows.map((r) => r.name));
}
/** Live (not soft-deleted) accounts, id and name — the join key every other table uses. */
export function readGoUserIds(goDb) {
    return goDb.prepare('SELECT id, username FROM users WHERE deleted_at IS NULL ORDER BY username').all();
}
// ---------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------
/** Go catalog columns with no counterpart here. Reported, never silently dropped. */
/** Once the four Go-only columns; carried since yourphr#603. Kept (empty) so the report can say so. */
export const CATALOG_FIELDS_NOT_CARRIED = [];
export function readGoCatalog(goDb) {
    if (!tableExists(goDb, 'provider_catalog_entries')) {
        return [];
    }
    const rows = goDb.prepare('SELECT * FROM provider_catalog_entries WHERE deleted_at IS NULL ORDER BY display').all();
    const str = (r, k) => (r[k] === null || r[k] === undefined ? '' : String(r[k]));
    return rows.map((r) => ({
        display: str(r, 'display'),
        environment: str(r, 'environment') || 'production',
        fhirBaseUrl: str(r, 'api_endpoint_base_url'),
        scopes: str(r, 'scopes'),
        clientId: str(r, 'client_id'),
        clientSecret: str(r, 'client_secret'),
        enabled: r['enabled'] === 1 || r['enabled'] === true || r['enabled'] === 'true' || r['enabled'] === '1',
        authorizeUrlOverride: str(r, 'authorize_url_override'),
        platformType: str(r, 'platform_type'),
        brandLogoUrl: str(r, 'brand_logo_url'),
        consentPolicy: str(r, 'consent_policy'),
        preConnectProfile: str(r, 'pre_connect_profile'),
    }));
}
/** One-way by display name through the Catalog door, as the migration principal; an operator's existing entry is never touched. */
export async function importLegacyCatalog(catalog, ctx, entries, options = {}) {
    const writes = entries.map((e) => ({
        display: e.display,
        environment: e.environment,
        fhirBaseUrl: e.fhirBaseUrl,
        scopes: e.scopes,
        clientId: e.clientId,
        clientSecret: e.clientSecret,
        enabled: e.enabled,
        authorizeUrlOverride: e.authorizeUrlOverride,
        platformType: e.platformType,
        brandLogoUrl: e.brandLogoUrl,
        consentPolicy: e.consentPolicy,
        preConnectProfile: e.preConnectProfile,
    }));
    return { ...(await catalog.importLegacy(ctx, writes, { allowInternal: options.allowInternal })), notCarried: CATALOG_FIELDS_NOT_CARRIED };
}
export function newReadStats() {
    return { tablesRead: 0, tablesSkipped: [], unknownUser: 0, emptyRaw: 0 };
}
const RECORD_COLUMNS = ['user_id', 'source_id', 'source_resource_type', 'source_resource_id', 'resource_raw'];
/**
 * Streams every live row of every fhir_* table. resource_raw is handed on UNPARSED — the same
 * property the whole spike rests on (export-resources.ts): nothing is reinterpreted on the way.
 */
export function* readGoRecords(goDb, usernameById, stats, onlyUser) {
    const tables = goDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fhir_%' ORDER BY name")
        .all();
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
        const rows = stmt.iterate();
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
const REJECTIONS_KEPT = 20;
export async function importLegacyRecords(records, engine, recordsManager, sourceIdMap, read) {
    const report = { imported: 0, skippedExisting: 0, rejected: [], rejectedTotal: 0, unmappedSource: 0, idRewritten: 0, perType: {}, read };
    const reject = (ref, reason) => {
        report.rejectedTotal++;
        if (report.rejected.length < REJECTIONS_KEPT)
            report.rejected.push({ ref, reason });
    };
    for (const r of records) {
        const ref = `${r.username} ${r.resourceType}/${r.resourceId}`;
        let resource;
        try {
            resource = JSON.parse(r.raw);
        }
        catch (err) {
            reject(ref, `resource_raw is not JSON: ${err.message}`);
            continue;
        }
        if (!resource || typeof resource !== 'object' || resource.resourceType !== r.resourceType) {
            reject(ref, `resource_raw says resourceType ${resource?.resourceType ?? 'none'}, the row says ${r.resourceType}`);
            continue;
        }
        if (resource.id !== r.resourceId) {
            report.idRewritten++;
            resource = { ...resource, id: r.resourceId };
        }
        // Through the door (yourphr#609): the migration is a named system principal acting for the
        // account, so every imported row met the index, the audit and the collision check.
        const ctx = ApiContext.system('migration', r.username, engine);
        if (await recordsManager.exists(ctx, r.resourceType, r.resourceId)) {
            report.skippedExisting++;
            continue;
        }
        const mapped = sourceIdMap[r.goSourceId];
        if (mapped === undefined)
            report.unmappedSource++;
        const sourceId = mapped === undefined ? `legacy-${r.goSourceId}` : `source-${mapped}`;
        try {
            await recordsManager.writer(ctx, sourceId).upsert(resource);
            report.imported++;
            report.perType[r.resourceType] = (report.perType[r.resourceType] ?? 0) + 1;
        }
        catch (err) {
            reject(ref, err.message);
        }
    }
    return report;
}
/**
 * The only Go settings with a counterpart here. Everything else in the Go overlay is reported as
 * not carried — listed by name, so the operator can see what they will be setting again.
 */
// `go:` names are the GO stack's keys and are NOT ours to rename — they are read out of a database
// this build did not write. Only the `ts:` side moved to the yourphr.* convention (yourphr#627).
export const CONFIG_TRANSLATIONS = [
    { go: 'backup.max-backups', ts: 'yourphr.backup.max-backups', convert: (v) => Number(v), note: 'same meaning' },
    { go: 'backup.destination', ts: 'yourphr.backup.destination', convert: (v) => String(v), note: 'same meaning' },
    { go: 'jwt.session_ttl_minutes', ts: 'yourphr.auth.session.sliding-seconds', convert: (v) => Number(v) * 60, note: 'minutes -> seconds' },
    { go: 'jwt.session_absolute_hours', ts: 'yourphr.auth.session.absolute-seconds', convert: (v) => Number(v) * 3600, note: 'hours -> seconds' },
    { go: 'operator.name', ts: 'yourphr.operator.name', convert: (v) => String(v), note: 'same meaning (yourphr#593)' },
    { go: 'operator.contact_email', ts: 'yourphr.operator.contact-email', convert: (v) => String(v), note: 'same meaning (yourphr#593)' },
    { go: 'operator.contact_url', ts: 'yourphr.operator.contact-url', convert: (v) => String(v), note: 'same meaning (yourphr#593)' },
];
/** Reads <go data dir>/config/app-custom-config.json, flat dotted (post-#456) or nested (older). */
export function readGoCustomConfig(goDataDir) {
    const path = join(goDataDir, 'config', 'app-custom-config.json');
    if (!existsSync(path)) {
        return { path, values: undefined };
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { path, values: flattenConfig(parsed) };
}
function flattenConfig(values, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(values)) {
        if (key.startsWith('_comment'))
            continue;
        const full = prefix === '' ? key : `${prefix}.${key}`;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            flattenConfig(value, full, out);
        }
        else {
            out[full] = value;
        }
    }
    return out;
}
export function importLegacyConfig(config, goConfig) {
    const report = { path: goConfig?.path, carried: [], refused: [], notCarried: [] };
    const values = goConfig?.values;
    if (!values) {
        return report;
    }
    const translated = new Set();
    for (const t of CONFIG_TRANSLATIONS) {
        if (!(t.go in values))
            continue;
        translated.add(t.go);
        let value;
        try {
            value = t.convert(values[t.go]);
            if (typeof value === 'number' && !Number.isFinite(value)) {
                throw new Error(`${t.go} = ${JSON.stringify(values[t.go])} is not a number`);
            }
            config.set(t.ts, value);
            report.carried.push({ from: t.go, to: t.ts, value });
        }
        catch (err) {
            report.refused.push({ key: t.go, reason: err.message });
        }
    }
    report.notCarried = Object.keys(values).filter((k) => !translated.has(k)).sort();
    return report;
}
/** The Go side's answer, read straight from the tables: per type, the sorted live ids of one user. */
export function readGoIdSets(goDb, userId) {
    const sets = new Map();
    const tables = goDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fhir_%' ORDER BY name")
        .all();
    for (const { name } of tables) {
        const cols = columnsOf(goDb, name);
        if (!RECORD_COLUMNS.every((c) => cols.has(c)))
            continue;
        const deleted = cols.has('deleted_at') ? 'AND deleted_at IS NULL' : '';
        const rows = goDb
            .prepare(`SELECT source_resource_type AS t, source_resource_id AS id FROM "${name}" WHERE user_id = ? ${deleted}`)
            .all(userId);
        for (const row of rows) {
            const list = sets.get(row.t) ?? [];
            list.push(row.id);
            sets.set(row.t, list);
        }
    }
    for (const list of sets.values())
        list.sort();
    return sets;
}
/** Items of a not matched one-for-one in b — duplicates count, the way the shadow comparison counted them. */
function multisetMissing(a, b) {
    const counts = new Map();
    for (const id of b)
        counts.set(id, (counts.get(id) ?? 0) + 1);
    const missing = [];
    for (const id of a) {
        const n = counts.get(id) ?? 0;
        if (n > 0)
            counts.set(id, n - 1);
        else
            missing.push(id);
    }
    return missing;
}
async function compareUser(provider, username, expected, report, note) {
    for (const [resourceType, ids] of expected) {
        report.typesCompared++;
        let actual;
        try {
            // Ask for more than the corpus holds so nothing is truncated — a page-limited comparison is
            // what produced three false disagreements the first time the shadow harness met real data.
            const bundle = await provider.search(username, { resourceType: resourceType, count: ids.length + 1000 });
            actual = (bundle.entry ?? []).map((e) => e.resource?.id ?? '').sort();
        }
        catch (err) {
            report.disagreements.push({ username, resourceType, go: ids.length, ts: 0, missing: ids.slice(0, 5), extra: [], note: `${note ?? ''}search threw: ${err.message}`.trim() });
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
    // The witness reads the provider directly — below the manager it checks, on purpose.
    for (const { resourceType: t, count: n } of await provider.countByType(username)) {
        if (expected.has(t))
            continue;
        report.typesCompared++;
        const extra = (await provider.list(username, { resourceType: t })).slice(0, 5).map((r) => r.id);
        report.disagreements.push({ username, resourceType: t, go: 0, ts: n, missing: [], extra, note: `${note ?? ''}type absent on the Go side`.trim() });
    }
}
/**
 * Per user, per type: the sorted id list the Go tables hold versus what this stack's SEARCH path
 * returns — the path the API serves, not a table read. Optionally also against `goAnswers`, the
 * output of the product repo's TestShadowExport, which reads through GormRepository itself and is
 * therefore the stronger witness for what Go actually answers.
 */
export async function verifyAgainstGo(goDb, stores, users, goAnswers) {
    const report = {
        usersCompared: users.map((u) => u.username),
        typesCompared: 0,
        agreed: 0,
        disagreements: [],
        counts: {
            goUsers: readGoUserIds(goDb).length,
            tsUsers: await stores.users.count(ApiContext.system('migration', 'migration', stores.engine)),
            goSources: readGoSources(goDb).length,
            tsSources: await stores.sources.count(),
        },
    };
    for (const user of users) {
        await compareUser(stores.recordsProvider, user.username, readGoIdSets(goDb, user.id), report);
    }
    if (goAnswers) {
        const expected = new Map(Object.entries(goAnswers.answers).map(([t, ids]) => [t, [...ids].sort()]));
        await compareUser(stores.recordsProvider, goAnswers.username, expected, report, 'go-answers: ');
    }
    return report;
}
export async function migrateFromGo(goDb, stores, options = {}) {
    const log = options.log ?? (() => undefined);
    const liveUsers = readGoUserIds(goDb);
    const selectedUsers = options.onlyUser === undefined ? liveUsers : liveUsers.filter((u) => u.username === options.onlyUser);
    if (options.onlyUser !== undefined && selectedUsers.length === 0) {
        throw new Error(`no live account named ${options.onlyUser} in the Go database`);
    }
    const selected = new Set(selectedUsers.map((u) => u.username));
    log(`users: ${selectedUsers.length} of ${liveUsers.length} live accounts selected`);
    const users = { ...(await stores.users.importLegacy(ApiContext.system('migration', '', stores.engine), readGoUsers(goDb).filter((u) => selected.has(u.username)))), goLive: liveUsers.length };
    log('account data (legal consent, access log)');
    const account = await importLegacyAccountData(stores.users, stores.audit, stores.engine, readGoAccountData(goDb).filter((d) => selected.has(d.username)));
    const migrationCtx = ApiContext.system('migration', 'migration', stores.engine);
    log('catalog');
    const catalog = await importLegacyCatalog(stores.catalog, migrationCtx, readGoCatalog(goDb), { allowInternal: options.allowInternalUrls });
    log('sources');
    const sources = await importLegacySources(stores.sources, migrationCtx, readGoSources(goDb).filter((s) => selected.has(s.username)));
    log('records');
    const read = newReadStats();
    const usernameById = new Map(liveUsers.map((u) => [u.id, u.username]));
    const records = await importLegacyRecords(readGoRecords(goDb, usernameById, read, options.onlyUser), stores.engine, stores.records, sources.idMap, read);
    log('config');
    const config = importLegacyConfig(stores.config, options.goDataDir ? readGoCustomConfig(options.goDataDir) : undefined);
    log('verify');
    const verify = await verifyAgainstGo(goDb, stores, selectedUsers, options.goAnswers);
    const ok = verify.disagreements.length === 0 &&
        records.rejectedTotal === 0 &&
        users.imported.length + users.skippedExisting.length === selectedUsers.length;
    return { users, account, catalog, sources, records, config, verify, ok };
}
export function formatReport(r) {
    const lines = [];
    const section = (title) => { lines.push('', title); };
    section('users');
    lines.push(`  imported ${r.users.imported.length}, already present ${r.users.skippedExisting.length} (Go has ${r.users.goLive} live)`);
    if (r.users.admins.length)
        lines.push(`  Go admins carried as admin here: ${r.users.admins.join(', ')}`);
    lines.push(`  legal consent carried for ${r.account.consentsCarried.length} account(s); access log buckets imported ${r.account.accessEventsImported}, already present ${r.account.accessEventsSkipped}`);
    section('catalog');
    lines.push(`  imported ${r.catalog.imported.length}, already present ${r.catalog.skippedExisting.length}, rejected ${r.catalog.rejected.length}`);
    for (const x of r.catalog.rejected)
        lines.push(`    REJECTED ${x.display}: ${x.reason}`);
    if (r.catalog.notCarried.length)
        lines.push(`  not carried (no counterpart here): ${r.catalog.notCarried.join(', ')}`);
    section('sources');
    lines.push(`  imported ${r.sources.imported.length}, already present ${r.sources.skippedExisting.length}`);
    if (r.sources.needsReconnect.length)
        lines.push(`  no refresh token — reconnect at first expiry: ${r.sources.needsReconnect.join(', ')}`);
    section('records');
    lines.push(`  imported ${r.records.imported}, already present ${r.records.skippedExisting}, rejected ${r.records.rejectedTotal}`);
    for (const [type, n] of Object.entries(r.records.perType).sort((a, b) => b[1] - a[1]))
        lines.push(`    ${String(n).padStart(7)}  ${type}`);
    if (r.records.idRewritten)
        lines.push(`  ${r.records.idRewritten} row(s) whose resource_raw.id differed from source_resource_id — the row's id kept`);
    if (r.records.unmappedSource)
        lines.push(`  ${r.records.unmappedSource} row(s) from a source that is not live — attributed legacy-<go id>`);
    if (r.records.read.unknownUser)
        lines.push(`  ${r.records.read.unknownUser} row(s) owned by a non-live account — left behind`);
    if (r.records.read.emptyRaw)
        lines.push(`  ${r.records.read.emptyRaw} row(s) with empty resource_raw — nothing to carry`);
    if (r.records.read.tablesSkipped.length)
        lines.push(`  tables without record columns, skipped: ${r.records.read.tablesSkipped.join(', ')}`);
    for (const x of r.records.rejected)
        lines.push(`    REJECTED ${x.ref}: ${x.reason}`);
    if (r.records.rejectedTotal > r.records.rejected.length)
        lines.push(`    … and ${r.records.rejectedTotal - r.records.rejected.length} more`);
    section('config');
    if (!r.config.path)
        lines.push('  no Go data dir given — nothing read');
    else if (r.config.carried.length === 0 && r.config.notCarried.length === 0 && r.config.refused.length === 0)
        lines.push(`  ${r.config.path}: no custom settings`);
    for (const c of r.config.carried)
        lines.push(`  ${c.from} -> ${c.to} = ${JSON.stringify(c.value)}`);
    for (const x of r.config.refused)
        lines.push(`  REFUSED ${x.key}: ${x.reason}`);
    if (r.config.notCarried.length)
        lines.push(`  not carried (set again by hand if still wanted): ${r.config.notCarried.join(', ')}`);
    section('verify');
    const c = r.verify.counts;
    lines.push(`  accounts: Go ${c.goUsers}, here ${c.tsUsers}; sources: Go ${c.goSources}, here ${c.tsSources}`);
    lines.push(`  ${r.verify.agreed}/${r.verify.typesCompared} (user, resource type) id lists agree across ${r.verify.usersCompared.length} account(s)`);
    if (r.verify.disagreements.length) {
        lines.push(`  ${r.verify.disagreements.length} DISAGREEMENT(S):`);
        for (const d of r.verify.disagreements) {
            lines.push(`    ${d.username} ${d.resourceType}: go=${d.go} ts=${d.ts}` + (d.note ? ` (${d.note})` : ''));
            if (d.missing.length)
                lines.push(`      missing here: ${d.missing.join(', ')}`);
            if (d.extra.length)
                lines.push(`      extra here: ${d.extra.join(', ')}`);
        }
    }
    lines.push('', r.ok ? 'MIGRATION VERIFIED — the spike answers what the Go stack holds' : 'MIGRATION NOT VERIFIED — see above; the command is safe to re-run');
    return lines.join('\n');
}
//# sourceMappingURL=tool.js.map