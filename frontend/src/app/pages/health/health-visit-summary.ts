import {Chart, ChartConfiguration, ChartData} from 'chart.js';
import {HealthSeries, HealthSeriesPoint} from '../../models/fasten/health-sample';
import {
  asPercent,
  CatalogEntry,
  displayUnit,
  formatStoneFromDecimal,
  kgToWeightUnit,
  MetricDef,
  seriesMode,
  SLEEP_STAGE_LABELS,
  SLEEP_STAGE_ORDER,
  WeightUnit,
} from './health-metrics';
import type {RangePreset} from './health.component';

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

const PRINT_WIDTH = 800;
const PRINT_HEIGHT = 240;

const RANGE_MS: Record<Exclude<RangePreset, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '5d': 5 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

export const SUMMARY_RANGE_DEFAULT: RangePreset = '30d';

export interface VisitSummaryPatient {
  name?: string
  birthDate?: string
}

export interface VisitSummaryTableRow {
  label: string
  value: string
}

export interface VisitSummarySection {
  id: string
  label: string
  latestLabel: string
  unit: string
  stats: {min?: number, max?: number, avg?: number} | null
  sampleCount: number
  downsampled: boolean
  chartPng?: string
  tableRows?: VisitSummaryTableRow[]
  empty?: boolean
  error?: boolean
}

export interface VisitSummaryModel {
  generatedAt: Date
  windowLabel: string
  lastSyncedAt?: string | null
  patient?: VisitSummaryPatient
  sections: VisitSummarySection[]
}

export interface VisitSummaryWindow {
  start: Date | null
  end: Date
  label: string
  startAfter?: string
  startBefore?: string
}

export interface PrintChartConfig {
  type: 'line' | 'bar'
  data: ChartData
  options: ChartConfiguration['options']
  hasData: boolean
}

export function visitSummaryFilename(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `yourphr-health-${y}${m}${day}.html`;
}

export function defaultSummarySelection(entries: CatalogEntry[]): Record<string, boolean> {
  const selected: Record<string, boolean> = {};
  for (const entry of entries) {
    selected[entry.id] = true;
  }
  return selected;
}

export function hasSummarySelection(selected: Record<string, boolean>): boolean {
  return Object.values(selected).some(Boolean);
}

export function visitSummaryWindow(range: RangePreset, now: Date): VisitSummaryWindow {
  if (range === 'all') {
    return {start: null, end: now, label: 'All time'};
  }
  const start = new Date(now.getTime() - RANGE_MS[range]);
  return {
    start,
    end: now,
    label: `${formatWindowDay(start)} – ${formatWindowDay(new Date(now.getTime() - 1))}`,
    startAfter: start.toISOString(),
    startBefore: now.toISOString(),
  };
}

export function convertDisplayValue(value: number, def: MetricDef, weightUnit: WeightUnit): number {
  if (def.id === 'body_mass') return kgToWeightUnit(value, weightUnit);
  if (def.id === 'oxygen_saturation') return asPercent(value);
  return value;
}

export function convertSeriesStats(
  stats: HealthSeries['stats'],
  def: MetricDef,
  weightUnit: WeightUnit,
): {min?: number, max?: number, avg?: number} | null {
  if (!stats) return null;
  if (def.id !== 'body_mass' && def.id !== 'oxygen_saturation') return stats;
  return {
    min: stats.min != null ? convertDisplayValue(stats.min, def, weightUnit) : undefined,
    max: stats.max != null ? convertDisplayValue(stats.max, def, weightUnit) : undefined,
    avg: stats.avg != null ? convertDisplayValue(stats.avg, def, weightUnit) : undefined,
  };
}

export function formatSummaryStat(
  value: number | undefined | null,
  def: MetricDef,
  weightUnit: WeightUnit,
): string {
  if (value == null || Number.isNaN(value)) return '';
  if (def.id === 'body_mass' && weightUnit === 'st') {
    return formatStoneFromDecimal(value);
  }
  return value.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 1});
}

export function errorSection(entry: CatalogEntry): VisitSummarySection {
  return {
    id: entry.id,
    label: entry.def.label,
    latestLabel: '',
    unit: '',
    stats: null,
    sampleCount: 0,
    downsampled: false,
    error: true,
  };
}

export function tableSectionFromEntry(entry: CatalogEntry): VisitSummarySection {
  const count = entry.summaries.reduce((sum, s) => sum + (s.sample_count || 0), 0);
  return {
    id: entry.id,
    label: entry.def.label,
    latestLabel: entry.latestLabel,
    unit: displayUnit(entry.def, entry.summaries[0]?.unit),
    stats: null,
    sampleCount: count,
    downsampled: false,
    tableRows: [
      {label: 'Latest', value: entry.latestLabel || '—'},
      {label: 'Samples', value: count.toLocaleString()},
    ],
  };
}

export function emptySeries(): HealthSeries {
  return {total: 0, downsampled: false, points: []};
}

