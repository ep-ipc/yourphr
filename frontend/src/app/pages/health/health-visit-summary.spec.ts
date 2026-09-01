import {CatalogEntry} from './health-metrics';
import {
  buildPrintChartConfig,
  buildVisitSummaryHtml,
  defaultSummarySelection,
  emptySeries,
  escapeHtml,
  hasSummarySelection,
  tableSectionFromEntry,
  visitSummaryFilename,
  visitSummaryWindow,
} from './health-visit-summary';

describe('health visit summary', () => {
  const generatedAt = new Date(2026, 7, 28, 14, 30, 0);

  it('names the file for the local calendar day', () => {
    expect(visitSummaryFilename(generatedAt)).toBe('yourphr-health-20260828.html');
  });

  it('defaults every catalog metric to selected', () => {
    const selected = defaultSummarySelection([
      {id: 'heart_rate'} as CatalogEntry,
      {id: 'blood_pressure'} as CatalogEntry,
    ]);
    expect(selected).toEqual({heart_rate: true, blood_pressure: true});
    expect(hasSummarySelection(selected)).toBeTrue();
    expect(hasSummarySelection({heart_rate: false, blood_pressure: false})).toBeFalse();
  });

  it('labels a 30-day window from now', () => {
    const now = new Date('2026-08-28T16:00:00.000Z');
    const window = visitSummaryWindow('30d', now);
    expect(window.startAfter).toBe(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
    expect(window.startBefore).toBe(now.toISOString());
    expect(window.label).toContain('2026');
    expect(visitSummaryWindow('all', now)).toEqual({start: null, end: now, label: 'All time'});
  });

  it('builds HTML with the chosen metrics, window, and no patient when absent', () => {
    const html = buildVisitSummaryHtml({
      generatedAt,
      windowLabel: 'Jul 29, 2026 – Aug 28, 2026',
      lastSyncedAt: '2026-08-24T12:10:00Z',
      sections: [{
        id: 'heart_rate',
        label: 'Heart Rate',
        latestLabel: '72 bpm',
        unit: 'bpm',
        stats: {min: 70, max: 80, avg: 75},
        sampleCount: 40,
        downsampled: false,
        chartPng: 'data:image/png;base64,abc',
      }],
    });
    expect(html).toContain('Health visit summary');
    expect(html).toContain('Heart Rate');
    expect(html).toContain('Jul 29, 2026 – Aug 28, 2026');
    expect(html).toContain('Apple Health');
    expect(html).toContain('72 bpm');
    expect(html).toContain('Min 70');
    expect(html).toContain('data:image/png;base64,abc');
    expect(html).not.toContain('Born');
    expect(html).toContain('page-break-inside: avoid');
  });

  it('includes patient name and birth date when present, escaped', () => {
    const html = buildVisitSummaryHtml({
      generatedAt,
      windowLabel: 'All time',
      patient: {name: 'Ada <script>', birthDate: '1935-12-10'},
      sections: [],
    });
    expect(html).toContain('Ada &lt;script&gt;');
    expect(html).not.toContain('Ada <script>');
    expect(html).toContain('Born 1935-12-10');
  });

  it('renders an empty series as a note rather than a broken image', () => {
    const html = buildVisitSummaryHtml({
      generatedAt,
      windowLabel: 'All time',
      sections: [{
        id: 'heart_rate',
        label: 'Heart Rate',
        latestLabel: '72 bpm',
        unit: 'bpm',
        stats: null,
        sampleCount: 0,
        downsampled: false,
        empty: true,
      }],
    });
    expect(html).toContain('No samples in this time range.');
    expect(html).not.toContain('<img');
  });

  it('renders a failed series as a note rather than a broken image', () => {
    const html = buildVisitSummaryHtml({
      generatedAt,
      windowLabel: 'All time',
      sections: [{
        id: 'heart_rate',
        label: 'Heart Rate',
        latestLabel: '',
        unit: '',
        stats: null,
        sampleCount: 0,
        downsampled: false,
        error: true,
      }],
    });
    expect(html).toContain('This metric could not be loaded.');
    expect(html).not.toContain('<img');
  });

  it('escapes names in titles', () => {
    expect(escapeHtml('a <b> & "c"')).toBe('a &lt;b&gt; &amp; &quot;c&quot;');
  });

  it('turns a table-only metric into latest-value rows, not a chart', () => {
    const entry: CatalogEntry = {
      id: 'mindful',
      def: {id: 'mindful', label: 'Mindful Minutes', metricTypes: ['mindful'], viz: 'table'},
      summaries: [{
        metric_type: 'mindful',
        hk_type: 'HKCategoryTypeIdentifierMindfulSession',
        latest_at: '2026-08-24T12:00:00Z',
        earliest_at: '2026-08-01T00:00:00Z',
        sample_count: 3,
        value_text: 'session',
      }],
      latestLabel: 'session',
    };
    const section = tableSectionFromEntry(entry);
    expect(section.tableRows).toEqual([
      {label: 'Latest', value: 'session'},
      {label: 'Samples', value: '3'},
    ]);
    const html = buildVisitSummaryHtml({
      generatedAt,
      windowLabel: 'All time',
      sections: [section],
    });
    expect(html).toContain('Mindful Minutes');
    expect(html).toContain('<table>');
    expect(html).not.toContain('<img');
  });

  it('builds a line chart config from points and marks an empty series', () => {
    const def = {id: 'heart_rate', label: 'Heart Rate', metricTypes: ['heart_rate'], viz: 'line' as const, unit: 'bpm'};
    const withData = buildPrintChartConfig(
      def,
      {total: 2, downsampled: false, points: [{t: '2026-08-24T10:00:00Z', v: 70}, {t: '2026-08-24T11:00:00Z', v: 80}]},
      'kg',
      '30d',
      new Date('2026-07-29T16:00:00Z'),
      new Date('2026-08-28T16:00:00Z'),
    );
    expect(withData.hasData).toBeTrue();
    expect(withData.type).toBe('line');
    expect((withData.data.datasets[0].data as {y: number}[]).map((p) => p.y)).toEqual([70, 80]);

    const empty = buildPrintChartConfig(def, emptySeries(), 'kg', '30d', null, new Date());
    expect(empty.hasData).toBeFalse();
  });
});
