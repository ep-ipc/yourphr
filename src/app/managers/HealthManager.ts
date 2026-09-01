/**
 * Health samples — the one door for Apple Health / HealthKit ingest and the Health page reads.
 *
 * These rows are deliberately not FHIR Observations. The FHIR write path indexes every resource
 * through FHIRPath; a year of five-minute heart rate would not finish. Samples live in the app
 * database, keyed (user, HealthKit uuid), and the iPhone companion resumes from opaque anchors.
 *
 * Ownership is always ctx.username. Nothing in the request body names the account.
 */
import { randomBytes } from 'node:crypto';
import { BaseManager, type BackupData } from '../../framework/BaseManager.js';
import type { Engine } from '../../framework/Engine.js';
import { ApiError, type ApiContext } from '../../framework/ApiContext.js';
import { lookup, normalizeCategoryValue, normalizeUnit } from '../healthkit/metrics.js';
import {
  HEALTH_SAMPLE_DEFAULT_LIMIT,
  HEALTH_SAMPLE_MAX_LIMIT,
  HEALTH_SERIES_DEFAULT_POINTS,
  HEALTH_SERIES_MAX_POINTS,
  type BaseHealthProvider,
  type HealthMetricSummary,
  type HealthSampleQuery,
  type HealthSampleRow,
  type HealthSeries,
  type HealthSeriesMode,
} from '../providers/BaseHealthProvider.js';

declare module '../../framework/Engine.js' {
  interface ManagerRegistry {
    health: HealthManager;
  }
}

export const HEALTH_SAMPLE_MAX_BATCH = 5000;
export const HEALTH_SAMPLE_MAX_REPORTED_ERRORS = 50;

export interface HealthSampleInput {
  uuid?: unknown;
  type?: unknown;
  start?: unknown;
  end?: unknown;
  value?: unknown;
  unit?: unknown;
  value_text?: unknown;
  source_name?: unknown;
  source_bundle_id?: unknown;
  device_name?: unknown;
  correlation_uuid?: unknown;
  metadata?: unknown;
}

export interface HealthSampleRejection {
  uuid: string;
  type: string;
  reason: string;
}

export interface HealthSampleIngestResult {
  received: number;
  accepted: number;
  stored: number;
  duplicates: number;
  rejected: number;
  errors?: HealthSampleRejection[];
}

export interface HealthSampleListItem {
  id: string;
  external_uuid: string;
  hk_type: string;
  metric_type: string;
  start_time: string;
  end_time: string;
  value_num?: number;
  unit?: string;
  value_text?: string;
  correlation_uuid?: string;
  source_name?: string;
  device_name?: string;
}

export interface HealthSyncStateView {
  device_id: string;
  metric_type: string;
  anchor: string;
  last_sample_end_time?: string;
  last_synced_at: string;
  device_name?: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${field} must be an RFC3339 timestamp`);
  return new Date(ms).toISOString();
}

function optionalTime(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be an RFC3339 timestamp`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ApiError(400, `${field} must be an RFC3339 timestamp`);
  return new Date(ms).toISOString();
}

function clamp(n: number, fallback: number, max: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n > max ? max : Math.trunc(n);
}

function buildSample(input: HealthSampleInput): HealthSampleRow {
  const externalUuid = asString(input.uuid).trim();
  if (externalUuid === '') throw new Error('uuid is required');
  const hkType = asString(input.type).trim();
  if (hkType === '') throw new Error('type is required');
  const startTime = parseTime(input.start, 'start');
  let endTime: string;
  if (input.end === undefined || input.end === null || input.end === '') {
    endTime = startTime;
  } else {
    endTime = parseTime(input.end, 'end');
  }
  if (Date.parse(endTime) < Date.parse(startTime)) throw new Error('end is before start');

  const row: HealthSampleRow = {
    id: randomBytes(12).toString('hex'),
    userId: '',
    externalUuid,
    hkType,
    metricType: '',
    startTime,
    endTime,
    valueNum: null,
    unit: '',
    valueText: '',
    correlationUuid: asString(input.correlation_uuid),
    sourceName: asString(input.source_name),
    sourceBundleId: asString(input.source_bundle_id),
    deviceName: asString(input.device_name),
    metadata: '',
  };

  const metric = lookup(hkType);
  if (!metric) {
    const value = asNumber(input.value);
    row.valueNum = value === undefined ? null : value;
    row.unit = asString(input.unit).trim();
    row.valueText = asString(input.value_text).trim();
  } else {
    row.metricType = metric.metricType;
    if (metric.kind === 'quantity') {
      const value = asNumber(input.value);
      if (value === undefined) throw new Error(`${metric.metricType} requires a numeric value`);
      const unit = normalizeUnit(metric, asString(input.unit));
      if (unit === undefined) {
        throw new Error(`${metric.metricType} expects unit "${metric.canonicalUnit}", got "${asString(input.unit)}"`);
      }
      row.valueNum = value;
      row.unit = unit;
    } else {
      const value = normalizeCategoryValue(metric, asString(input.value_text));
      if (value === undefined) {
        throw new Error(`${metric.metricType} does not accept value "${asString(input.value_text)}"`);
      }
      row.valueText = value;
    }
  }

  if (input.metadata && typeof input.metadata === 'object') {
    try {
      row.metadata = JSON.stringify(input.metadata);
    } catch {
      throw new Error('metadata is not serializable');
    }
  }
  return row;
}

