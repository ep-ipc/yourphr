/** health_samples and health_sync_states in the app database. Every raw query over them lives here. */
import type Database from 'better-sqlite3-multiple-ciphers';
import {
  BaseHealthProvider,
  HEALTH_SAMPLE_INSERT_BATCH,
  type HealthDailyBucket,
  type HealthMetricSummary,
  type HealthSampleQuery,
  type HealthSampleRow,
  type HealthSeries,
  type HealthSeriesQuery,
  type HealthStageNight,
  type HealthSyncStateRow,
} from './BaseHealthProvider.js';

export const HEALTH_SAMPLES_SCHEMA = `CREATE TABLE IF NOT EXISTS health_samples (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  external_uuid TEXT NOT NULL,
  hk_type TEXT NOT NULL,
  metric_type TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  value_num REAL,
  unit TEXT NOT NULL DEFAULT '',
  value_text TEXT NOT NULL DEFAULT '',
  correlation_uuid TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  source_bundle_id TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, external_uuid)
)`;

export const HEALTH_SYNC_STATES_SCHEMA = `CREATE TABLE IF NOT EXISTS health_sync_states (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  anchor TEXT NOT NULL DEFAULT '',
  last_sample_end_time TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, device_id, metric_type)
)`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_health_sample_series ON health_samples(user_id, metric_type, start_time)`,
  `CREATE INDEX IF NOT EXISTS idx_health_sample_correlation ON health_samples(correlation_uuid)`,
];

interface SampleSqlRow {
  id: string; user_id: string; external_uuid: string; hk_type: string; metric_type: string;
  start_time: string; end_time: string; value_num: number | null; unit: string; value_text: string;
  correlation_uuid: string; source_name: string; source_bundle_id: string; device_name: string; metadata: string;
}

interface SyncSqlRow {
  user_id: string; device_id: string; metric_type: string; anchor: string;
  last_sample_end_time: string; last_synced_at: string; device_name: string;
}

function toSample(r: SampleSqlRow): HealthSampleRow {
  return {
    id: r.id, userId: r.user_id, externalUuid: r.external_uuid, hkType: r.hk_type, metricType: r.metric_type,
    startTime: r.start_time, endTime: r.end_time, valueNum: r.value_num, unit: r.unit, valueText: r.value_text,
    correlationUuid: r.correlation_uuid, sourceName: r.source_name, sourceBundleId: r.source_bundle_id,
    deviceName: r.device_name, metadata: r.metadata,
  };
}

function toSync(r: SyncSqlRow): HealthSyncStateRow {
  return {
    userId: r.user_id, deviceId: r.device_id, metricType: r.metric_type, anchor: r.anchor,
    lastSampleEndTime: r.last_sample_end_time, lastSyncedAt: r.last_synced_at, deviceName: r.device_name,
  };
}

function sampleWhere(query: HealthSampleQuery): { sql: string; params: unknown[] } {
  const clauses = ['user_id = ?'];
  const params: unknown[] = [];
  if (query.metricTypes.length > 0) {
    clauses.push(`metric_type IN (${query.metricTypes.map(() => '?').join(',')})`);
    params.push(...query.metricTypes);
  }
  if (query.hkType) {
    clauses.push('hk_type = ?');
    params.push(query.hkType);
  }
  if (query.startAfter) {
    clauses.push('start_time >= ?');
    params.push(query.startAfter);
  }
  if (query.startBefore) {
    clauses.push('start_time < ?');
    params.push(query.startBefore);
  }
  return { sql: clauses.join(' AND '), params };
}

function seriesWhere(query: HealthSeriesQuery): { sql: string; params: unknown[] } {
  return sampleWhere({
    metricTypes: query.metricTypes,
    hkType: query.hkType,
    startAfter: query.startAfter,
    startBefore: query.startBefore,
    limit: 0, offset: 0, sortAscending: true,
  });
}

export class SqliteHealthProvider extends BaseHealthProvider {
  constructor(private readonly db: InstanceType<typeof Database>) {
    super();
    db.exec(HEALTH_SAMPLES_SCHEMA);
    db.exec(HEALTH_SYNC_STATES_SCHEMA);
    for (const sql of INDEXES) db.exec(sql);
  }

  async initialize(): Promise<void> { /* schema ensured in the constructor */ }

  async insertSamples(userId: string, rows: HealthSampleRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const insert = this.db.prepare(`INSERT INTO health_samples (
      id, user_id, external_uuid, hk_type, metric_type, start_time, end_time,
      value_num, unit, value_text, correlation_uuid, source_name, source_bundle_id, device_name, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, external_uuid) DO NOTHING`);
    let stored = 0;
    const write = this.db.transaction((batch: HealthSampleRow[]) => {
      for (const row of batch) {
        stored += insert.run(
          row.id, userId, row.externalUuid, row.hkType, row.metricType, row.startTime, row.endTime,
          row.valueNum, row.unit, row.valueText, row.correlationUuid, row.sourceName, row.sourceBundleId,
          row.deviceName, row.metadata,
        ).changes;
      }
    });
    for (let i = 0; i < rows.length; i += HEALTH_SAMPLE_INSERT_BATCH) {
      write(rows.slice(i, i + HEALTH_SAMPLE_INSERT_BATCH));
    }
    return stored;
  }

  async listSamples(userId: string, query: HealthSampleQuery): Promise<{ samples: HealthSampleRow[]; total: number }> {
    const { sql, params } = sampleWhere(query);
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM health_samples WHERE ${sql}`).get(userId, ...params) as { n: number }).n;
    const order = query.sortAscending ? 'start_time ASC' : 'start_time DESC';
    const samples = (this.db.prepare(
      `SELECT * FROM health_samples WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`
    ).all(userId, ...params, query.limit, query.offset) as SampleSqlRow[]).map(toSample);
    return { samples, total };
  }

  async summarizeMetrics(userId: string): Promise<HealthMetricSummary[]> {
    const aggs = this.db.prepare(`
      SELECT CASE WHEN metric_type = '' THEN hk_type ELSE metric_type END AS metric_key,
             MAX(start_time) AS latest, MIN(start_time) AS earliest, COUNT(*) AS cnt
      FROM health_samples WHERE user_id = ?
      GROUP BY metric_key ORDER BY latest DESC
    `).all(userId) as { metric_key: string; latest: string; earliest: string; cnt: number }[];

    const summaries: HealthMetricSummary[] = [];
    const byHk = this.db.prepare(
      `SELECT * FROM health_samples WHERE user_id = ? AND hk_type = ? AND start_time = ? ORDER BY id DESC LIMIT 1`
    );
    const byMetric = this.db.prepare(
      `SELECT * FROM health_samples WHERE user_id = ? AND metric_type = ? AND start_time = ? ORDER BY id DESC LIMIT 1`
    );
    for (const agg of aggs) {
      const row = (agg.metric_key.startsWith('HK')
        ? byHk.get(userId, agg.metric_key, agg.latest)
        : byMetric.get(userId, agg.metric_key, agg.latest)) as SampleSqlRow | undefined;
      if (!row) continue;
      summaries.push({
        metric_type: row.metric_type,
        hk_type: row.hk_type,
        ...(row.unit ? { unit: row.unit } : {}),
        ...(row.value_num != null ? { value_num: row.value_num } : {}),
        ...(row.value_text ? { value_text: row.value_text } : {}),
        latest_at: row.start_time,
        earliest_at: agg.earliest,
        sample_count: agg.cnt,
        ...(row.source_name ? { source_name: row.source_name } : {}),
        ...(row.device_name ? { device_name: row.device_name } : {}),
      });
    }
    return summaries;
  }

  async querySeries(userId: string, query: HealthSeriesQuery): Promise<HealthSeries> {
    const { sql, params } = seriesWhere(query);
    const series: HealthSeries = {
      total: 0,
      downsampled: false,
      ...(query.hkType ? { hk_type: query.hkType } : {}),
      ...(query.metricTypes[0] ? { metric_type: query.metricTypes[0] } : {}),
    };
    if (query.mode === 'day') return this.seriesDay(userId, sql, params, series);
    if (query.mode === 'stages') return this.seriesStages(userId, sql, params, series);
    return this.seriesPoints(userId, sql, params, series, query.maxPoints);
  }

  private unitOf(userId: string, sql: string, params: unknown[]): string {
    const row = this.db.prepare(`SELECT unit FROM health_samples WHERE ${sql} LIMIT 1`).get(userId, ...params) as { unit: string } | undefined;
    return row?.unit ?? '';
  }

  private seriesPoints(userId: string, sql: string, params: unknown[], series: HealthSeries, maxPoints: number): HealthSeries {
    const stats = this.db.prepare(
      `SELECT MIN(value_num) AS min, MAX(value_num) AS max, AVG(value_num) AS avg, COUNT(*) AS n FROM health_samples WHERE ${sql}`
    ).get(userId, ...params) as { min: number | null; max: number | null; avg: number | null; n: number };
    series.total = stats.n;
    if (stats.n > 0 && (stats.min != null || stats.max != null || stats.avg != null)) {
      series.stats = {
        ...(stats.min != null ? { min: stats.min } : {}),
        ...(stats.max != null ? { max: stats.max } : {}),
        ...(stats.avg != null ? { avg: stats.avg } : {}),
      };
    }
    if (stats.n === 0) return series;
    const unit = this.unitOf(userId, sql, params);
    if (unit) series.unit = unit;

    if (stats.n <= maxPoints) {
      const rows = this.db.prepare(
        `SELECT start_time, value_num FROM health_samples WHERE ${sql} AND value_num IS NOT NULL ORDER BY start_time ASC LIMIT ?`
      ).all(userId, ...params, maxPoints) as { start_time: string; value_num: number }[];
      series.points = rows.map((r) => ({ t: r.start_time, v: r.value_num }));
      return series;
    }

    const span = this.db.prepare(
      `SELECT MIN(start_time) AS first, MAX(start_time) AS last FROM health_samples WHERE ${sql}`
    ).get(userId, ...params) as { first: string | null; last: string | null };
    const first = span.first ? Date.parse(span.first) : NaN;
    const last = span.last ? Date.parse(span.last) : NaN;
    let durationMs = last - first;
    if (!Number.isFinite(durationMs) || durationMs <= 0) durationMs = 1000;
    let bucketSeconds = Math.floor(durationMs / 1000 / maxPoints);
    if (bucketSeconds < 1) bucketSeconds = 1;

    const buckets = this.db.prepare(
      `SELECT CAST(strftime('%s', start_time) / ? AS INTEGER) * ? AS bucket, AVG(value_num) AS avg_v
       FROM health_samples WHERE ${sql} AND value_num IS NOT NULL
       GROUP BY bucket ORDER BY bucket ASC`
    ).all(bucketSeconds, bucketSeconds, userId, ...params) as { bucket: number; avg_v: number }[];
    series.downsampled = true;
    series.points = buckets.map((b) => ({ t: new Date(b.bucket * 1000).toISOString(), v: b.avg_v }));
    return series;
  }

  private seriesDay(userId: string, sql: string, params: unknown[], series: HealthSeries): HealthSeries {
    series.total = (this.db.prepare(`SELECT COUNT(*) AS n FROM health_samples WHERE ${sql}`).get(userId, ...params) as { n: number }).n;
    const unit = this.unitOf(userId, sql, params);
    if (unit) series.unit = unit;
    series.daily = this.db.prepare(
      `SELECT date(start_time) AS date, COALESCE(SUM(value_num), 0) AS value
       FROM health_samples WHERE ${sql}
       GROUP BY date(start_time) ORDER BY date ASC`
    ).all(userId, ...params) as HealthDailyBucket[];
    return series;
  }

  private seriesStages(userId: string, sql: string, params: unknown[], series: HealthSeries): HealthSeries {
    series.total = (this.db.prepare(`SELECT COUNT(*) AS n FROM health_samples WHERE ${sql}`).get(userId, ...params) as { n: number }).n;
    const rows = this.db.prepare(
      `SELECT date(start_time, '-12 hours') AS date, value_text AS stage,
              SUM((julianday(end_time) - julianday(start_time)) * 24.0) AS hours
       FROM health_samples WHERE ${sql} AND value_text != ''
       GROUP BY date(start_time, '-12 hours'), value_text
       ORDER BY date ASC`
    ).all(userId, ...params) as { date: string; stage: string; hours: number }[];
    const byDate = new Map<string, HealthStageNight>();
    const order: string[] = [];
    for (const row of rows) {
      let night = byDate.get(row.date);
      if (!night) {
        night = { date: row.date, stages: {} };
        byDate.set(row.date, night);
        order.push(row.date);
      }
      night.stages[row.stage] = row.hours;
    }
    series.nights = order.map((d) => byDate.get(d)!);
    return series;
  }

  async upsertSyncState(row: HealthSyncStateRow): Promise<void> {
    this.db.prepare(`INSERT INTO health_sync_states
      (user_id, device_id, metric_type, anchor, last_sample_end_time, last_synced_at, device_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id, metric_type) DO UPDATE SET
        anchor = excluded.anchor,
        last_sample_end_time = excluded.last_sample_end_time,
        last_synced_at = excluded.last_synced_at,
        device_name = excluded.device_name`)
      .run(row.userId, row.deviceId, row.metricType, row.anchor, row.lastSampleEndTime, row.lastSyncedAt, row.deviceName);
  }

  async listSyncStates(userId: string, deviceId: string): Promise<HealthSyncStateRow[]> {
    const rows = deviceId
      ? this.db.prepare(`SELECT * FROM health_sync_states WHERE user_id = ? AND device_id = ? ORDER BY device_id ASC, metric_type ASC`).all(userId, deviceId)
      : this.db.prepare(`SELECT * FROM health_sync_states WHERE user_id = ? ORDER BY device_id ASC, metric_type ASC`).all(userId);
    return (rows as SyncSqlRow[]).map(toSync);
  }

  async removeForOwner(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM health_samples WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM health_sync_states WHERE user_id = ?').run(userId);
  }
}
