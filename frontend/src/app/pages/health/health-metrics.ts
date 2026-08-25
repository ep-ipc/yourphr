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

export function formatLatest(def: MetricDef, summaries: HealthMetricSummary[]): string {
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
  const unit = displayUnit(def, latest.unit);
  return `${formatNumber(latest.value_num, def)}${unit ? ' ' + unit : ''}`;
}

export function displayUnit(def: MetricDef, stored?: string): string {
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
  if (def.id === 'step_count') return Math.round(value).toLocaleString();
  if (def.unit === 'kg' || def.unit === '°C' || def.unit === '%') {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
