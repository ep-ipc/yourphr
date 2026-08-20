/**
 * Connected sources + the background sync worker (yourphr#542 Phase 4) — the loop that keeps a
 * patient's records current without them pressing anything. Shaped by what the Go stack learned:
 *
 *   - Token refresh runs BEFORE sync and is accounted separately ("token-refresh: attempted N,
 *     refreshed M") — that exact log line is what proved the Epic confidential-client fix live, so
 *     the accounting is a feature, not noise.
 *   - Refresh only near expiry: refreshing every tick churns refresh tokens for nothing, and some
 *     providers rotate the refresh token on every use.
 *   - One source failing must not cost the others their sync (the yourphr#539 sync harness applied
 *     the same rule within a source: one contested record must not cost the other 20,000).
 *   - Every pass writes a job summary — outcome, counts, duration, error (yourphr#441's lesson:
 *     an invisible background job is indistinguishable from a broken one).
 *   - The page cap rides in from configuration (sync.max-pages) — yourphr#439 is what a missing
 *     cap does to a large patient.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { SmartClient, type Endpoints } from '../smart/index.js';
import { syncFrom } from '../sync/index.js';
import { SqliteFhirRepository } from '../SqliteFhirRepository.js';

export interface ConnectedSource {
  id: number;
  userId: string;
  display: string;
  fhirBaseUrl: string;
  tokenUrl: string;
  clientId: string;
  patient: string;
  resourceTypes: string[];
  accessToken: string;
  refreshToken: string;
  /** unix seconds; 0 = unknown, treated as expired so the first pass refreshes. */
  expiresAt: number;
  lastSyncAt: number;
}

export interface JobSummary {
  sourceId: number;
  outcome: 'success' | 'failure';
  received: number;
  created: number;
  updated: number;
  error: string;
  startedAt: number;
  finishedAt: number;
}

/** Refresh when this close to expiry — half the typical sandbox hour, same intent as Go's loop. */
const REFRESH_MARGIN_SECONDS = 10 * 60;

