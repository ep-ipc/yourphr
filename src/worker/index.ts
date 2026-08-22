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
import type { RecordsWriter } from '../app/providers/BaseRecordsProvider.js';

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
  /**
   * Go's platform_type ('ehr', 'manual', 'fasten', ...) and environment ('production' | 'sandbox'),
   * carried because the Angular app NAMES a source by platform type when display is empty and
   * splits the Sources page by environment (yourphr#594). '' when unknown — never guessed.
   */
  platformType: string;
  environment: string;
}

export interface JobSummary {
  /** Row id; absent on a summary that has not been recorded yet. */
  id?: number;
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
      platform_type TEXT NOT NULL DEFAULT '',
      environment TEXT NOT NULL DEFAULT '',
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

  add(source: Omit<ConnectedSource, 'id' | 'lastSyncAt' | 'platformType' | 'environment'> & Partial<Pick<ConnectedSource, 'platformType' | 'environment'>>): ConnectedSource {
    const info = this.db
      .prepare(
        `INSERT INTO connected_sources (user_id, display, fhir_base_url, token_url, client_id, patient, resource_types, access_token, refresh_token, expires_at, platform_type, environment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        source.userId, source.display, source.fhirBaseUrl, source.tokenUrl, source.clientId,
        source.patient, source.resourceTypes.join(','), source.accessToken, source.refreshToken, source.expiresAt,
        source.platformType ?? '', source.environment ?? ''
      );
    return this.list().find((s) => s.id === Number(info.lastInsertRowid))!;
  }

  byId(id: number): ConnectedSource | undefined {
    return this.list().find((s) => s.id === id);
  }

  /** Disconnect (yourphr#594, Go's #437): the tokens go, the records stay; the worker skips it. */
  clearTokens(id: number): void {
    this.db.prepare("UPDATE connected_sources SET access_token = '', refresh_token = '', expires_at = 0 WHERE id = ?").run(id);
  }

  /** Removes the source and its job history. The records are the repository's to remove. */
  remove(id: number): void {
    this.db.prepare('DELETE FROM sync_jobs WHERE source_id = ?').run(id);
    this.db.prepare('DELETE FROM connected_sources WHERE id = ?').run(id);
  }

  latestJob(sourceId: number): JobSummary | undefined {
    const row = this.db.prepare('SELECT * FROM sync_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId) as Record<string, unknown> | undefined;
    return row ? this.toSummaries([row])[0] : undefined;
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
      platformType: (r['platform_type'] as string | undefined) ?? '',
      environment: (r['environment'] as string | undefined) ?? '',
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
    return this.toSummaries(rows as Record<string, unknown>[]);
  }

  /**
   * The jobs a signed-in member may see: those of THEIR sources, newest first (yourphr#593). The
   * per-user seam is the join on connected_sources.user_id — a job never names a user itself.
   */
  jobsForUser(userId: string, query: { limit: number; offset: number; outcome?: 'success' | 'failure' } = { limit: 20, offset: 0 }): JobSummary[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM sync_jobs j JOIN connected_sources s ON s.id = j.source_id
         WHERE s.user_id = ? AND (? IS NULL OR j.outcome = ?)
         ORDER BY j.id DESC LIMIT ? OFFSET ?`
      )
      .all(userId, query.outcome ?? null, query.outcome ?? null, query.limit, query.offset);
    return this.toSummaries(rows as Record<string, unknown>[]);
  }

  private toSummaries(rows: Record<string, unknown>[]): JobSummary[] {
    return rows.map((r) => ({
      id: r['id'] as number,
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
  /** The door for a source's records (yourphr#609): a writer bound to the owner and the source. */
  writerFor: (userId: string, sourceId: string) => RecordsWriter;
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
    if (isDisconnected(source)) {
      continue; // disconnected on purpose (yourphr#594): nothing to refresh, nothing to fetch with
    }
    const job = await syncSource(deps, source, now, (line) => log(line), (n) => { report.refreshAttempted += n; }, () => { report.refreshed++; });
    if (job.outcome === 'success') report.synced++;
    else report.failed++;
  }

  log(`token-refresh: attempted ${report.refreshAttempted}, refreshed ${report.refreshed}`);
  return report;
}

/** No access token and no refresh token: the source was disconnected, not merely expired. */
export function isDisconnected(source: ConnectedSource): boolean {
  return source.accessToken === '' && source.refreshToken === '';
}

/**
 * One source, refresh-then-sync, the job recorded either way. Shared by the worker pass and the
 * Sources page's "sync now" (yourphr#594) so a manual sync is the scheduled one, run early.
 */
export async function syncSource(
  deps: WorkerDeps,
  source: ConnectedSource,
  now = Math.floor(Date.now() / 1000),
  log: (line: string) => void = deps.log ?? (() => undefined),
  onRefreshAttempt: (n: number) => void = () => undefined,
  onRefreshed: () => void = () => undefined
): Promise<JobSummary> {
  {
    // --- refresh, only near expiry, accounted separately ---
    let accessToken = source.accessToken;
    if (source.expiresAt < now + REFRESH_MARGIN_SECONDS) {
      onRefreshAttempt(1);
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
          onRefreshed();
        } catch (err) {
          log(`token-refresh: source ${source.id} (${source.display}): ${(err as Error).message}`);
        }
      }
    }

    // --- sync, one source's failure never reaching the next ---
    const startedAt = now;
    const writer = deps.writerFor(source.userId, `source-${source.id}`);
    let received = 0;
    let created = 0;
    let updated = 0;
    try {
      for (const resourceType of source.resourceTypes) {
        const result = await syncFrom(`${source.fhirBaseUrl}/${resourceType}?patient=${source.patient}&_count=100`, {
          writer,
          accessToken,
          maxPages: deps.maxPages,
          allowInternal: deps.allowInternal,
        });
        received += result.received;
        created += result.created;
        updated += result.updated;
      }
      deps.store.markSynced(source.id, now);
      const job: JobSummary = { sourceId: source.id, outcome: 'success', received, created, updated, error: '', startedAt, finishedAt: now };
      deps.store.recordJob(job);
      return deps.store.latestJob(source.id) ?? job;
    } catch (err) {
      const job: JobSummary = {
        sourceId: source.id, outcome: 'failure', received, created, updated,
        error: (err as Error).message.slice(0, 512), startedAt, finishedAt: now,
      };
      deps.store.recordJob(job);
      return deps.store.latestJob(source.id) ?? job;
    }
  }
}
