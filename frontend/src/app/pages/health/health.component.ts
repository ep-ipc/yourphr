import {Component, OnInit} from '@angular/core';
import {CommonModule} from '@angular/common';
import {forkJoin, of} from 'rxjs';
import {catchError} from 'rxjs/operators';
import {ChartConfiguration, ChartData} from 'chart.js';
import {BaseChartDirective} from 'ng2-charts';
import {FastenApiService} from '../../services/fasten-api.service';
import {HealthSample, HealthSeries, HealthSeriesPoint} from '../../models/fasten/health-sample';
import {LoadingSpinnerComponent} from '../../components/loading-spinner/loading-spinner.component';
import {
  asPercent,
  CatalogEntry,
  displayUnit,
  formatLatest,
  formatStoneFromDecimal,
  formatWeight,
  groupSummaries,
  isAsleepStageLabel,
  kgToWeightUnit,
  MetricDef,
  parseStoredWeightUnit,
  seriesMode,
  SLEEP_STAGE_LABELS,
  SLEEP_STAGE_ORDER,
  WEIGHT_UNIT_STORAGE_KEY,
  WEIGHT_UNITS,
  WeightUnit,
  weightUnitLabel,
} from './health-metrics';

export type RangePreset = '24h' | '5d' | '30d' | '90d' | 'all';
export type ViewMode = 'chart' | 'table';

export const RANGE_MS: Record<Exclude<RangePreset, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '5d': 5 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

const TABLE_PAGE = 50;

const INDIGO = 'rgb(102, 16, 242)';
const INDIGO_FILL = 'rgba(102, 16, 242, 0.12)';
const TEAL = 'rgb(13, 202, 240)';
const SLEEP_COLORS: Record<string, string> = {
  awake: 'rgba(253, 126, 20, 0.85)',
  asleepCore: 'rgba(13, 110, 253, 0.85)',
  asleepDeep: 'rgba(102, 16, 242, 0.85)',
  asleepREM: 'rgba(111, 66, 193, 0.65)',
  asleepUnspecified: 'rgba(108, 117, 125, 0.7)',
  inBed: 'rgba(173, 181, 189, 0.7)',
};

export interface TableRow {
  time: string
  value: string
  unit: string
  source: string
}

@Component({
  standalone: true,
  imports: [CommonModule, BaseChartDirective, LoadingSpinnerComponent],
  selector: 'app-health',
  templateUrl: './health.component.html',
  styleUrls: ['./health.component.scss'],
})
export class HealthComponent implements OnInit {
  loading = true;
  errored = false;
  detailLoading = false;

  entries: CatalogEntry[] = [];
  selectedId = '';
  lastSyncedAt: string | null = null;

  view: ViewMode = 'chart';
  range: RangePreset = '5d';
  rangePresets: {id: RangePreset, label: string}[] = [
    {id: '24h', label: '24h'},
    {id: '5d', label: '5 days'},
    {id: '30d', label: '30 days'},
    {id: '90d', label: '90 days'},
    {id: 'all', label: 'All'},
  ];
  windowEnd = new Date();

  chartType: 'line' | 'bar' = 'line';
  chartData: ChartData = {labels: [], datasets: []};
  chartOptions: ChartConfiguration['options'] = defaultChartOptions('line', '', {
    range: '5d',
    windowStart: null,
    windowEnd: new Date(),
  });
  hasChartData = false;
  seriesTotal = 0;
  seriesStats: {min?: number, max?: number, avg?: number} | null = null;
  downsampled = false;
  seriesUnit = '';

  tableRows: TableRow[] = [];
  tableTotal = 0;
  tableOffset = 0;
  tablePageSize = TABLE_PAGE;

  weightUnit: WeightUnit = 'kg';
  weightUnits = WEIGHT_UNITS;
  private rawSeries: HealthSeries | null = null;
  private rawSamples: HealthSample[] = [];

  constructor(private fastenApi: FastenApiService) {}