export function buildPrintChartConfig(
  def: MetricDef,
  series: HealthSeries,
  weightUnit: WeightUnit,
  range: RangePreset,
  windowStart: Date | null,
  windowEnd: Date,
  dual?: {sys: HealthSeries, dia: HealthSeries},
): PrintChartConfig {
  const convert = (v: number) => convertDisplayValue(v, def, weightUnit);
  const bounds = (range === 'all' || !windowStart)
    ? {}
    : {min: windowStart.getTime(), max: windowEnd.getTime()};

  if (def.viz === 'dual-line' && dual) {
    const sysPoints = toTimePointsLocal(dual.sys.points || []);
    const diaPoints = toTimePointsLocal(dual.dia.points || []);
    return {
      type: 'line',
      hasData: sysPoints.length > 0 || diaPoints.length > 0,
      data: {
        datasets: [
          {label: 'Systolic', data: sysPoints, borderColor: INDIGO, backgroundColor: INDIGO, pointRadius: 2, tension: 0.1},
          {label: 'Diastolic', data: diaPoints, borderColor: TEAL, backgroundColor: TEAL, pointRadius: 2, tension: 0.1},
        ],
      },
      options: printChartOptions('line', 'mmHg', range, bounds, false),
    };
  }

  if (def.viz === 'bar-daily') {
    const data = toDayPointsLocal(series.daily || [], convert);
    return {
      type: 'bar',
      hasData: data.length > 0,
      data: {
        datasets: [{
          label: def.label,
          data,
          backgroundColor: INDIGO,
          maxBarThickness: 40,
        }],
      },
      options: printChartOptions('bar', displayUnit(def, series.unit, weightUnit) || def.unit || '', range, bounds, false),
    };
  }

  if (def.viz === 'sleep-stages') {
    const nights = series.nights || [];
    const datasets = SLEEP_STAGE_ORDER
      .filter((stage) => nights.some((n) => (n.stages?.[stage] || 0) > 0))
      .map((stage) => ({
        label: SLEEP_STAGE_LABELS[stage] || stage,
        data: toDayPointsLocal(nights.map((n) => ({date: n.date, value: n.stages?.[stage] || 0}))),
        backgroundColor: SLEEP_COLORS[stage],
        stack: 'sleep',
        maxBarThickness: 40,
      }));
    return {
      type: 'bar',
      hasData: nights.length > 0,
      data: {datasets},
      options: printChartOptions('bar', 'hours', range, bounds, true),
    };
  }

  const points = toTimePointsLocal(series.points || [], convert);
  const unit = displayUnit(def, series.unit, weightUnit);
  return {
    type: 'line',
    hasData: points.length > 0,
    data: {
      datasets: [{
        label: def.label,
        data: points,
        borderColor: INDIGO,
        backgroundColor: INDIGO_FILL,
        pointRadius: points.length > 80 ? 0 : 2,
        fill: true,
        tension: 0.2,
      }],
    },
    options: printChartOptions('line', unit, range, bounds, false),
  };
}

