/**
 * The account's own records (yourphr#596): legal consent and the patient-visible access log —
 * two of Go's non-FHIR tables, kept per user in the app database.
 *
 * Legal consent (Go's user setting `tos_privacy_accepted_at`): when the person actively accepted
 * the Privacy Policy and Terms, RFC3339 UTC; '' = revoked or never. Revoking also disconnects the
 * sources that required it (Medicare) — the caller does that, this store only remembers.
 *
 * Access log (the product's #563): who accessed which category of a person's records on which day,
 * aggregated per (owner, actor, category, day) with a count and first/last times — the row shape
 * Go keeps, so "who has looked at my record" is answerable and the table stays bounded. Deliberately
 * no IP address and no user agent (the #507/#512 stance). Retention indefinite; deleting the account
 * deletes them with everything else.
 */
import type Database from 'better-sqlite3-multiple-ciphers';

export interface AccessEvent {
  actor_username: string;
  category: string;
  day: string;
  count: number;
  first_at: string;
  last_at: string;
}

export class AccountStore {
  constructor(private readonly db: InstanceType<typeof Database>) {
    db.exec(`CREATE TABLE IF NOT EXISTS legal_consent (
      user_id TEXT PRIMARY KEY,
      accepted_at TEXT NOT NULL DEFAULT ''
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS access_events (
      user_id TEXT NOT NULL,
      actor_username TEXT NOT NULL,
      category TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (user_id, actor_username, category, day)
    )`);
  }

  consentAcceptedAt(userId: string): string {
    const row = this.db.prepare('SELECT accepted_at FROM legal_consent WHERE user_id = ?').get(userId) as { accepted_at: string } | undefined;
    return (row?.accepted_at ?? '').trim();
  }

  setConsentAcceptedAt(userId: string, acceptedAt: string): void {
    this.db
      .prepare('INSERT INTO legal_consent (user_id, accepted_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET accepted_at = excluded.accepted_at')
      .run(userId, acceptedAt);
  }

  /** One access, folded into its (actor, category, day) bucket. */
  recordAccess(userId: string, actor: string, category: string, at = new Date()): void {
    const iso = at.toISOString();
    const day = iso.slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO access_events (user_id, actor_username, category, day, count, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(user_id, actor_username, category, day) DO UPDATE SET count = count + 1, last_at = excluded.last_at`
      )
      .run(userId, actor, category, day, iso, iso);
  }

  /** Carries a bucket as it was recorded elsewhere (the migration); an existing bucket is kept. */
  importAccessEvent(userId: string, event: AccessEvent): boolean {
    return this.db
      .prepare('INSERT OR IGNORE INTO access_events (user_id, actor_username, category, day, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, event.actor_username, event.category, event.day, event.count, event.first_at, event.last_at).changes > 0;
  }

  /** The complete log, newest day first — unfiltered, unedited. */
  listAccess(userId: string): AccessEvent[] {
    return this.db
      .prepare('SELECT actor_username, category, day, count, first_at, last_at FROM access_events WHERE user_id = ? ORDER BY day DESC, last_at DESC, category')
      .all(userId) as AccessEvent[];
  }

  deleteUser(userId: string): void {
    this.db.prepare('DELETE FROM legal_consent WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM access_events WHERE user_id = ?').run(userId);
  }
}

/** Go's rule for which providers need the legal consent before connecting: the Medicare family. */
export function providerRequiresLegalConsent(display: string, fhirBaseUrl: string, platformType: string): boolean {
  const blob = `${display}\n${fhirBaseUrl}\n${platformType}`.toLowerCase();
  return ['medicare', 'blue button', 'bluebutton', 'blue-button', 'cms.gov', 'cms.hhs.gov'].some((m) => blob.includes(m));
}

/** Go's accessLogCategories, for the routes this stack serves. A path not listed is not an access. */
export function accessCategoryFor(pathname: string): string | undefined {
  const exact: Record<string, string> = {
    '/api/secure/summary': 'Summary',
    '/api/secure/summary/ips': 'Summary (IPS)',
    '/api/secure/medications/reconciled': 'Medications',
    '/api/secure/conditions/reconciled': 'Conditions',
    '/api/secure/allergies/classified': 'Allergies',
    '/api/secure/immunizations/classified': 'Immunizations',
    '/api/secure/resources/recent': 'Record search',
    '/api/secure/resource/fhir': 'Records (FHIR)',
  };
  if (exact[pathname]) return exact[pathname];
  if (/^\/api\/secure\/resource\/fhir\/[^/]+\/[^/]+$/.test(pathname)) return 'Records (FHIR)';
  if (/^\/api\/secure\/source\/[^/]+\/export$/.test(pathname)) return 'Full export';
  return undefined;
}