  ngOnInit(): void {
    this.weightUnit = parseStoredWeightUnit(safeLocalStorageGet(WEIGHT_UNIT_STORAGE_KEY));
    this.fastenApi.getHealthMetrics().subscribe({
      next: (catalog) => {
        this.entries = groupSummaries(catalog.metrics || []);
        this.applyWeightLabels();
        this.lastSyncedAt = catalog.last_synced_at || null;
        this.selectedId = this.entries[0]?.id || '';
        this.loading = false;
        if (this.selectedId) this.loadDetail();
      },
      error: () => {
        this.errored = true;
        this.loading = false;
      },
    });
  }

  get selected(): CatalogEntry | undefined {
    return this.entries.find((e) => e.id === this.selectedId);
  }

  get windowStart(): Date | null {
    if (this.range === 'all') return null;
    return new Date(this.windowEnd.getTime() - RANGE_MS[this.range]);
  }

  get windowLabel(): string {
    if (this.range === 'all') return 'All time';
    const start = this.windowStart;
    if (!start) return '';
    return `${formatDay(start)} – ${formatDay(new Date(this.windowEnd.getTime() - 1))}`;
  }

  get canPageBack(): boolean {
    if (this.range === 'all' || !this.selected) return false;
    const earliest = earliestOf(this.selected);
    const start = this.windowStart;
    return !!(earliest && start && start.getTime() > earliest.getTime());
  }

  get canPageForward(): boolean {
    if (this.range === 'all') return false;
    return this.windowEnd.getTime() < Date.now() - 1000;
  }

  get sliderMin(): number {
    const earliest = this.selected ? earliestOf(this.selected) : null;
    return earliest ? earliest.getTime() : 0;
  }

  get sliderMax(): number {
    if (this.range === 'all') return 0;
    const duration = RANGE_MS[this.range];
    const earliest = this.selected ? earliestOf(this.selected) : null;
    const latestStart = Date.now() - duration;
    if (earliest && earliest.getTime() > latestStart) return earliest.getTime();
    return latestStart;
  }

  get sliderValue(): number {
    return this.windowStart?.getTime() ?? this.sliderMin;
  }

  get tableFrom(): number {
    if (this.tableTotal === 0) return 0;
    return this.tableOffset + 1;
  }

  get tableTo(): number {
    return Math.min(this.tableOffset + this.tableRows.length, this.tableTotal);
  }

  get sourceLabel(): string {
    const summary = this.selected?.summaries[0];
    return summary?.device_name || summary?.source_name || 'Apple Health';
  }

