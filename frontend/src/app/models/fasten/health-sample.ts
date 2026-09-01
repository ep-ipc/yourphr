// Mirrors GET /api/secure/health/metrics and /health/series. Hand-maintained (not tygo-exported).

export interface HealthMetricSummary {
  metric_type: string
  hk_type: string
  unit?: string
  value_num?: number
  value_text?: string
  latest_at: string
  earliest_at: string
  sample_count: number
  source_name?: string
  device_name?: string
}

export interface HealthMetricsCatalog {
  last_synced_at?: string
  metrics: HealthMetricSummary[]
}

export interface HealthSeriesPoint {
  t: string
  v: number
}

export interface HealthDailyBucket {
  date: string
  value: number
}

export interface HealthStageNight {
  date: string
  stages: Record<string, number>
}

export interface HealthSeriesStats {
  min?: number
  max?: number
  avg?: number
}

export interface HealthSeries {
  metric_type?: string
  hk_type?: string
  unit?: string
  total: number
  downsampled: boolean
  points?: HealthSeriesPoint[]
  daily?: HealthDailyBucket[]
  nights?: HealthStageNight[]
  stats?: HealthSeriesStats
}

export interface HealthSample {
  id: string
  external_uuid: string
  hk_type: string
  metric_type: string
  start_time: string
  end_time: string
  value_num?: number
  unit?: string
  value_text?: string
  correlation_uuid?: string
  source_name?: string
  device_name?: string
}

export interface HealthSamplePage {
  total: number
  count: number
  offset: number
  samples: HealthSample[]
}

export interface HealthSeriesQuery {
  metricTypes?: string[]
  hkType?: string
  startAfter?: string
  startBefore?: string
  mode?: 'points' | 'day' | 'stages'
}

export interface HealthSampleQuery {
  metricTypes?: string[]
  hkType?: string
  startAfter?: string
  startBefore?: string
  limit?: number
  offset?: number
  sort?: 'asc' | 'desc'
}