export function renderChartPng(config: PrintChartConfig): string | undefined {
  if (!config.hasData || typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = PRINT_WIDTH;
  canvas.height = PRINT_HEIGHT;
  let chart: Chart | undefined;
  try {
    chart = new Chart(canvas, {
      type: config.type,
      data: config.data,
      plugins: [whiteBackgroundPlugin],
      options: {
        ...config.options,
        responsive: false,
        animation: false,
        devicePixelRatio: 2,
      },
    });
    return chart.toBase64Image('image/png');
  } catch {
    return undefined;
  } finally {
    chart?.destroy();
  }
}

export function seriesQueryFor(entry: CatalogEntry): {metricTypes?: string[], hkType?: string, mode: 'points' | 'day' | 'stages'} {
  return {
    metricTypes: entry.def.metricTypes.length ? entry.def.metricTypes : undefined,
    hkType: entry.def.hkType,
    mode: seriesMode(entry.def.viz),
  };
}

export function buildVisitSummaryHtml(model: VisitSummaryModel): string {
  const generated = model.generatedAt.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const synced = model.lastSyncedAt
    ? new Date(model.lastSyncedAt).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})
    : '';

  const patientLines: string[] = [];
  if (model.patient?.name) {
    patientLines.push(`<div class="patient-name">${escapeHtml(model.patient.name)}</div>`);
  }
  if (model.patient?.birthDate) {
    patientLines.push(`<div>Born ${escapeHtml(model.patient.birthDate)}</div>`);
  }

  const sections = model.sections.map((section) => renderSectionHtml(section)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Health visit summary</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #222; margin: 24px; max-width: 880px; }
  h1 { font-size: 1.6rem; margin: 0 0 8px; }
  h2 { font-size: 1.15rem; margin: 0 0 8px; }
  .meta, .patient { color: #555; font-size: 0.95rem; line-height: 1.5; }
  .patient-name { font-size: 1.1rem; color: #111; font-weight: 600; }
  .section { margin: 28px 0; page-break-inside: avoid; }
  .latest { font-size: 1.05rem; margin: 0 0 6px; }
  .stats { color: #555; font-size: 0.9rem; margin: 8px 0; }
  .stats span { margin-right: 16px; }
  .note { color: #555; font-style: italic; }
  img.chart { width: 100%; height: auto; display: block; }
  table { border-collapse: collapse; width: auto; }
  th, td { text-align: left; padding: 4px 16px 4px 0; }
  footer { margin-top: 36px; color: #777; font-size: 0.8rem; }
  @media print {
    body { margin: 12mm; }
    .section { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <header>
    <h1>Health visit summary</h1>
    ${patientLines.join('\n    ')}
    <div class="meta">
      <div>Apple Health · generated ${escapeHtml(generated)}</div>
      <div>Window: ${escapeHtml(model.windowLabel)}</div>
      ${synced ? `<div>iPhone last synced ${escapeHtml(synced)}</div>` : ''}
    </div>
  </header>
  ${sections}
  <footer>This file is not password protected. Store it somewhere you would keep a paper copy of your records.</footer>
</body>
</html>
`;
}

export function triggerHtmlDownload(html: string, filename: string): void {
  const blob = new Blob([html], {type: 'text/html;charset=utf-8'});
  const fileURL = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = fileURL;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(fileURL);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSectionHtml(section: VisitSummarySection): string {
  const title = escapeHtml(section.label);
  if (section.error) {
    return `<section class="section"><h2>${title}</h2><p class="note">This metric could not be loaded.</p></section>`;
  }
  if (section.empty) {
    return `<section class="section"><h2>${title}</h2><p class="note">No samples in this time range.</p></section>`;
  }

  const latest = section.latestLabel
    ? `<p class="latest">${escapeHtml(section.latestLabel)}</p>`
    : '';
  const statsBits: string[] = [];
  if (section.stats?.min != null) statsBits.push(`Min ${escapeHtml(formatPlain(section.stats.min))}`);
  if (section.stats?.max != null) statsBits.push(`Max ${escapeHtml(formatPlain(section.stats.max))}`);
  if (section.stats?.avg != null) statsBits.push(`Avg ${escapeHtml(formatPlain(section.stats.avg))}`);
  if (section.sampleCount) statsBits.push(`Samples ${section.sampleCount.toLocaleString()}`);
  if (section.downsampled) statsBits.push('averaged to fit the chart');
  const stats = statsBits.length
    ? `<p class="stats">${statsBits.map((b) => `<span>${b}</span>`).join('')}</p>`
    : '';

  if (section.tableRows?.length) {
    const rows = section.tableRows.map((row) =>
      `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`).join('');
    return `<section class="section"><h2>${title}</h2>${latest}<table>${rows}</table></section>`;
  }

  const img = section.chartPng
    ? `<img class="chart" alt="${title} chart" src="${escapeHtml(section.chartPng)}">`
    : '';
  return `<section class="section"><h2>${title}</h2>${latest}${img}${stats}</section>`;
}

function formatPlain(value: number): string {
  return value.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 1});
}

function formatWindowDay(d: Date): string {
  return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
}

function printChartOptions(
  kind: 'line' | 'bar',
  unit: string,
  range: RangePreset,
  bounds: {min?: number, max?: number},
  stacked: boolean,
): ChartConfiguration['options'] {
  return {
    responsive: false,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {display: kind === 'bar' ? stacked : true, position: 'bottom', labels: {font: {size: 12}}},
    },
    scales: {
      x: {
        type: 'linear',
        ...(bounds.min != null ? {min: bounds.min} : {}),
        ...(bounds.max != null ? {max: bounds.max} : {}),
        grid: {display: false},
        ticks: {
          maxRotation: 0,
          font: {size: 11},
          callback: (value) => formatPrintTick(Number(value), range),
        },
      },
      y: {
        beginAtZero: kind === 'bar',
        stacked,
        title: {display: !!unit, text: unit, font: {size: 12}},
        ticks: {font: {size: 11}},
        grid: {color: 'rgba(0,0,0,0.08)'},
      },
    },
    elements: {line: {borderWidth: 2}, point: {radius: 2}},
  };
}

function formatPrintTick(ms: number, range: RangePreset): string {
  const d = new Date(ms);
  if (range === '24h') {
    return d.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
  }
  return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

function toTimePointsLocal(points: HealthSeriesPoint[], convert: (v: number) => number = (v) => v): {x: number, y: number}[] {
  return points
    .map((p) => ({x: Date.parse(p.t), y: convert(p.v)}))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function toDayPointsLocal(days: {date: string, value: number}[], convert: (v: number) => number = (v) => v): {x: number, y: number}[] {
  return days
    .map((d) => ({x: utcDayMsLocal(d.date), y: convert(d.value)}))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function utcDayMsLocal(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return Date.parse(date);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0).getTime();
}

const whiteBackgroundPlugin = {
  id: 'visitSummaryWhiteBackground',
  beforeDraw(chart: Chart): void {
    const {ctx, width, height} = chart;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};
