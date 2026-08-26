import { ApiContext } from '../framework/ApiContext.js';
/** Reads the users table of a Go (GORM) YourPHR database file. */
export function readGoUsers(goDb) {
    const rows = goDb.prepare("SELECT username, password, COALESCE(token_generation, 0) AS token_generation, COALESCE(role, 'user') AS role FROM users WHERE deleted_at IS NULL").all();
    return rows.map((r) => ({ username: String(r['username']), passwordHash: String(r['password']), tokenGeneration: Number(r['token_generation']), role: String(r['role']) }));
}
/** The core set a wildcard grant maps to — the types the record screens actually use. */
export const WILDCARD_RESOURCE_TYPES = [
    'Patient', 'AllergyIntolerance', 'Condition', 'Encounter', 'Immunization',
    'MedicationRequest', 'MedicationStatement', 'Observation', 'Procedure', 'DiagnosticReport', 'DocumentReference',
];
export function resourceTypesFromScopes(scopes) {
    const types = new Set();
    let wildcard = false;
    for (const scope of scopes.split(/\s+/)) {
        const m = scope.match(/^patient\/([A-Za-z]+|\*)\.(read|rs|r)$/);
        if (!m)
            continue;
        if (m[1] === '*') {
            wildcard = true;
        }
        else {
            types.add(m[1]);
        }
    }
    if (wildcard) {
        for (const t of WILDCARD_RESOURCE_TYPES)
            types.add(t);
    }
    return [...types];
}
/**
 * Reads source_credentials from a Go database file, joining users for the username the spike
 * keys on. Soft-deleted rows (either table) are skipped — a disconnected source stays
 * disconnected.
 */
export function readGoSources(goDb) {
    // The Angular app names a source by platform_type when display is empty (manual uploads, the
    // fasten platform), so it is carried (yourphr#594). Read as '' when the column is absent rather
    // than failing — an older Go schema is a legitimate input.
    const hasPlatformType = goDb.pragma('table_info(source_credentials)').some((c) => c.name === 'platform_type');
    const rows = goDb
        .prepare(`SELECT s.id AS id, u.username AS username, s.display AS display, s.api_endpoint_base_url AS base,
              COALESCE(s.client_id, '') AS client_id, COALESCE(s.patient, '') AS patient,
              COALESCE(s.scopes, '') AS scopes, COALESCE(s.access_token, '') AS access_token,
              COALESCE(s.refresh_token, '') AS refresh_token, COALESCE(s.expires_at, 0) AS expires_at,
              COALESCE(s.environment, 'production') AS environment,
              ${hasPlatformType ? "COALESCE(s.platform_type, '')" : "''"} AS platform_type
       FROM source_credentials s JOIN users u ON u.id = s.user_id
       WHERE s.deleted_at IS NULL AND u.deleted_at IS NULL`)
        .all();
    return rows.map((r) => ({
        id: String(r['id']),
        username: String(r['username']),
        display: String(r['display']),
        fhirBaseUrl: String(r['base']),
        clientId: String(r['client_id']),
        patient: String(r['patient']),
        scopes: String(r['scopes']),
        accessToken: String(r['access_token']),
        refreshToken: String(r['refresh_token']),
        expiresAt: Number(r['expires_at']),
        environment: String(r['environment']),
        platformType: String(r['platform_type']),
    }));
}
/**
 * One-way import through the Sources door (yourphr#612), as the migration principal: the Go rows
 * become NewSource values keyed by their Go id; the manager skips what is already held, lands
 * tokens verbatim, and reports what needs a reconnect.
 */
export function importLegacySources(sources, ctx, legacy) {
    return sources.importLegacy(ctx, legacy.map((source) => ({
        legacyId: source.id,
        userId: source.username,
        display: source.display,
        fhirBaseUrl: source.fhirBaseUrl,
        tokenUrl: '', // discovered on first need — the import stays offline
        clientId: source.clientId,
        patient: source.patient,
        resourceTypes: resourceTypesFromScopes(source.scopes),
        accessToken: source.accessToken,
        refreshToken: source.refreshToken,
        expiresAt: source.expiresAt,
        platformType: source.platformType,
        environment: source.environment,
    })));
}
const hasTable = (goDb, name) => goDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
/**
 * Reads, per live user, the legal consent timestamp (a user_settings row) and the access log
 * (access_events buckets). Either table may be absent on an older Go schema — that reads as
 * "nothing recorded", not as a failure. The patient's own audit trail carries whole: Go keeps it
 * indefinitely, so the swap must not be the day it vanished.
 */
export function readGoAccountData(goDb) {
    const users = goDb.prepare('SELECT id, username FROM users WHERE deleted_at IS NULL').all();
    const consent = hasTable(goDb, 'user_settings')
        ? goDb.prepare("SELECT user_id, COALESCE(setting_value_string, '') AS at FROM user_settings WHERE setting_key_name = 'tos_privacy_accepted_at' AND deleted_at IS NULL").all()
        : [];
    const events = hasTable(goDb, 'access_events')
        ? goDb.prepare('SELECT user_id, actor_username, category, day, count, first_at, last_at FROM access_events WHERE deleted_at IS NULL ORDER BY day, category').all()
        : [];
    return users.map((u) => ({
        username: u.username,
        consentAcceptedAt: (consent.find((c) => c.user_id === u.id)?.at ?? '').trim(),
        accessEvents: events.filter((e) => e.user_id === u.id).map(({ user_id: _ignored, ...event }) => ({ ...event, count: Number(event.count) })),
    }));
}
/** One-way, as the migration principal acting for each account: a consent already recorded here is kept; an access bucket already present is kept. */
export async function importLegacyAccountData(users, audit, engine, data) {
    const report = { consentsCarried: [], accessEventsImported: 0, accessEventsSkipped: 0 };
    for (const d of data) {
        const ctx = ApiContext.system('migration', d.username, engine);
        if (d.consentAcceptedAt !== '' && (await users.consentAcceptedAt(ctx)) === '') {
            await users.setConsent(ctx, d.consentAcceptedAt);
            report.consentsCarried.push(d.username);
        }
        const r = await audit.importLegacy(ctx, d.accessEvents);
        report.accessEventsImported += r.imported;
        report.accessEventsSkipped += r.skipped;
    }
    return report;
}
//# sourceMappingURL=index.js.map