export class HealthManager extends BaseManager {
  readonly name = 'health' as const;
  override readonly dependsOn = [] as const;

  constructor(engine: Engine, private readonly provider: BaseHealthProvider) {
    super(engine);
  }

  override async initialize(config: Record<string, unknown> = {}): Promise<void> {
    await this.provider.initialize();
    await super.initialize(config);
  }

  private who(ctx: ApiContext): string {
    ctx.requireAuthenticated();
    return ctx.username;
  }

  async ingest(
    ctx: ApiContext,
    body: {
      device?: { device_id?: unknown; name?: unknown };
      samples?: unknown;
      anchors?: unknown;
    }
  ): Promise<HealthSampleIngestResult> {
    const userId = this.who(ctx);
    const deviceId = asString(body.device?.device_id).trim();
    if (deviceId === '') throw new ApiError(400, 'device.device_id is required');
    if (!Array.isArray(body.samples)) throw new ApiError(400, 'invalid request: samples must be an array');
    if (body.samples.length > HEALTH_SAMPLE_MAX_BATCH) {
      throw new ApiError(400, `batch contains ${body.samples.length} samples; the maximum is ${HEALTH_SAMPLE_MAX_BATCH}`);
    }

    const accepted: HealthSampleRow[] = [];
    const errors: HealthSampleRejection[] = [];
    let rejected = 0;
    const latestEnd = new Map<string, string>();

    for (const raw of body.samples) {
      const input = (raw && typeof raw === 'object' ? raw : {}) as HealthSampleInput;
      try {
        const sample = buildSample(input);
        accepted.push(sample);
        if (sample.metricType) {
          const current = latestEnd.get(sample.metricType);
          if (!current || sample.endTime > current) latestEnd.set(sample.metricType, sample.endTime);
        }
      } catch (err) {
        rejected++;
        if (errors.length < HEALTH_SAMPLE_MAX_REPORTED_ERRORS) {
          errors.push({ uuid: asString(input.uuid), type: asString(input.type), reason: (err as Error).message });
        }
      }
    }

    const stored = await this.provider.insertSamples(userId, accepted);
    const now = new Date().toISOString();
    const anchors = body.anchors && typeof body.anchors === 'object' && !Array.isArray(body.anchors)
      ? body.anchors as Record<string, unknown>
      : {};
    for (const [metricTypeRaw, anchorRaw] of Object.entries(anchors)) {
      const metricType = metricTypeRaw.trim();
      if (metricType === '') continue;
      await this.provider.upsertSyncState({
        userId,
        deviceId,
        metricType,
        anchor: asString(anchorRaw),
        lastSampleEndTime: latestEnd.get(metricType) ?? '',
        lastSyncedAt: now,
        deviceName: asString(body.device?.name),
      });
    }

    return {
      received: body.samples.length,
      accepted: accepted.length,
      stored,
      duplicates: accepted.length - stored,
      rejected,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  async list(
    ctx: ApiContext,
    query: {
      metricTypes?: string[];
      hkType?: string;
      startAfter?: unknown;
      startBefore?: unknown;
      limit?: unknown;
      offset?: unknown;
      sort?: unknown;
    }
  ): Promise<{ total: number; count: number; offset: number; samples: HealthSampleListItem[] }> {
    const userId = this.who(ctx);
    const parsed: HealthSampleQuery = {
      metricTypes: query.metricTypes ?? [],
      hkType: query.hkType ?? '',
      startAfter: optionalTime(query.startAfter, 'start_after'),
      startBefore: optionalTime(query.startBefore, 'start_before'),
      limit: clamp(Number(query.limit), HEALTH_SAMPLE_DEFAULT_LIMIT, HEALTH_SAMPLE_MAX_LIMIT),
      offset: Math.max(0, Math.trunc(Number(query.offset) || 0)),
      sortAscending: String(query.sort ?? '').toLowerCase() === 'asc',
    };
    if (query.limit !== undefined && query.limit !== '' && !Number.isFinite(Number(query.limit))) {
      throw new ApiError(400, 'limit must be an integer');
    }
    if (query.offset !== undefined && query.offset !== '' && !Number.isFinite(Number(query.offset))) {
      throw new ApiError(400, 'offset must be an integer');
    }
    const { samples, total } = await this.provider.listSamples(userId, parsed);
    return {
      total,
      count: samples.length,
      offset: parsed.offset,
      samples: samples.map((s) => ({
        id: s.id,
        external_uuid: s.externalUuid,
        hk_type: s.hkType,
        metric_type: s.metricType,
        start_time: s.startTime,
        end_time: s.endTime,
        ...(s.valueNum != null ? { value_num: s.valueNum } : {}),
        ...(s.unit ? { unit: s.unit } : {}),
        ...(s.valueText ? { value_text: s.valueText } : {}),
        ...(s.correlationUuid ? { correlation_uuid: s.correlationUuid } : {}),
        ...(s.sourceName ? { source_name: s.sourceName } : {}),
        ...(s.deviceName ? { device_name: s.deviceName } : {}),
      })),
    };
  }

  async metrics(ctx: ApiContext): Promise<{ last_synced_at?: string; metrics: HealthMetricSummary[] }> {
    const userId = this.who(ctx);
    const metrics = await this.provider.summarizeMetrics(userId);
    const states = await this.provider.listSyncStates(userId, '');
    let last: string | undefined;
    for (const state of states) {
      if (!last || state.lastSyncedAt > last) last = state.lastSyncedAt;
    }
    return { metrics, ...(last ? { last_synced_at: last } : {}) };
  }

  async series(
    ctx: ApiContext,
    query: {
      metricTypes?: string[];
      hkType?: string;
      startAfter?: unknown;
      startBefore?: unknown;
      maxPoints?: unknown;
      mode?: unknown;
    }
  ): Promise<HealthSeries> {
    const userId = this.who(ctx);
    const modeRaw = asString(query.mode).trim() || 'points';
    if (modeRaw !== 'points' && modeRaw !== 'day' && modeRaw !== 'stages') {
      throw new ApiError(400, 'mode must be points, day, or stages');
    }
    const metricTypes = query.metricTypes ?? [];
    const hkType = query.hkType ?? '';
    if (metricTypes.length === 0 && hkType === '') {
      throw new ApiError(400, 'metric_type or hk_type is required');
    }
    if (query.maxPoints !== undefined && query.maxPoints !== '' && !Number.isFinite(Number(query.maxPoints))) {
      throw new ApiError(400, 'max_points must be an integer');
    }
    return this.provider.querySeries(userId, {
      metricTypes,
      hkType,
      startAfter: optionalTime(query.startAfter, 'start_after'),
      startBefore: optionalTime(query.startBefore, 'start_before'),
      maxPoints: clamp(Number(query.maxPoints), HEALTH_SERIES_DEFAULT_POINTS, HEALTH_SERIES_MAX_POINTS),
      mode: modeRaw as HealthSeriesMode,
    });
  }

  async syncState(ctx: ApiContext, deviceId?: string): Promise<HealthSyncStateView[]> {
    const userId = this.who(ctx);
    return (await this.provider.listSyncStates(userId, deviceId?.trim() ?? '')).map((s) => ({
      device_id: s.deviceId,
      metric_type: s.metricType,
      anchor: s.anchor,
      ...(s.lastSampleEndTime ? { last_sample_end_time: s.lastSampleEndTime } : {}),
      last_synced_at: s.lastSyncedAt,
      ...(s.deviceName ? { device_name: s.deviceName } : {}),
    }));
  }

  async removeForUser(ctx: ApiContext): Promise<void> {
    await this.provider.removeForOwner(this.who(ctx));
  }

  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString() };
  }

  async restore(): Promise<void> { /* restored with the app database */ }
}
