import { BaseSourcesProvider } from './BaseSourcesProvider.js';
export class SqliteSourcesProvider extends BaseSourcesProvider {
    db;
    constructor(db) {
        super();
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS connected_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      display TEXT NOT NULL,
      fhir_base_url TEXT NOT NULL,
      token_url TEXT NOT NULL,
      client_id TEXT NOT NULL,
      patient TEXT NOT NULL,
      resource_types TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL DEFAULT '',
      expires_at INTEGER NOT NULL DEFAULT 0,
      platform_type TEXT NOT NULL DEFAULT '',
      environment TEXT NOT NULL DEFAULT '',
      last_sync_at INTEGER NOT NULL DEFAULT 0
    )`);
        db.exec(`CREATE TABLE IF NOT EXISTS dynamic_clients (
      source_id INTEGER PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL DEFAULT '',
      registration_access_token TEXT NOT NULL DEFAULT '',
      registration_client_uri TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL
    )`);
    }
    async initialize() { }
    toSource(r) {
        return {
            id: r['id'], userId: r['user_id'], display: r['display'], fhirBaseUrl: r['fhir_base_url'],
            tokenUrl: r['token_url'], clientId: r['client_id'], patient: r['patient'],
            resourceTypes: r['resource_types'].split(',').filter(Boolean), accessToken: r['access_token'],
            refreshToken: r['refresh_token'], expiresAt: r['expires_at'], lastSyncAt: r['last_sync_at'],
            platformType: r['platform_type'] ?? '', environment: r['environment'] ?? '',
        };
    }
    async add(source) {
        const info = this.db
            .prepare(`INSERT INTO connected_sources (user_id, display, fhir_base_url, token_url, client_id, patient, resource_types, access_token, refresh_token, expires_at, platform_type, environment)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(source.userId, source.display, source.fhirBaseUrl, source.tokenUrl, source.clientId, source.patient, source.resourceTypes.join(','), source.accessToken, source.refreshToken, source.expiresAt, source.platformType ?? '', source.environment ?? '');
        return (await this.byId(Number(info.lastInsertRowid)));
    }
    async byId(id) {
        const r = this.db.prepare('SELECT * FROM connected_sources WHERE id = ?').get(id);
        return r ? this.toSource(r) : undefined;
    }
    async list() {
        return this.db.prepare('SELECT * FROM connected_sources ORDER BY id').all().map((r) => this.toSource(r));
    }
    async count() {
        return this.db.prepare('SELECT COUNT(*) AS n FROM connected_sources').get().n;
    }
    async clearTokens(id) {
        this.db.prepare("UPDATE connected_sources SET access_token = '', refresh_token = '', expires_at = 0 WHERE id = ?").run(id);
    }
    async updateTokenUrl(id, tokenUrl) {
        this.db.prepare('UPDATE connected_sources SET token_url = ? WHERE id = ?').run(tokenUrl, id);
    }
    async updateTokens(id, accessToken, refreshToken, expiresAt) {
        this.db.prepare('UPDATE connected_sources SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?').run(accessToken, refreshToken, expiresAt, id);
    }
    async markSynced(id, at) {
        this.db.prepare('UPDATE connected_sources SET last_sync_at = ? WHERE id = ?').run(at, id);
    }
    async remove(id) {
        this.db.prepare('DELETE FROM dynamic_clients WHERE source_id = ?').run(id);
        this.db.prepare('DELETE FROM connected_sources WHERE id = ?').run(id);
    }
    async saveDynamicClient(sourceId, client) {
        this.db
            .prepare(`INSERT INTO dynamic_clients (source_id, client_id, client_secret, registration_access_token, registration_client_uri, registered_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id) DO UPDATE SET client_id=excluded.client_id, client_secret=excluded.client_secret,
                  registration_access_token=excluded.registration_access_token, registration_client_uri=excluded.registration_client_uri, registered_at=excluded.registered_at`)
            .run(sourceId, client.clientId, client.clientSecret, client.registrationAccessToken, client.registrationClientUri, new Date().toISOString());
    }
    async dynamicClientFor(sourceId) {
        const row = this.db.prepare('SELECT * FROM dynamic_clients WHERE source_id = ?').get(sourceId);
        return row ? { clientId: row['client_id'] ?? '', clientSecret: row['client_secret'] ?? '', registrationAccessToken: row['registration_access_token'] ?? '', registrationClientUri: row['registration_client_uri'] ?? '' } : undefined;
    }
}
//# sourceMappingURL=SqliteSourcesProvider.js.map