export class SourceStore {
  constructor(private readonly db: InstanceType<typeof Database>) {
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
      last_sync_at INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      received INTEGER NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL
    )`);
  }

  add(source: Omit<ConnectedSource, 'id' | 'lastSyncAt'>): ConnectedSource {
    const info = this.db
      .prepare(
        `INSERT INTO connected_sources (user_id, display, fhir_base_url, token_url, client_id, patient, resource_types, access_token, refresh_token, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        source.userId, source.display, source.fhirBaseUrl, source.tokenUrl, source.clientId,
        source.patient, source.resourceTypes.join(','), source.accessToken, source.refreshToken, source.expiresAt
      );
    return this.list().find((s) => s.id === Number(info.lastInsertRowid))!;
  }

  list(): ConnectedSource[] {
    return (this.db.prepare('SELECT * FROM connected_sources ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
      id: r['id'] as number,
      userId: r['user_id'] as string,
      display: r['display'] as string,
      fhirBaseUrl: r['fhir_base_url'] as string,
      tokenUrl: r['token_url'] as string,
      clientId: r['client_id'] as string,
      patient: r['patient'] as string,
      resourceTypes: (r['resource_types'] as string).split(',').filter(Boolean),
      accessToken: r['access_token'] as string,
      refreshToken: r['refresh_token'] as string,
      expiresAt: r['expires_at'] as number,
      lastSyncAt: r['last_sync_at'] as number,
    }));
  }

  /** Persists a discovered token endpoint (migrated sources arrive without one — yourphr#584). */
  updateTokenUrl(id: number, tokenUrl: string): void {
    this.db.prepare('UPDATE connected_sources SET token_url = ? WHERE id = ?').run(tokenUrl, id);
  }

  updateTokens(id: number, accessToken: string, refreshToken: string, expiresAt: number): void {
    this.db
      .prepare('UPDATE connected_sources SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?')
      .run(accessToken, refreshToken, expiresAt, id);
  }

  markSynced(id: number, at: number): void {
    this.db.prepare('UPDATE connected_sources SET last_sync_at = ? WHERE id = ?').run(at, id);
  }

  recordJob(job: JobSummary): void {
    this.db
      .prepare(
        `INSERT INTO sync_jobs (source_id, outcome, received, created, updated, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(job.sourceId, job.outcome, job.received, job.created, job.updated, job.error, job.startedAt, job.finishedAt);
  }

  jobs(sourceId?: number): JobSummary[] {
    const rows = sourceId
      ? this.db.prepare('SELECT * FROM sync_jobs WHERE source_id = ? ORDER BY id').all(sourceId)
      : this.db.prepare('SELECT * FROM sync_jobs ORDER BY id').all();
    return (rows as Record<string, unknown>[]).map((r) => ({
      sourceId: r['source_id'] as number,
      outcome: r['outcome'] as 'success' | 'failure',
      received: r['received'] as number,
      created: r['created'] as number,
      updated: r['updated'] as number,
      error: r['error'] as string,
      startedAt: r['started_at'] as number,
      finishedAt: r['finished_at'] as number,
    }));
  }
}

export interface WorkerDeps {
  store: SourceStore;
  /** The repository serving a source's OWNER — same seam the HTTP layer uses (yourphr#541). */
  repoForUser: (userId: string) => SqliteFhirRepository;
  maxPages: number;
  /** Tests only — lets loopback fakes be reached. */
  allowInternal?: boolean;
  log?: (line: string) => void;
}

export interface PassReport {
  refreshAttempted: number;
  refreshed: number;
  synced: number;
  failed: number;
}

/**
 * One worker pass: refresh what is near expiry, then sync every source, isolating failures.
 * Deterministic (`now` injected) so the harness needs no real clock.
 */
export async function runSyncPass(deps: WorkerDeps, now = Math.floor(Date.now() / 1000)): Promise<PassReport> {
  const report: PassReport = { refreshAttempted: 0, refreshed: 0, synced: 0, failed: 0 };
  const log = deps.log ?? (() => undefined);

  for (const source of deps.store.list()) {
    // --- refresh, only near expiry, accounted separately ---
    let accessToken = source.accessToken;
    if (source.expiresAt < now + REFRESH_MARGIN_SECONDS) {
      report.refreshAttempted++;
      if (source.refreshToken === '') {
        log(`token-refresh: source ${source.id} (${source.display}): access token expired and no refresh token is available; reconnect the source`);
      } else {
        try {
          const client = new SmartClient({
            fhirBaseUrl: source.fhirBaseUrl,
            clientId: source.clientId,
            redirectUri: 'unused-for-refresh',
            scopes: [],
            allowInternal: deps.allowInternal,
          });
          // A migrated source arrives without a token endpoint (Go re-discovered every time,
          // yourphr#584). Discover once, through the guarded client, and persist — after this the
          // source is indistinguishable from a natively connected one.
          let tokenUrl = source.tokenUrl;
          if (tokenUrl === '') {
            tokenUrl = (await client.discover()).token;
            deps.store.updateTokenUrl(source.id, tokenUrl);
          }
          const endpoints: Endpoints = { authorization: 'unused-for-refresh', token: tokenUrl };
          const token = await client.refresh(endpoints, source.refreshToken);
          accessToken = token.accessToken;
          deps.store.updateTokens(
            source.id,
            token.accessToken,
            token.refreshToken ?? source.refreshToken, // some providers rotate, some repeat — keep whichever is newest
            token.expiresAt ? Math.floor(token.expiresAt.getTime() / 1000) : now + 3600
          );
          report.refreshed++;
        } catch (err) {
          log(`token-refresh: source ${source.id} (${source.display}): ${(err as Error).message}`);
        }
      }
    }

    // --- sync, one source's failure never reaching the next ---
    const startedAt = now;
    const repo = deps.repoForUser(source.userId);
    let received = 0;
    let created = 0;
    let updated = 0;
    try {
      for (const resourceType of source.resourceTypes) {
        const result = await syncFrom(`${source.fhirBaseUrl}/${resourceType}?patient=${source.patient}&_count=100`, {
          repo,
          accessToken,
          sourceId: `source-${source.id}`,
          maxPages: deps.maxPages,
          allowInternal: deps.allowInternal,
        });
        received += result.received;
        created += result.created;
        updated += result.updated;
      }
      deps.store.markSynced(source.id, now);
      deps.store.recordJob({ sourceId: source.id, outcome: 'success', received, created, updated, error: '', startedAt, finishedAt: now });
      report.synced++;
    } catch (err) {
      deps.store.recordJob({
        sourceId: source.id, outcome: 'failure', received, created, updated,
        error: (err as Error).message.slice(0, 512), startedAt, finishedAt: now,
      });
      report.failed++;
    }
  }

  log(`token-refresh: attempted ${report.refreshAttempted}, refreshed ${report.refreshed}`);
  return report;
}
