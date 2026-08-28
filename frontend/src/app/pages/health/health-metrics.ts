import {HealthMetricSummary} from '../../models/fasten/health-sample';

export type VizKind = 'line' | 'dual-line' | 'bar-daily' | 'sleep-stages' | 'table';

export interface MetricDef {
  id: string
  label: string
  metricTypes: string[]
  viz: VizKind
  unit?: string
  // Unrecognized HealthKit types have no metric_type; the series endpoint filters on hk_type instead.
  hkType?: string
}

export interface CatalogEntry {
  id: string
  def: MetricDef
  summaries: HealthMetricSummary[]
  latestLabel: string
}

export const KNOWN_METRICS: MetricDef[] = [
  {id: 'heart_rate', label: 'Heart Rate', metricTypes: ['heart_rate'], viz: 'line', unit: 'bpm'},
  {id: 'blood_pressure', label: 'Blood Pressure', metricTypes: ['blood_pressure_systolic', 'blood_pressure_diastolic'], viz: 'dual-line', unit: 'mmHg'},
  {id: 'resting_heart_rate', label: 'Resting Heart Rate', metricTypes: ['resting_heart_rate'], viz: 'line', unit: 'bpm'},
  {id: 'heart_rate_variability_sdnn', label: 'Heart Rate Variability', metricTypes: ['heart_rate_variability_sdnn'], viz: 'line', unit: 'ms'},
  {id: 'step_count', label: 'Steps', metricTypes: ['step_count'], viz: 'bar-daily', unit: 'steps'},
  {id: 'sleep_stage', label: 'Sleep', metricTypes: ['sleep_stage'], viz: 'sleep-stages'},
  {id: 'oxygen_saturation', label: 'Oxygen', metricTypes: ['oxygen_saturation'], viz: 'line', unit: '%'},
  {id: 'body_mass', label: 'Weight', metricTypes: ['body_mass'], viz: 'line', unit: 'kg'},
  {id: 'body_temperature', label: 'Body Temperature', metricTypes: ['body_temperature'], viz: 'line', unit: '°C'},
];

export const SLEEP_STAGE_ORDER = ['awake', 'asleepCore', 'asleepDeep', 'asleepREM', 'asleepUnspecified', 'inBed'] as const;

export const SLEEP_STAGE_LABELS: Record<string, string> = {
  awake: 'Awake',
  asleepCore: 'Core',
  asleepDeep: 'Deep',
  asleepREM: 'REM',
  asleepUnspecified: 'Asleep',
  inBed: 'In bed',
};

export const SLEEP_ASLEEP_STAGES = ['asleepCore', 'asleepDeep', 'asleepREM', 'asleepUnspecified'] as const;

export function asleepHours(stages: Record<string, number> | undefined): number {
  if (!stages) return 0;
  return SLEEP_ASLEEP_STAGES.reduce((sum, stage) => sum + (stages[stage] || 0), 0);
}

export function isAsleepStageLabel(label: string | undefined): boolean {
  return !!label && SLEEP_ASLEEP_STAGES.some((stage) => SLEEP_STAGE_LABELS[stage] === label);
}

export type WeightUnit = 'kg' | 'lbs' | 'st';

export const WEIGHT_UNITS: {id: WeightUnit, label: string}[] = [
  {id: 'kg', label: 'kg'},
  {id: 'lbs', label: 'lbs'},
  {id: 'st', label: 'stone'},
];

export const WEIGHT_UNIT_STORAGE_KEY = 'yourphr.health.weightUnit';

const KG_TO_LB = 2.2046226218;

export function kgToWeightUnit(kg: number, unit: WeightUnit): number {
  if (unit === 'lbs') return kg * KG_TO_LB;
  if (unit === 'st') return kg * KG_TO_LB / 14;
  return kg;
}

export function weightUnitLabel(unit: WeightUnit): string {
  if (unit === 'lbs') return 'lbs';
  if (unit === 'st') return 'st';
  return 'kg';
}

// Stone is shown as stones + remaining pounds (12 st 11 lb). kg and lbs stay decimal.
export function formatWeight(kg: number, unit: WeightUnit): string {
  if (unit === 'st') {
    const totalLb = kg * KG_TO_LB;
    let stones = Math.floor(totalLb / 14);
    let pounds = Math.round(totalLb - stones * 14);
    if (pounds === 14) {
      stones += 1;
      pounds = 0;
    }
    return `${stones} st ${pounds} lb`;
  }
  if (unit === 'lbs') return `${(kg * KG_TO_LB).toFixed(1)} lbs`;
  return `${Number.isInteger(kg) ? String(kg) : kg.toFixed(1)} kg`;
}

// Chart y-values for stone are decimal stone; tooltips convert back to st + remaining lb.
export function formatStoneFromDecimal(st: number): string {
  const kg = st * 14 / KG_TO_LB;
  return formatWeight(kg, 'st');
}

