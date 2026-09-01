/**
 * Maps HealthKit type identifiers onto the normalized metric names stored in health_samples, and
 * validates the units and category values that accompany them.
 *
 * Ported from the Go `pkg/healthkit` table on sat-apple-health. The mapping is additive: a type
 * identifier missing from this table is still stored (with an empty metric_type), because a
 * companion app that ships a new metric before the server knows about it should not lose the
 * user's data. Only a type that IS known and arrives with a unit this table does not accept is
 * rejected, since storing a heart rate whose unit might be beats per hour is worse than not
 * storing it.
 */

export type MetricKind = 'quantity' | 'category';

export interface Metric {
  metricType: string;
  kind: MetricKind;
  /** Empty for category metrics. */
  canonicalUnit: string;
  acceptedUnits: readonly string[];
  allowedValues: readonly { canonical: string; aliases: readonly string[] }[];
}

const METRICS: Record<string, Metric> = {
  HKQuantityTypeIdentifierHeartRate: {
    metricType: 'heart_rate',
    kind: 'quantity',
    canonicalUnit: 'count/min',
    acceptedUnits: ['count/min', 'count/minute', 'bpm'],
    allowedValues: [],
  },
  HKQuantityTypeIdentifierRestingHeartRate: {
    metricType: 'resting_heart_rate',
    kind: 'quantity',
    canonicalUnit: 'count/min',
    acceptedUnits: ['count/min', 'count/minute', 'bpm'],
    allowedValues: [],
  },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
    metricType: 'heart_rate_variability_sdnn',
    kind: 'quantity',
    canonicalUnit: 'ms',
    acceptedUnits: ['ms', 'msec', 'millisecond', 'milliseconds'],
    allowedValues: [],
  },
  HKQuantityTypeIdentifierBloodPressureSystolic: {
    metricType: 'blood_pressure_systolic',
    kind: 'quantity',
    canonicalUnit: 'mmHg',
    acceptedUnits: ['mmHg', 'mm[Hg]'],
    allowedValues: [],
  },
  HKQuantityTypeIdentifierBloodPressureDiastolic: {
    metricType: 'blood_pressure_diastolic',
    kind: 'quantity',
    canonicalUnit: 'mmHg',
    acceptedUnits: ['mmHg', 'mm[Hg]'],
    allowedValues: [],
  },
  HKQuantityTypeIdentifierStepCount: {
    metricType: 'step_count',
    kind: 'quantity',
    canonicalUnit: 'count',
    acceptedUnits: ['count', 'steps'],
    allowedValues: [],
  },
  HKQuantityTypeIdentifierBodyMass: {
    metricType: 'body_mass',
    kind: 'quantity',
    canonicalUnit: 'kg',
    acceptedUnits: ['kg', 'kilogram', 'kilograms'],
    allowedValues: [],
  },
  HKQuantityTypeIdentifierOxygenSaturation: {
    metricType: 'oxygen_saturation',
    kind: 'quantity',
    canonicalUnit: '%',
    acceptedUnits: ['%', 'percent'],
    allowedValues: [],
  },
  HKQuantityTypeIdentifierBodyTemperature: {
    metricType: 'body_temperature',
    kind: 'quantity',
    canonicalUnit: 'degC',
    acceptedUnits: ['degC', '°C', 'C', 'celsius'],
    allowedValues: [],
  },
  HKCategoryTypeIdentifierSleepAnalysis: {
    metricType: 'sleep_stage',
    kind: 'category',
    canonicalUnit: '',
    acceptedUnits: [],
    allowedValues: [
      { canonical: 'inBed', aliases: ['0', 'HKCategoryValueSleepAnalysisInBed'] },
      { canonical: 'asleepUnspecified', aliases: ['1', 'asleep', 'HKCategoryValueSleepAnalysisAsleepUnspecified'] },
      { canonical: 'awake', aliases: ['2', 'HKCategoryValueSleepAnalysisAwake'] },
      { canonical: 'asleepCore', aliases: ['3', 'HKCategoryValueSleepAnalysisAsleepCore'] },
      { canonical: 'asleepDeep', aliases: ['4', 'HKCategoryValueSleepAnalysisAsleepDeep'] },
      { canonical: 'asleepREM', aliases: ['5', 'HKCategoryValueSleepAnalysisAsleepREM'] },
    ],
  },
};

/** Every known mapping — tests walk this to prove the table is self-consistent. */
export function allMetrics(): ReadonlyArray<readonly [string, Metric]> {
  return Object.entries(METRICS);
}

export function lookup(hkType: string): Metric | undefined {
  return METRICS[hkType.trim()];
}

export function lookupByMetricType(metricType: string): Metric | undefined {
  const wanted = metricType.trim();
  if (wanted === '') return undefined;
  return Object.values(METRICS).find((m) => m.metricType === wanted);
}

export function normalizeUnit(metric: Metric, unit: string): string | undefined {
  const trimmed = unit.trim();
  for (const accepted of metric.acceptedUnits) {
    if (accepted.toLowerCase() === trimmed.toLowerCase()) return metric.canonicalUnit;
  }
  return undefined;
}

export function normalizeCategoryValue(metric: Metric, value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  for (const allowed of metric.allowedValues) {
    if (allowed.canonical.toLowerCase() === trimmed.toLowerCase()) return allowed.canonical;
    for (const alias of allowed.aliases) {
      if (alias.toLowerCase() === trimmed.toLowerCase()) return allowed.canonical;
    }
  }
  return undefined;
}
