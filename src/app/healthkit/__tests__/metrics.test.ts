import { describe, expect, it } from 'vitest';
import { allMetrics, lookup, lookupByMetricType, normalizeCategoryValue, normalizeUnit } from '../metrics.js';

describe('lookup', () => {
  it('maps a known quantity type', () => {
    const metric = lookup('HKQuantityTypeIdentifierHeartRate');
    expect(metric?.metricType).toBe('heart_rate');
    expect(metric?.kind).toBe('quantity');
    expect(metric?.canonicalUnit).toBe('count/min');
  });

  it('maps a known category type', () => {
    const metric = lookup('HKCategoryTypeIdentifierSleepAnalysis');
    expect(metric?.metricType).toBe('sleep_stage');
    expect(metric?.kind).toBe('category');
    expect(metric?.canonicalUnit).toBe('');
  });

  it('reports unknown types as missing rather than throwing, so the caller can store them verbatim', () => {
    expect(lookup('HKQuantityTypeIdentifierSomethingAppleShippedLastTuesday')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(lookup('  HKQuantityTypeIdentifierStepCount\n')?.metricType).toBe('step_count');
  });
});

describe('lookupByMetricType', () => {
  it('finds a known name and refuses an empty or unknown one', () => {
    expect(lookupByMetricType('heart_rate')?.kind).toBe('quantity');
    expect(lookupByMetricType('not_a_metric')).toBeUndefined();
    expect(lookupByMetricType('  ')).toBeUndefined();
  });
});

describe('normalizeUnit', () => {
  const heart = lookup('HKQuantityTypeIdentifierHeartRate')!;
  const mass = lookup('HKQuantityTypeIdentifierBodyMass')!;
  const bp = lookup('HKQuantityTypeIdentifierBloodPressureSystolic')!;

  it('accepts HealthKit spelling and aliases, collapsing them to the canonical unit', () => {
    expect(normalizeUnit(heart, 'count/min')).toBe('count/min');
    expect(normalizeUnit(heart, 'bpm')).toBe('count/min');
    expect(normalizeUnit(bp, 'MMHG')).toBe('mmHg');
    expect(normalizeUnit(mass, ' kg ')).toBe('kg');
  });

  it('rejects a wrong unit, a unit of another metric, and the empty string', () => {
    expect(normalizeUnit(mass, 'lb')).toBeUndefined();
    expect(normalizeUnit(heart, 'mmHg')).toBeUndefined();
    expect(normalizeUnit(heart, '')).toBeUndefined();
  });
});

describe('normalizeCategoryValue', () => {
  const sleep = lookup('HKCategoryTypeIdentifierSleepAnalysis')!;

  it('accepts canonical names, aliases, and HealthKit integer enums', () => {
    expect(normalizeCategoryValue(sleep, 'asleepCore')).toBe('asleepCore');
    expect(normalizeCategoryValue(sleep, 'ASLEEPREM')).toBe('asleepREM');
    expect(normalizeCategoryValue(sleep, '4')).toBe('asleepDeep');
    expect(normalizeCategoryValue(sleep, '0')).toBe('inBed');
    expect(normalizeCategoryValue(sleep, 'asleep')).toBe('asleepUnspecified');
    expect(normalizeCategoryValue(sleep, 'HKCategoryValueSleepAnalysisAwake')).toBe('awake');
  });

  it('rejects an unknown stage, an out-of-range enum, and the empty string', () => {
    expect(normalizeCategoryValue(sleep, 'dreaming')).toBeUndefined();
    expect(normalizeCategoryValue(sleep, '99')).toBeUndefined();
    expect(normalizeCategoryValue(sleep, '')).toBeUndefined();
  });
});

describe('the metric table is self-consistent', () => {
  it('every quantity accepts its own canonical unit and every category accepts its own values', () => {
    for (const [hkType, metric] of allMetrics()) {
      expect(metric.metricType, `${hkType} has no metric type`).not.toBe('');
      if (metric.kind === 'quantity') {
        expect(metric.canonicalUnit, `${hkType} has no canonical unit`).not.toBe('');
        expect(metric.allowedValues, `${hkType} is a quantity metric but lists category values`).toHaveLength(0);
        expect(normalizeUnit(metric, metric.canonicalUnit)).toBe(metric.canonicalUnit);
      } else {
        expect(metric.canonicalUnit, `${hkType} is a category metric but declares a unit`).toBe('');
        expect(metric.allowedValues.length, `${hkType} has no category values`).toBeGreaterThan(0);
        expect(metric.acceptedUnits, `${hkType} is a category metric but accepts units`).toHaveLength(0);
        for (const allowed of metric.allowedValues) {
          expect(normalizeCategoryValue(metric, allowed.canonical)).toBe(allowed.canonical);
        }
      }
    }
  });
});