  selectMetric(id: string): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.tableOffset = 0;
    const entry = this.entries.find((e) => e.id === id);
    if (entry?.def.viz === 'table') this.view = 'table';
    this.loadDetail();
  }

  setView(view: ViewMode): void {
    if (view === this.view) return;
    this.view = view;
    this.tableOffset = 0;
    this.loadDetail();
  }

  setRange(range: RangePreset): void {
    this.range = range;
    this.windowEnd = new Date();
    this.tableOffset = 0;
    this.loadDetail();
  }

  pageWindow(direction: -1 | 1): void {
    if (this.range === 'all') return;
    const duration = RANGE_MS[this.range];
    const next = new Date(this.windowEnd.getTime() + direction * duration);
    const now = new Date();
    if (direction > 0 && next.getTime() > now.getTime()) {
      this.windowEnd = now;
    } else {
      this.windowEnd = next;
    }
    this.tableOffset = 0;
    this.loadDetail();
  }

  onSliderInput(raw: string): void {
    if (this.range === 'all') return;
    const start = Number(raw);
    if (!Number.isFinite(start)) return;
    this.windowEnd = new Date(start + RANGE_MS[this.range]);
    this.tableOffset = 0;
    this.loadDetail();
  }

  pageTable(direction: -1 | 1): void {
    const next = this.tableOffset + direction * TABLE_PAGE;
    if (next < 0 || next >= this.tableTotal) return;
    this.tableOffset = next;
    this.loadDetail();
  }

  setWeightUnit(unit: WeightUnit): void {
    if (unit === this.weightUnit) return;
    this.weightUnit = unit;
    safeLocalStorageSet(WEIGHT_UNIT_STORAGE_KEY, unit);
    this.applyWeightLabels();
    const entry = this.selected;
    if (entry?.id !== 'body_mass') return;
    if (this.view === 'table') {
      this.tableRows = toTableRows(entry.def, this.rawSamples, this.weightUnit);
      return;
    }
    if (this.rawSeries) this.applySeries(entry.def, this.rawSeries);
  }

  get showWeightUnits(): boolean {
    return this.selected?.id === 'body_mass';
  }

  formatChartStat(value: number | undefined | null): string {
    if (value == null || Number.isNaN(value)) return '';
    if (this.showWeightUnits && this.weightUnit === 'st') {
      return formatStoneFromDecimal(value);
    }
    return value.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 1});
  }

  private applyWeightLabels(): void {
    for (const entry of this.entries) {
      if (entry.id === 'body_mass') {
        entry.latestLabel = formatLatest(entry.def, entry.summaries, this.weightUnit);
      }
    }
  }

  private loadDetail(): void {
    const entry = this.selected;
    if (!entry) return;
    this.detailLoading = true;
    if (this.view === 'table' || entry.def.viz === 'table') {
      this.loadTable(entry);
      return;
    }
    this.loadChart(entry);
  }

  private queryWindow(): {startAfter?: string, startBefore?: string} {
    const bounds: {startAfter?: string, startBefore?: string} = {};
    if (this.windowStart) bounds.startAfter = this.windowStart.toISOString();
    if (this.range !== 'all') bounds.startBefore = this.windowEnd.toISOString();
    return bounds;
  }

  private loadChart(entry: CatalogEntry): void {
    const bounds = this.queryWindow();
    const mode = seriesMode(entry.def.viz);
    if (entry.def.viz === 'dual-line') {
      forkJoin({
        sys: this.fastenApi.getHealthSeries({metricTypes: ['blood_pressure_systolic'], mode, ...bounds}),
        dia: this.fastenApi.getHealthSeries({metricTypes: ['blood_pressure_diastolic'], mode, ...bounds}),
      }).pipe(catchError(() => of({sys: emptySeries(), dia: emptySeries()}))).subscribe({
        next: ({sys, dia}) => {
          this.applyDualSeries(sys, dia);
          this.detailLoading = false;
        },
        error: () => { this.detailLoading = false; },
      });
      return;
    }
    this.fastenApi.getHealthSeries({
      metricTypes: entry.def.metricTypes.length ? entry.def.metricTypes : undefined,
      hkType: entry.def.hkType,
      mode,
      ...bounds,
    }).subscribe({
      next: (series) => {
        this.applySeries(entry.def, series);
        this.detailLoading = false;
      },
      error: () => { this.detailLoading = false; },
    });
  }

  private loadTable(entry: CatalogEntry): void {
    const bounds = this.queryWindow();
    this.fastenApi.listHealthSamples({
      metricTypes: entry.def.metricTypes.length ? entry.def.metricTypes : undefined,
      hkType: entry.def.hkType,
      startAfter: bounds.startAfter,
      startBefore: bounds.startBefore,
      limit: TABLE_PAGE,
      offset: this.tableOffset,
      sort: 'desc',
    }).subscribe({
      next: (page) => {
        this.tableTotal = page.total;
        this.rawSamples = page.samples;
        this.tableRows = toTableRows(entry.def, page.samples, this.weightUnit);
        this.view = 'table';
        this.detailLoading = false;
      },
      error: () => { this.detailLoading = false; },
    });
  }

  private applySeries(def: MetricDef, series: HealthSeries): void {
    this.rawSeries = series;
    this.seriesTotal = series.total || 0;
    this.seriesStats = convertStats(series.stats, def, this.weightUnit);
    this.downsampled = !!series.downsampled;
    this.seriesUnit = displayUnit(def, series.unit, this.weightUnit);
    const convert = (v: number) => {
      if (def.id === 'body_mass') return kgToWeightUnit(v, this.weightUnit);
      if (def.id === 'oxygen_saturation') return asPercent(v);
      return v;
    };
    if (def.viz === 'bar-daily') {
      this.chartType = 'bar';
      const data = toDayPoints(series.daily || [], convert);
      this.hasChartData = data.length > 0;
      this.chartData = {
        datasets: [{
          label: def.label,
          data,
          backgroundColor: INDIGO,
          maxBarThickness: 40,
        }],
      };
      this.chartOptions = this.chartOptionsFor('bar', this.seriesUnit || def.unit || '');
      return;
    }
    if (def.viz === 'sleep-stages') {
      this.chartType = 'bar';
      const nights = series.nights || [];
      this.hasChartData = nights.length > 0;
      this.chartData = {
        datasets: SLEEP_STAGE_ORDER.filter((stage) => nights.some((n) => (n.stages?.[stage] || 0) > 0)).map((stage) => ({
          label: SLEEP_STAGE_LABELS[stage] || stage,
          data: toDayPoints(nights.map((n) => ({date: n.date, value: n.stages?.[stage] || 0}))),
          backgroundColor: SLEEP_COLORS[stage],
          stack: 'sleep',
          maxBarThickness: 40,
        })),
      };
      this.chartOptions = this.chartOptionsFor('bar', 'hours', true);
      return;
    }
    this.chartType = 'line';
    const points = toTimePoints(series.points || [], convert);
    this.hasChartData = points.length > 0;
    this.chartData = {
      datasets: [{
        label: def.label,
        data: points,
        borderColor: INDIGO,
        backgroundColor: INDIGO_FILL,
        pointRadius: points.length > 80 ? 0 : 2,
        fill: true,
        tension: 0.2,
      }],
    };
    this.chartOptions = this.chartOptionsFor('line', this.seriesUnit);
  }

  private applyDualSeries(sys: HealthSeries, dia: HealthSeries): void {
    const sysPoints = toTimePoints(sys.points || []);
    const diaPoints = toTimePoints(dia.points || []);
    this.chartType = 'line';
    this.seriesTotal = (sys.total || 0) + (dia.total || 0);
    this.downsampled = !!(sys.downsampled || dia.downsampled);
    this.seriesUnit = 'mmHg';
    this.seriesStats = sys.stats || dia.stats || null;
    this.hasChartData = sysPoints.length > 0 || diaPoints.length > 0;
    this.chartData = {
      datasets: [
        {label: 'Systolic', data: sysPoints, borderColor: INDIGO, pointRadius: 3, tension: 0.1},
        {label: 'Diastolic', data: diaPoints, borderColor: TEAL, pointRadius: 3, tension: 0.1},
      ],
    };
    this.chartOptions = this.chartOptionsFor('line', 'mmHg');
  }

  private chartOptionsFor(kind: 'line' | 'bar', unit: string, stacked = false): ChartConfiguration['options'] {
    return defaultChartOptions(kind, unit, {
      stacked,
      range: this.range,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
    });
  }
}

