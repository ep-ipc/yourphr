import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { Engine } from '../../../framework/Engine.js';
import { ApiContext } from '../../../framework/ApiContext.js';
import { HealthManager, HEALTH_SAMPLE_MAX_BATCH } from '../../managers/HealthManager.js';
import { SqliteHealthProvider } from '../SqliteHealthProvider.js';

let db: InstanceType<typeof Database>;
let engine: Engine;
let health: HealthManager;
let jim: ApiContext;
let pat: ApiContext;

const device = { device_id: 'iphone-1', name: 'Jim\'s iPhone' };

function quantity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: 'hr-1',
    type: 'HKQuantityTypeIdentifierHeartRate',
    start: '2026-08-24T12:00:00Z',
    end: '2026-08-24T12:00:00Z',
    value: 72,
    unit: 'count/min',
    source_name: 'Apple Watch',
    ...over,
  };
}

async function boot(): Promise<void> {
  db = new Database(':memory:');
  engine = new Engine();
  health = new HealthManager(engine, new SqliteHealthProvider(db));
  engine.register('health', health);
  await engine.initialize();
  jim = ApiContext.from({ username: 'jim', role: 'user' }, engine);
  pat = ApiContext.from({ username: 'pat', role: 'user' }, engine);
}

beforeEach(async () => { await boot(); });

describe('ingest', () => {
  it('stores a valid sample and reports received/accepted/stored', async () => {
    const result = await health.ingest(jim, { device, samples: [quantity()] });
    expect(result).toMatchObject({ received: 1, accepted: 1, stored: 1, duplicates: 0, rejected: 0 });
  });

  it('is idempotent on HealthKit uuid — a retry is a duplicate, not a second row', async () => {
    await health.ingest(jim, { device, samples: [quantity()] });
    const again = await health.ingest(jim, { device, samples: [quantity()] });
    expect(again).toMatchObject({ received: 1, accepted: 1, stored: 0, duplicates: 1, rejected: 0 });
    expect((await health.list(jim, {})).total).toBe(1);
  });

  it('rejects a known type with a bad unit, and stores an unknown type verbatim', async () => {
    const result = await health.ingest(jim, {
      device,
      samples: [
        quantity({ uuid: 'bad', unit: 'furlongs' }),
        quantity({ uuid: 'new', type: 'HKQuantityTypeIdentifierSomethingNew', unit: 'widget' }),
      ],
    });
    expect(result.rejected).toBe(1);
    expect(result.accepted).toBe(1);
    expect(result.errors?.[0]?.reason).toMatch(/expects unit/);
    const listed = await health.list(jim, {});
    expect(listed.samples[0]?.metric_type).toBe('');
    expect(listed.samples[0]?.hk_type).toBe('HKQuantityTypeIdentifierSomethingNew');
  });

  it('refuses a missing device_id and a batch over the cap', async () => {
    await expect(health.ingest(jim, { device: { device_id: '' }, samples: [] })).rejects.toThrow(/device_id is required/);
    const tooMany = Array.from({ length: HEALTH_SAMPLE_MAX_BATCH + 1 }, (_, i) => quantity({ uuid: `u-${i}` }));
    await expect(health.ingest(jim, { device, samples: tooMany })).rejects.toThrow(/maximum is/);
  });

  it('records opaque anchors after the samples they describe', async () => {
    await health.ingest(jim, {
      device,
      samples: [quantity()],
      anchors: { heart_rate: 'opaque-anchor' },
    });
    const states = await health.syncState(jim, 'iphone-1');
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ device_id: 'iphone-1', metric_type: 'heart_rate', anchor: 'opaque-anchor' });
  });

  it('never stores another account\'s samples under this one', async () => {
    await health.ingest(jim, { device, samples: [quantity()] });
    await health.ingest(pat, { device: { device_id: 'pat-phone' }, samples: [quantity({ uuid: 'pat-hr' })] });
    expect((await health.list(jim, {})).total).toBe(1);
    expect((await health.list(pat, {})).total).toBe(1);
    expect((await health.list(pat, {})).samples[0]?.external_uuid).toBe('pat-hr');
  });
});

describe('reads', () => {
  it('summarizes metrics and charts a points series', async () => {
    await health.ingest(jim, {
      device,
      samples: [
        quantity({ uuid: 'a', start: '2026-08-24T10:00:00Z', end: '2026-08-24T10:00:00Z', value: 70 }),
        quantity({ uuid: 'b', start: '2026-08-24T11:00:00Z', end: '2026-08-24T11:00:00Z', value: 80 }),
      ],
      anchors: { heart_rate: 'a1' },
    });
    const catalog = await health.metrics(jim);
    expect(catalog.metrics[0]?.metric_type).toBe('heart_rate');
    expect(catalog.metrics[0]?.sample_count).toBe(2);
    expect(catalog.last_synced_at).toBeTruthy();

    const series = await health.series(jim, { metricTypes: ['heart_rate'], mode: 'points' });
    expect(series.total).toBe(2);
    expect(series.downsampled).toBe(false);
    expect(series.points?.map((p) => p.v)).toEqual([70, 80]);
    expect(series.stats).toMatchObject({ min: 70, max: 80, avg: 75 });
  });

  it('sums steps by UTC day and buckets sleep by night', async () => {
    await health.ingest(jim, {
      device,
      samples: [
        quantity({ uuid: 's1', type: 'HKQuantityTypeIdentifierStepCount', start: '2026-08-24T01:00:00Z', end: '2026-08-24T01:00:00Z', value: 100, unit: 'count' }),
        quantity({ uuid: 's2', type: 'HKQuantityTypeIdentifierStepCount', start: '2026-08-24T02:00:00Z', end: '2026-08-24T02:00:00Z', value: 50, unit: 'count' }),
        {
          uuid: 'sleep-1',
          type: 'HKCategoryTypeIdentifierSleepAnalysis',
          start: '2026-08-24T04:00:00Z',
          end: '2026-08-24T06:00:00Z',
          value_text: 'asleepDeep',
        },
      ],
    });
    const daily = await health.series(jim, { metricTypes: ['step_count'], mode: 'day' });
    expect(daily.daily).toEqual([{ date: '2026-08-24', value: 150 }]);

    const nights = await health.series(jim, { metricTypes: ['sleep_stage'], mode: 'stages' });
    // 04:00–06:00 UTC minus 12 hours buckets onto 2026-08-23.
    expect(nights.nights?.[0]?.date).toBe('2026-08-23');
    expect(nights.nights?.[0]?.stages.asleepDeep).toBeCloseTo(2, 5);
  });

  it('refuses a series without a metric and an unknown mode', async () => {
    await expect(health.series(jim, {})).rejects.toThrow(/metric_type or hk_type/);
    await expect(health.series(jim, { metricTypes: ['heart_rate'], mode: 'weekly' })).rejects.toThrow(/points, day, or stages/);
  });

  it('an account\'s samples go when the account does', async () => {
    await health.ingest(jim, { device, samples: [quantity()] });
    await health.ingest(pat, { device: { device_id: 'pat-phone' }, samples: [quantity({ uuid: 'pat-hr' })] });
    await health.removeForUser(jim);
    expect((await health.list(jim, {})).total).toBe(0);
    expect((await health.list(pat, {})).total).toBe(1);
  });
});
