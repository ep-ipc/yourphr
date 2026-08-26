/** The provider_catalog table in the app database (yourphr#613). */
import type Database from 'better-sqlite3-multiple-ciphers';
import { BaseCatalogProvider, type CatalogEntry, type CatalogFields, type ProviderEnvironment } from './BaseCatalogProvider.js';

interface Row {
  id: number;
  display: string;
  environment: ProviderEnvironment;
  fhir_base_url: string;
  scopes: string;
  client_id: string;
  client_secret: string;
  enabled: number;
  authorize_url_override: string;
  platform_type: string | null;
  brand_logo_url: string | null;
  consent_policy: string | null;
  pre_connect_profile: string | null;
}

export class SqliteCatalogProvider extends BaseCatalogProvider {
  constructor(private readonly db: InstanceType<typeof Database>) {
    super();
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

  async initialize(): Promise<void> { /* schema ensured in the constructor */ }

  private toEntry(row: Row): CatalogEntry {
    return {
      id: row.id, display: row.display, environment: row.environment, fhirBaseUrl: row.fhir_base_url, scopes: row.scopes,
      clientId: row.client_id, hasClientSecret: row.client_secret !== '', enabled: row.enabled === 1, authorizeUrlOverride: row.authorize_url_override,
      platformType: row.platform_type ?? '', brandLogoUrl: row.brand_logo_url ?? '', consentPolicy: row.consent_policy ?? '', preConnectProfile: row.pre_connect_profile ?? '',
    };
  }

  async create(f: CatalogFields): Promise<CatalogEntry> {
    const info = this.db
      .prepare(`INSERT INTO provider_catalog (display, environment, fhir_base_url, scopes, client_id, client_secret, enabled, authorize_url_override, platform_type, brand_logo_url, consent_policy, pre_connect_profile)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.display, f.environment, f.fhirBaseUrl, f.scopes, f.clientId, f.clientSecret, f.enabled ? 1 : 0, f.authorizeUrlOverride, f.platformType, f.brandLogoUrl, f.consentPolicy, f.preConnectProfile);
    return (await this.byId(Number(info.lastInsertRowid)))!;
  }

  async update(id: number, f: CatalogFields): Promise<CatalogEntry | undefined> {
    const changed = this.db
      .prepare(`UPDATE provider_catalog SET display=?, environment=?, fhir_base_url=?, scopes=?, client_id=?, client_secret=?, enabled=?, authorize_url_override=?, platform_type=?, brand_logo_url=?, consent_policy=?, pre_connect_profile=? WHERE id=?`)
      .run(f.display, f.environment, f.fhirBaseUrl, f.scopes, f.clientId, f.clientSecret, f.enabled ? 1 : 0, f.authorizeUrlOverride, f.platformType, f.brandLogoUrl, f.consentPolicy, f.preConnectProfile, id).changes;
    return changed > 0 ? this.byId(id) : undefined;
  }

  async remove(id: number): Promise<boolean> {
    return this.db.prepare('DELETE FROM provider_catalog WHERE id = ?').run(id).changes > 0;
  }

  async byId(id: number): Promise<CatalogEntry | undefined> {
    const row = this.db.prepare('SELECT * FROM provider_catalog WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toEntry(row) : undefined;
  }

  async byDisplay(display: string): Promise<CatalogEntry | undefined> {
    const row = this.db.prepare('SELECT * FROM provider_catalog WHERE display = ?').get(display) as Row | undefined;
    return row ? this.toEntry(row) : undefined;
  }

  async list(): Promise<CatalogEntry[]> {
    return (this.db.prepare('SELECT * FROM provider_catalog ORDER BY display').all() as Row[]).map((r) => this.toEntry(r));
  }

  async clientSecretFor(id: number): Promise<string> {
    const row = this.db.prepare('SELECT client_secret FROM provider_catalog WHERE id = ?').get(id) as { client_secret: string } | undefined;
    return row?.client_secret ?? '';
  }
}
