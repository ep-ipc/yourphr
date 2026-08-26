import { BaseCatalogProvider } from './BaseCatalogProvider.js';
export class SqliteCatalogProvider extends BaseCatalogProvider {
    db;
    constructor(db) {
        super();
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS provider_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display TEXT NOT NULL UNIQUE,
      environment TEXT NOT NULL,
      fhir_base_url TEXT NOT NULL,
      scopes TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      client_secret TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      authorize_url_override TEXT NOT NULL DEFAULT '',
      platform_type TEXT NOT NULL DEFAULT '',
      brand_logo_url TEXT NOT NULL DEFAULT '',
      consent_policy TEXT NOT NULL DEFAULT '',
      pre_connect_profile TEXT NOT NULL DEFAULT ''
    )`);
    }
    async initialize() { }
    toEntry(row) {
        return {
            id: row.id, display: row.display, environment: row.environment, fhirBaseUrl: row.fhir_base_url, scopes: row.scopes,
            clientId: row.client_id, hasClientSecret: row.client_secret !== '', enabled: row.enabled === 1, authorizeUrlOverride: row.authorize_url_override,
            platformType: row.platform_type ?? '', brandLogoUrl: row.brand_logo_url ?? '', consentPolicy: row.consent_policy ?? '', preConnectProfile: row.pre_connect_profile ?? '',
        };
    }
    async create(f) {
        const info = this.db
            .prepare(`INSERT INTO provider_catalog (display, environment, fhir_base_url, scopes, client_id, client_secret, enabled, authorize_url_override, platform_type, brand_logo_url, consent_policy, pre_connect_profile)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(f.display, f.environment, f.fhirBaseUrl, f.scopes, f.clientId, f.clientSecret, f.enabled ? 1 : 0, f.authorizeUrlOverride, f.platformType, f.brandLogoUrl, f.consentPolicy, f.preConnectProfile);
        return (await this.byId(Number(info.lastInsertRowid)));
    }
    async update(id, f) {
        const changed = this.db
            .prepare(`UPDATE provider_catalog SET display=?, environment=?, fhir_base_url=?, scopes=?, client_id=?, client_secret=?, enabled=?, authorize_url_override=?, platform_type=?, brand_logo_url=?, consent_policy=?, pre_connect_profile=? WHERE id=?`)
            .run(f.display, f.environment, f.fhirBaseUrl, f.scopes, f.clientId, f.clientSecret, f.enabled ? 1 : 0, f.authorizeUrlOverride, f.platformType, f.brandLogoUrl, f.consentPolicy, f.preConnectProfile, id).changes;
        return changed > 0 ? this.byId(id) : undefined;
    }
    async remove(id) {
        return this.db.prepare('DELETE FROM provider_catalog WHERE id = ?').run(id).changes > 0;
    }
    async byId(id) {
        const row = this.db.prepare('SELECT * FROM provider_catalog WHERE id = ?').get(id);
        return row ? this.toEntry(row) : undefined;
    }
    async byDisplay(display) {
        const row = this.db.prepare('SELECT * FROM provider_catalog WHERE display = ?').get(display);
        return row ? this.toEntry(row) : undefined;
    }
    async list() {
        return this.db.prepare('SELECT * FROM provider_catalog ORDER BY display').all().map((r) => this.toEntry(r));
    }
    async clientSecretFor(id) {
        const row = this.db.prepare('SELECT client_secret FROM provider_catalog WHERE id = ?').get(id);
        return row?.client_secret ?? '';
    }
}
//# sourceMappingURL=SqliteCatalogProvider.js.map