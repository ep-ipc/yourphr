import {HealthMetricSummary} from '../../models/fasten/health-sample';
import {
  CatalogEntry,
  formatLatest,
  groupSummaries,
  humanizeHkType,
  KNOWN_METRICS,
  seriesMode,
} from './health-metrics';

describe('groupSummaries', () => {
  const hr: HealthMetricSummary = {
    metric_type: 'heart_rate',
    hk_type: 'HKQuantityTypeIdentifierHeartRate',
    unit: 'count/min',
    value_num: 72,
    latest_at: '2026-08-24T12:00:00Z',
    earliest_at: '2026-01-01T00:00:00Z',
    sample_count: 10,
  };
  const sys: HealthMetricSummary = {
    metric_type: 'blood_pressure_systolic',
    hk_type: 'HKQuantityTypeIdentifierBloodPressureSystolic',
    unit: 'mmHg',
    value_num: 118,
    latest_at: '2026-08-24T08:00:00Z',
    earliest_at: '2026-01-01T00:00:00Z',
    sample_count: 4,
  };
  const dia: HealthMetricSummary = {
    metric_type: 'blood_pressure_diastolic',
    hk_type: 'HKQuantityTypeIdentifierBloodPressureDiastolic',
    unit: 'mmHg',
    value_num: 76,
    latest_at: '2026-08-24T08:00:00Z',
    earliest_at: '2026-01-01T00:00:00Z',
    sample_count: 4,
  };
  const unknown: HealthMetricSummary = {
    metric_type: '',
    hk_type: 'HKQuantityTypeIdentifierRespiratoryRate',
    unit: 'count/min',
    value_num: 16,
    latest_at: '2026-08-24T09:00:00Z',
    earliest_at: '2026-08-20T00:00:00Z',
    sample_count: 2,
  };

  it('merges systolic and diastolic into one blood pressure row', () => {
    const entries = groupSummaries([hr, sys, dia]);
    const bp = entries.find((e) => e.id === 'blood_pressure');
    expect(bp).toBeTruthy();
    expect(bp.def.viz).toBe('dual-line');
    expect(bp.latestLabel).toBe('118/76 mmHg');
    expect(entries.find((e) => e.id === 'heart_rate').latestLabel).toBe('72 bpm');
  });

  it('keeps unknown HealthKit types in the catalog with a line fallback', () => {
    const entries = groupSummaries([unknown]);
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe('hk:HKQuantityTypeIdentifierRespiratoryRate');
    expect(entries[0].def.viz).toBe('line');
    expect(entries[0].def.hkType).toBe('HKQuantityTypeIdentifierRespiratoryRate');
    expect(entries[0].def.label).toBe('Respiratory Rate');
  });

  it('lists known metrics before unknown ones and in registry order', () => {
    const entries = groupSummaries([unknown, dia, hr, sys]);
    expect(entries.map((e) => e.id)).toEqual([
      'heart_rate',
      'blood_pressure',
      'hk:HKQuantityTypeIdentifierRespiratoryRate',
    ]);
  });
});

describe('seriesMode', () => {
  it('maps visualizations onto the series endpoint modes', () => {
    expect(seriesMode('line')).toBe('points');
    expect(seriesMode('dual-line')).toBe('points');
    expect(seriesMode('bar-daily')).toBe('day');
    expect(seriesMode('sleep-stages')).toBe('stages');
  });
});

describe('humanizeHkType', () => {
  it('strips the HealthKit prefix', () => {
    expect(humanizeHkType('HKQuantityTypeIdentifierRespiratoryRate')).toBe('Respiratory Rate');
  });
});

describe('formatLatest', () => {
  it('renders a known metric from the registry', () => {
    const def = KNOWN_METRICS.find((m) => m.id === 'heart_rate');
    const entry: CatalogEntry = {
      id: def.id,
      def,
      summaries: [{
        metric_type: 'heart_rate',
        hk_type: 'HKQuantityTypeIdentifierHeartRate',
        unit: 'count/min',
        value_num: 72.4,
        latest_at: '2026-08-24T12:00:00Z',
        earliest_at: '2026-01-01T00:00:00Z',
        sample_count: 1,
      }],
      latestLabel: '',
    };
    expect(formatLatest(entry.def, entry.summaries)).toBe('72.4 bpm');
  });
});
