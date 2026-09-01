/**
 * Health samples storage (Apple Health / HealthKit ingest). The provider stores; the manager
 * decides. Ownership is always a user_id the manager supplies — never a value from the body.
 */

export const HEALTH_SAMPLE_DEFAULT_LIMIT = 500;
export const HEALTH_SAMPLE_MAX_LIMIT = 5000;
export const HEALTH_SERIES_DEFAULT_POINTS = 400;
export const HEALTH_SERIES_MAX_POINTS = 2000;
export const HEALTH_SAMPLE_INSERT_BATCH = 250;

export type HealthSeriesMode = 'points' | 'day' | 'stages';

export interface HealthSampleRow {
  id: string;
  userId: string;
  externalUuid: string;
  hkType: string;
  metricType: string;
  startTime: string;
  endTime: string;
  valueNum: number | null;
  unit: string;
  valueText: string;
  correlationUuid: string;
  sourceName: string;
  sourceBundleId: string;
  deviceName: string;
  metadata: string;
}

export interface HealthSyncStateRow {
  userId: string;
  deviceId: string;
  metricType: string;
  anchor: string;
  lastSampleEndTime: string;
  lastSyncedAt: string;
  deviceName: string;
}

export interface HealthSampleQuery {
  metricTypes: string[];
  hkType: string;
  startAfter?: string;
  startBefore?: string;
  limit: number;
  offset: number;
  sortAscending: boolean;
}

export interface HealthSeriesQuery {
  metricTypes: string[];
  hkType: string;
  startAfter?: string;
  startBefore?: string;
  maxPoints: number;
  mode: HealthSeriesMode;
}

export interface HealthMetricSummary {
  metric_type: string;
  hk_type: string;
  unit?: string;
  value_num?: number;
  value_text?: string;
  latest_at: string;
  earliest_at: string;
  sample_count: number;
  source_name?: string;
  device_name?: string;
}

export interface HealthSeriesPoint { t: string; v: number }
export interface HealthDailyBucket { date: string; value: number }
export interface HealthStageNight { date: string; stages: Record<string, number> }
export interface HealthSeriesStats { min?: number; max?: number; avg?: number }

export interface HealthSeries {
  metric_type?: string;
  hk_type?: string;
  unit?: string;
  total: number;
  downsampled: boolean;
  points?: HealthSeriesPoint[];
  daily?: HealthDailyBucket[];
  nights?: HealthStageNight[];
  stats?: HealthSeriesStats;
}

export abstract class BaseHealthProvider {
  abstract initialize(): Promise<void>;
  /** Inserts, skipping (user_id, external_uuid) duplicates. Returns how many rows were actually written. */
  abstract insertSamples(userId: string, rows: HealthSampleRow[]): Promise<number>;
  abstract listSamples(userId: string, query: HealthSampleQuery): Promise<{ samples: HealthSampleRow[]; total: number }>;
  abstract summarizeMetrics(userId: string): Promise<HealthMetricSummary[]>;
  abstract querySeries(userId: string, query: HealthSeriesQuery): Promise<HealthSeries>;
  abstract upsertSyncState(row: HealthSyncStateRow): Promise<void>;
  abstract listSyncStates(userId: string, deviceId: string): Promise<HealthSyncStateRow[]>;
  abstract removeForOwner(userId: string): Promise<void>;
}