function emptySeries(): HealthSeries {
  return {total: 0, downsampled: false, points: []};
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // display preference only
  }
}

function earliestOf(entry: CatalogEntry): Date | null {
  const times = entry.summaries.map((s) => Date.parse(s.earliest_at)).filter((n) => Number.isFinite(n));
  if (!times.length) return null;
  return new Date(Math.min(...times));
}

function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

export interface HealthChartPoint {
  x: number
  y: number
}

export function toTimePoints(points: HealthSeriesPoint[], convert: (v: number) => number = (v) => v): HealthChartPoint[] {
  return points
    .map((p) => ({x: Date.parse(p.t), y: convert(p.v)}))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

export function toDayPoints(days: {date: string, value: number}[], convert: (v: number) => number = (v) => v): HealthChartPoint[] {
  return days
    .map((d) => ({x: utcDayMs(d.date), y: convert(d.value)}))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

// Daily buckets are UTC calendar dates (YYYY-MM-DD). Plot at local noon so the bar sits on that
// calendar date on a local time axis, rather than shifting when UTC midnight falls on the prior day.
export function utcDayMs(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return Date.parse(date);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0).getTime();
}

export function timeAxisBounds(
  range: RangePreset,
  windowStart: Date | null,
  windowEnd: Date,
): {min?: number, max?: number} {
  if (range === 'all' || !windowStart) return {};
  return {min: windowStart.getTime(), max: windowEnd.getTime()};
}

export function buildTimeTicks(min: number, max: number, range: RangePreset): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const ticks: number[] = [];
  const cursor = new Date(min);
  if (range === '24h') {
    const hour = cursor.getHours();
    cursor.setHours(hour - (hour % 4), 0, 0, 0);
    if (cursor.getTime() < min) cursor.setHours(cursor.getHours() + 4);
    while (cursor.getTime() <= max && ticks.length < 12) {
      ticks.push(cursor.getTime());
      cursor.setHours(cursor.getHours() + 4);
    }
    return ticks;
  }
  cursor.setHours(0, 0, 0, 0);
  if (cursor.getTime() < min) cursor.setDate(cursor.getDate() + 1);
  const stepDays = tickStepDays(range, max - min);
  while (cursor.getTime() <= max && ticks.length < 12) {
    ticks.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + stepDays);
  }
  return ticks;
}