// HealthKit's percent unit is a fraction of 1 (0.97 = 97%). Values already in 0–100 pass through
// so a manual reading of 97 still displays as 97%.
export function asPercent(value: number): number {
  if (value >= 0 && value <= 1) return Math.round(value * 1000) / 10;
  return value;
}

export function parseStoredWeightUnit(raw: string | null): WeightUnit {
  if (raw === 'lbs' || raw === 'st' || raw === 'kg') return raw;
  return 'kg';
}

// groupSummaries folds the backend's one-row-per-metric_type catalog into the UI list: blood pressure
// is one entry, unknown HealthKit types still appear, and known types keep a stable order.
export function groupSummaries(summaries: HealthMetricSummary[]): CatalogEntry[] {
  const byType = new Map<string, HealthMetricSummary>();
  const unknown: HealthMetricSummary[] = [];
  for (const summary of summaries || []) {
    if (summary.metric_type) {
      byType.set(summary.metric_type, summary);
    } else {
      unknown.push(summary);
    }
  }

  const used = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const def of KNOWN_METRICS) {
    const matched = def.metricTypes.map((t) => byType.get(t)).filter((s): s is HealthMetricSummary => !!s);
    if (!matched.length) continue;
    def.metricTypes.forEach((t) => used.add(t));
    entries.push({
      id: def.id,
      def,
      summaries: matched,
      latestLabel: formatLatest(def, matched),
    });
  }

  for (const [metricType, summary] of byType) {
    if (used.has(metricType)) continue;
    const def = fallbackDef(summary);
    entries.push({id: def.id, def, summaries: [summary], latestLabel: formatLatest(def, [summary])});
  }
  for (const summary of unknown) {
    const def = fallbackDef(summary);
    entries.push({id: def.id, def, summaries: [summary], latestLabel: formatLatest(def, [summary])});
  }
  return entries;
}

export function seriesMode(viz: VizKind): 'points' | 'day' | 'stages' {
  if (viz === 'bar-daily') return 'day';
  if (viz === 'sleep-stages') return 'stages';
  return 'points';
}

export function humanizeMetricType(metricType: string): string {
  return (metricType || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function humanizeHkType(hkType: string): string {
  const stripped = (hkType || '')
    .replace(/^HKQuantityTypeIdentifier/, '')
    .replace(/^HKCategoryTypeIdentifier/, '')
    .replace(/^HKCorrelationTypeIdentifier/, '');
  if (!stripped || stripped === hkType) return hkType || 'Unknown metric';
  return stripped.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function formatLatest(def: MetricDef, summaries: HealthMetricSummary[], weightUnit: WeightUnit = 'kg'): string {
  if (def.viz === 'dual-line') {
    const sys = summaries.find((s) => s.metric_type === 'blood_pressure_systolic');
    const dia = summaries.find((s) => s.metric_type === 'blood_pressure_diastolic');
    const sysVal = sys?.value_num != null ? String(Math.round(sys.value_num)) : '—';
    const diaVal = dia?.value_num != null ? String(Math.round(dia.value_num)) : '—';
    return `${sysVal}/${diaVal} mmHg`;
  }
  const latest = newest(summaries);
  if (!latest) return '';
  if (def.viz === 'sleep-stages' && latest.value_text) {
    return SLEEP_STAGE_LABELS[latest.value_text] || latest.value_text;
  }
  if (latest.value_num == null) {
    return latest.value_text || '';
  }
  if (def.id === 'body_mass') return formatWeight(latest.value_num, weightUnit);
  const unit = displayUnit(def, latest.unit);
  return `${formatNumber(latest.value_num, def)}${unit ? ' ' + unit : ''}`;
}

export function displayUnit(def: MetricDef, stored?: string, weightUnit: WeightUnit = 'kg'): string {
  if (def.id === 'body_mass') return weightUnitLabel(weightUnit);
  if (def.unit) return def.unit;
  if (stored === 'count/min') return 'bpm';
  return stored || '';
}

function fallbackDef(summary: HealthMetricSummary): MetricDef {
  const hasNum = summary.value_num != null;
  if (summary.metric_type) {
    return {
      id: summary.metric_type,
      label: humanizeMetricType(summary.metric_type),
      metricTypes: [summary.metric_type],
      viz: hasNum ? 'line' : 'table',
      unit: displayUnit({id: '', label: '', metricTypes: [], viz: 'line'}, summary.unit),
    };
  }
  return {
    id: `hk:${summary.hk_type}`,
    label: humanizeHkType(summary.hk_type),
    metricTypes: [],
    viz: hasNum ? 'line' : 'table',
    unit: summary.unit,
    hkType: summary.hk_type,
  };
}

function newest(summaries: HealthMetricSummary[]): HealthMetricSummary | undefined {
  return [...summaries].sort((a, b) => Date.parse(b.latest_at) - Date.parse(a.latest_at))[0];
}

function formatNumber(value: number, def: MetricDef): string {
  const n = def.id === 'oxygen_saturation' ? asPercent(value) : value;
  if (def.id === 'step_count') return Math.round(n).toLocaleString();
  if (def.unit === 'kg' || def.unit === '°C' || def.unit === '%') {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
