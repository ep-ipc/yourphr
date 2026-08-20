/**
 * The provider catalog — which providers this instance can connect to, and the credentials that
 * take (yourphr#542 Phase 4). Every rule here is one the Go stack already paid for:
 *
 *   - client_secret is WRITE-ONLY (yourphr#286): accepted on create/update, preserved when an
 *     update omits it, and never serialized out — list() reports hasClientSecret instead. A secret
 *     that round-trips to a browser is a secret that ends up in a HAR file.
 *   - Seeding is PROVISION-THEN-PRESERVE (yourphr#291/#304): a seed fills an empty row and never
 *     clobbers an operator's edit, so "restart the app" can never undo the admin screen.
 *   - Sandbox entries never reach patients (environment filter) — connectable() returns enabled
 *     PRODUCTION entries only.
 *   - Every URL is validated at WRITE time with the same SSRF rules the sync path enforces at dial
 *     time (yourphr#485's argument): an entry that would be refused when it syncs should be refused
 *     when it is typed, and a production entry must be https.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { validateUrl } from '../http/index.js';

export type ProviderEnvironment = 'sandbox' | 'production';

export interface CatalogEntry {
  id: number;
  display: string;
  environment: ProviderEnvironment;
  fhirBaseUrl: string;
  scopes: string;
  clientId: string;
  hasClientSecret: boolean;
  enabled: boolean;
  authorizeUrlOverride: string;
}

export interface CatalogWrite {
  display: string;
  environment: ProviderEnvironment;
  fhirBaseUrl: string;
  scopes: string;
  clientId?: string;
  /** Write-only. Omitted or '' on update preserves the stored secret. */
  clientSecret?: string;
  enabled?: boolean;
  authorizeUrlOverride?: string;
  /** Tests only — lets loopback fakes into the catalog. */
  allowInternal?: boolean;
}

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
}

function checkUrls(write: CatalogWrite): void {
  const allowInternal = write.allowInternal ?? false;
  for (const [field, value] of [['fhirBaseUrl', write.fhirBaseUrl], ['authorizeUrlOverride', write.authorizeUrlOverride ?? '']] as const) {
    if (value === '' && field === 'authorizeUrlOverride') {
      continue;
    }
    const checked = validateUrl(value, allowInternal);
    if (!checked.ok) {
      throw new Error(`${field} rejected: ${checked.reason}`);
    }
    if (write.environment === 'production' && checked.url.protocol !== 'https:') {
      throw new Error(`${field} must be https for a production provider`);
    }
  }
}

export class ProviderCatalog {
  constructor(private readonly db: InstanceType<typeof Database>) {
    db.exec(`CREATE TABLE IF NOT EXISTS provider_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display TEXT NOT NULL UNIQUE,
      environment TEXT NOT NULL,
      fhir_base_url TEXT NOT NULL,
      scopes TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      client_secret TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      authorize_url_override TEXT NOT NULL DEFAULT ''
    )`);
  }

  private toEntry(row: Row): CatalogEntry {
    return {
      id: row.id,
      display: row.display,
      environment: row.environment,
      fhirBaseUrl: row.fhir_base_url,
      scopes: row.scopes,
      clientId: row.client_id,
      hasClientSecret: row.client_secret !== '',
      enabled: row.enabled === 1,
      authorizeUrlOverride: row.authorize_url_override,
    };
  }

  create(write: CatalogWrite): CatalogEntry {
    checkUrls(write);
    const info = this.db
      .prepare(
        `INSERT INTO provider_catalog (display, environment, fhir_base_url, scopes, client_id, client_secret, enabled, authorize_url_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        write.display, write.environment, write.fhirBaseUrl, write.scopes,
        write.clientId ?? '', write.clientSecret ?? '', write.enabled ? 1 : 0, write.authorizeUrlOverride ?? ''
      );
    return this.byId(Number(info.lastInsertRowid))!;
  }

  update(id: number, write: CatalogWrite): CatalogEntry {
    checkUrls(write);
    const existing = this.db.prepare('SELECT * FROM provider_catalog WHERE id = ?').get(id) as Row | undefined;
    if (!existing) {
      throw new Error(`no catalog entry ${id}`);
    }
    // The write-only secret rule (yourphr#286): omitted/empty keeps the stored one.
    const secret = write.clientSecret && write.clientSecret !== '' ? write.clientSecret : existing.client_secret;
    this.db
      .prepare(
        `UPDATE provider_catalog SET display=?, environment=?, fhir_base_url=?, scopes=?, client_id=?, client_secret=?, enabled=?, authorize_url_override=? WHERE id=?`
      )
      .run(
        write.display, write.environment, write.fhirBaseUrl, write.scopes,
        write.clientId ?? existing.client_id, secret, (write.enabled ?? existing.enabled === 1) ? 1 : 0,
        write.authorizeUrlOverride ?? existing.authorize_url_override, id
      );
    return this.byId(id)!;
  }

  byId(id: number): CatalogEntry | undefined {
    const row = this.db.prepare('SELECT * FROM provider_catalog WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toEntry(row) : undefined;
  }

  /** The secret, for the SERVER-SIDE token exchange only. Never appears on a CatalogEntry. */
  clientSecretFor(id: number): string {
    const row = this.db.prepare('SELECT client_secret FROM provider_catalog WHERE id = ?').get(id) as { client_secret: string } | undefined;
    return row?.client_secret ?? '';
  }

  list(): CatalogEntry[] {
    return (this.db.prepare('SELECT * FROM provider_catalog ORDER BY display').all() as Row[]).map((r) => this.toEntry(r));
  }

  /** What patients may connect to: enabled PRODUCTION entries only — sandboxes are admin-only. */
  connectable(): CatalogEntry[] {
    return this.list().filter((e) => e.enabled && e.environment === 'production');
  }

  /**
   * Provision-then-preserve seeding (yourphr#291/#304): creates a missing entry, fills credentials
   * into a row that has none, and NEVER overwrites an operator's edits. Idempotent — safe at every
   * startup.
   */
  seed(seeds: CatalogWrite[]): void {
    for (const s of seeds) {
      const existing = this.db.prepare('SELECT * FROM provider_catalog WHERE display = ?').get(s.display) as Row | undefined;
      if (!existing) {
        this.create(s);
        continue;
      }
      if (existing.client_id === '' && (s.clientId ?? '') !== '') {
        this.db
          .prepare('UPDATE provider_catalog SET client_id = ?, client_secret = ?, enabled = ? WHERE id = ?')
          .run(s.clientId, s.clientSecret ?? existing.client_secret, s.enabled ? 1 : existing.enabled, existing.id);
      }
    }
  }
}