function tickStepDays(range: RangePreset, spanMs: number): number {
  if (range === '5d') return 1;
  if (range === '30d') return 5;
  if (range === '90d') return 14;
  const day = 24 * 60 * 60 * 1000;
  if (spanMs <= 16 * day) return 1;
  if (spanMs <= 90 * day) return 7;
  if (spanMs <= 400 * day) return 30;
  return 90;
}

function formatTickMs(ms: number, range: RangePreset): string {
  const d = new Date(ms);
  if (range === '24h') {
    return d.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
  }
  if (range === '5d') {
    return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
  }
  return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

function formatTooltipTime(ms: number, kind: 'line' | 'bar'): string {
  const d = new Date(ms);
  if (kind === 'bar') {
    return d.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
  }
  return d.toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}

export interface SleepTooltipItem {
  parsed: {x?: number, y?: number | null}
  dataset: {label?: string, data?: unknown}
  chart?: {data?: {datasets?: {label?: string, data?: unknown}[]}}
}

export function sleepAsleepTotal(items: SleepTooltipItem[]): number {
  if (!items.length) return 0;
  const x = items[0].parsed.x;
  const datasets = items[0].chart?.data?.datasets;
  if (datasets?.length && x != null) {
    let total = 0;
    for (const dataset of datasets) {
      if (!isAsleepStageLabel(dataset.label)) continue;
      const points = (dataset.data || []) as {x?: number, y?: number}[];
      const match = points.find((point) => point && point.x === x);
      if (match?.y != null) total += match.y;
    }
    return total;
  }
  return items.reduce((sum, item) => {
    if (!isAsleepStageLabel(item.dataset.label) || item.parsed.y == null) return sum;
    return sum + item.parsed.y;
  }, 0);
}

function defaultChartOptions(
  kind: 'line' | 'bar',
  unit: string,
  args: {stacked?: boolean, range: RangePreset, windowStart: Date | null, windowEnd: Date},
): ChartConfiguration['options'] {
  const stacked = !!args.stacked;
  const bounds = timeAxisBounds(args.range, args.windowStart, args.windowEnd);
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: stacked
      ? {mode: 'index', intersect: false}
      : {mode: 'nearest', axis: 'x', intersect: false},
    plugins: {
      legend: {display: kind === 'bar' ? stacked : true, position: 'bottom'},
      tooltip: {
        callbacks: {
          title: (items) => {
            const x = items[0]?.parsed?.x;
            if (x == null || Number.isNaN(x)) return '';
            return formatTooltipTime(x, kind);
          },
          label: (ctx) => {
            const value = ctx.parsed.y;
            if (value == null || Number.isNaN(value)) return ctx.dataset.label || '';
            const suffix = unit ? ` ${unit}` : '';
            if (unit === 'st') {
              return `${ctx.dataset.label}: ${formatStoneFromDecimal(value)}`;
            }
            const formatted = (unit === 'hours' || unit === 'kg' || unit === 'lbs')
              ? value.toFixed(1)
              : String(value);
            return `${ctx.dataset.label}: ${formatted}${suffix}`;
          },
          footer: (items) => {
            if (!stacked || unit !== 'hours' || !items.length) return '';
            const total = sleepAsleepTotal(items);
            if (total <= 0) return '';
            return `Total asleep: ${total.toFixed(1)} hours`;
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        ...(bounds.min != null ? {min: bounds.min} : {}),
        ...(bounds.max != null ? {max: bounds.max} : {}),
        grid: {display: false},
        ticks: {
          maxRotation: 0,
          autoSkip: false,
          callback: (value) => formatTickMs(Number(value), args.range),
        },
        afterBuildTicks: (axis) => {
          const ticks = buildTimeTicks(axis.min, axis.max, args.range);
          if (ticks.length) axis.ticks = ticks.map((value) => ({value}));
        },
      },
      y: {
        beginAtZero: kind === 'bar',
        stacked,
        title: {display: !!unit, text: unit},
        grid: {color: 'rgba(0,0,0,0.06)'},
      },
    },
    elements: {line: {borderWidth: 2}, point: {hitRadius: 8}},
  };
}

function convertStats(
  stats: HealthSeries['stats'],
  def: MetricDef,
  weightUnit: WeightUnit,
): {min?: number, max?: number, avg?: number} | null {
  if (!stats) return null;
  const convert = (v: number) => {
    if (def.id === 'body_mass') return kgToWeightUnit(v, weightUnit);
    if (def.id === 'oxygen_saturation') return asPercent(v);
    return v;
  };
  if (def.id !== 'body_mass' && def.id !== 'oxygen_saturation') return stats;
  return {
    min: stats.min != null ? convert(stats.min) : undefined,
    max: stats.max != null ? convert(stats.max) : undefined,
    avg: stats.avg != null ? convert(stats.avg) : undefined,
  };
}

function toTableRows(def: MetricDef, samples: HealthSample[], weightUnit: WeightUnit = 'kg'): TableRow[] {
  if (def.viz === 'dual-line') {
    const byCorr = new Map<string, {time: string, sys?: number, dia?: number, source: string}>();
    const unpaired: TableRow[] = [];
    for (const sample of samples) {
      const source = sample.device_name || sample.source_name || '';
      if (sample.correlation_uuid) {
        const row = byCorr.get(sample.correlation_uuid) || {time: sample.start_time, source};
        if (sample.metric_type === 'blood_pressure_systolic') row.sys = sample.value_num;
        if (sample.metric_type === 'blood_pressure_diastolic') row.dia = sample.value_num;
        if (Date.parse(sample.start_time) < Date.parse(row.time)) row.time = sample.start_time;
        byCorr.set(sample.correlation_uuid, row);
      } else {
        unpaired.push({
          time: sample.start_time,
          value: sample.value_num != null ? String(Math.round(sample.value_num)) : (sample.value_text || ''),
          unit: sample.unit || def.unit || '',
          source,
        });
      }
    }
    const paired = Array.from(byCorr.values()).map((row) => ({
      time: row.time,
      value: `${row.sys != null ? Math.round(row.sys) : '—'} / ${row.dia != null ? Math.round(row.dia) : '—'}`,
      unit: 'mmHg',
      source: row.source,
    }));
    return [...paired, ...unpaired].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  }
  return samples.map((sample) => {
    if (def.id === 'body_mass' && sample.value_num != null) {
      if (weightUnit === 'st') {
        return {
          time: sample.start_time,
          value: formatWeight(sample.value_num, 'st'),
          unit: '',
          source: sample.device_name || sample.source_name || '',
        };
      }
      return {
        time: sample.start_time,
        value: kgToWeightUnit(sample.value_num, weightUnit).toFixed(1),
        unit: weightUnitLabel(weightUnit),
        source: sample.device_name || sample.source_name || '',
      };
    }
    const displayValue = def.id === 'oxygen_saturation' && sample.value_num != null
      ? asPercent(sample.value_num)
      : sample.value_num;
    return {
      time: sample.start_time,
      value: displayValue != null
        ? (Number.isInteger(displayValue) ? String(displayValue) : displayValue.toFixed(1))
        : (SLEEP_STAGE_LABELS[sample.value_text] || sample.value_text || ''),
      unit: displayUnit(def, sample.unit, weightUnit),
      source: sample.device_name || sample.source_name || '',
    };
  });
}
