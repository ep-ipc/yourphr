/**
 * The typed query (yourphr#595): POST /api/secure/query is how the labs page and the explore
 * filters ask questions Go's FHIR search cannot — "every Observation with a LOINC code, grouped by
 * code, newest first", "the last ten lab DiagnosticReports". Go translates the request into SQL
 * over its per-type tables; here it runs over the generic search index the repository already
 * keeps (one row per search-parameter value), which is the same thing without per-type SQL.
 *
 * Scope is what the frontend actually sends (the labs page and the record wizards):
 *   where   — search parameter -> value(s); comma-separated alternatives OR together, parameters
 *             AND together. Tokens match as `code`, `system|code`, or `system|` (any code in the
 *             system); dates and numbers accept FHIR prefixes (eq gt ge lt le ne).
 *   select  — ignored beyond "give me the records": every row is the resource_fhir shape.
 *   limit / offset — as given; default limit 100 when unset.
 *   aggregations.group_by {field} — label = each indexed `system|code` of that parameter (one row
 *             per coding, as Go's json_each produces); value = count, or order_by's max/min of
 *             `sort_date` per label. count_by is the Go alias (group_by + count, '*' = by type).
 *
 * The caller's user id is on every query by construction — it is the repository's, not the
 * request's (yourphr#537).
 */
import type { Resource } from '@medplum/fhirtypes';
import type { SqliteFhirRepository } from '../SqliteFhirRepository.js';
import { dateFor, toResourceFhir } from '../server.js';

export interface QueryAggregation {
  field: string;
  fn?: string;
}

export interface QueryRequest {
  use?: string;
  select?: string[];
  from: string;
  where?: Record<string, string | string[]>;
  limit?: number;
  offset?: number;
  aggregations?: {
    count_by?: QueryAggregation;
    group_by?: QueryAggregation;
    order_by?: QueryAggregation;
  };
}

export interface AggregationRow {
  label: string;
  value: string | number;
}

const PARAM_NAME = /^[a-z][a-z0-9-]*$/i;
const DATE_PREFIX = /^(eq|ne|gt|ge|lt|le|sa|eb|ap)(\d.*)$/;

/** One alternative of one where clause becomes one condition on the index value. */
function valueClause(alternative: string): { sql: string; values: string[] } {
  const v = alternative.trim();
  const prefixed = v.match(DATE_PREFIX);
  if (prefixed) {
    const [, prefix, rest] = prefixed;
    const op = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=', sa: '>', eb: '<', ap: '=' }[prefix!]!;
    return { sql: `si.value ${op} ?`, values: [rest!] };
  }
  if (v.endsWith('|')) {
    // system only: any code in that system — the index holds "system|code"
    return { sql: "si.value LIKE ? ESCAPE '\\'", values: [`${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`] };
  }
  return { sql: 'si.value = ?', values: [v] };
}

function whereSql(where: Record<string, string | string[]> | undefined): { sql: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  for (const [param, raw] of Object.entries(where ?? {})) {
    if (!PARAM_NAME.test(param)) throw new Error(`invalid search parameter: ${param}`);
    const alternatives = (Array.isArray(raw) ? raw : [raw]).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
    if (alternatives.length === 0) continue;
    const parts = alternatives.map(valueClause);
    clauses.push(
      `EXISTS (SELECT 1 FROM search_index si WHERE si.resource_type = r.resource_type AND si.resource_id = r.id AND si.user_id = r.user_id AND si.code = ? AND (${parts.map((p) => p.sql).join(' OR ')}))`
    );
    values.push(param, ...parts.flatMap((p) => p.values));
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', values };
}

interface Row { id: string; source_id: string; content: string }

function matchingRows(repo: SqliteFhirRepository, query: QueryRequest): Row[] {
  if (!/^[A-Z][A-Za-z]+$/.test(query.from ?? '')) throw new Error('from must name a resource type');
  const where = whereSql(query.where);
  return repo.db
    .prepare(`SELECT r.id, r.source_id, r.content FROM resources r WHERE r.resource_type = ? AND r.user_id = ? AND r.deleted = 0${where.sql}`)
    .all(query.from, repo.userId ?? '', ...where.values) as Row[];
}

const sortDateOf = (resource: Resource): string => String(dateFor(resource) ?? '');

export function runQuery(repo: SqliteFhirRepository, query: QueryRequest): Record<string, unknown>[] | AggregationRow[] {
  const agg = query.aggregations;
  let groupBy = agg?.group_by;
  let orderBy = agg?.order_by;
  if (agg?.count_by) {
    groupBy = agg.count_by.field === '*' ? { field: 'source_resource_type' } : agg.count_by;
    orderBy = { field: '*', fn: 'count' };
  }

  const rows = matchingRows(repo, query);
  const parsed = rows.map((r) => ({ row: r, resource: JSON.parse(r.content) as Resource }));

  if (!groupBy) {
    parsed.sort((a, b) => sortDateOf(b.resource).localeCompare(sortDateOf(a.resource))); // Go: sort_date DESC
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    return parsed.slice(offset, offset + limit).map(({ row, resource }) => toResourceFhir(resource, row.source_id));
  }

  // Grouped: label per indexed "system|code" of the group field (or the resource type), value per label.
  if (!PARAM_NAME.test(groupBy.field) && groupBy.field !== 'source_resource_type') throw new Error(`invalid aggregation field: ${groupBy.field}`);
  const labelsOf = (r: Row): string[] => {
    if (groupBy!.field === 'source_resource_type') return [query.from];
    return (repo.db
      .prepare("SELECT value FROM search_index WHERE resource_type = ? AND resource_id = ? AND user_id = ? AND code = ? AND value LIKE '%|%'")
      .all(query.from, r.id, repo.userId ?? '', groupBy!.field) as { value: string }[]).map((v) => v.value);
  };
  const byDate = orderBy && orderBy.field !== '*';
  if (byDate && orderBy!.field !== 'sort_date') throw new Error(`unsupported order_by field: ${orderBy!.field} (sort_date only)`);
  const groups = new Map<string, { count: number; max: string; min: string }>();
  for (const { row, resource } of parsed) {
    const date = sortDateOf(resource);
    for (const label of labelsOf(row)) {
      const g = groups.get(label) ?? { count: 0, max: '', min: '' };
      g.count++;
      if (date !== '' && (g.max === '' || date > g.max)) g.max = date;
      if (date !== '' && (g.min === '' || date < g.min)) g.min = date;
      groups.set(label, g);
    }
  }
  const out: AggregationRow[] = [...groups.entries()].map(([label, g]) => ({
    label,
    value: byDate ? ((orderBy!.fn ?? 'max') === 'min' ? g.min : g.max) : g.count,
  }));
  // Go orders a date aggregation DESC and a count DESC.
  out.sort((a, b) => (typeof a.value === 'number' && typeof b.value === 'number' ? b.value - a.value : String(b.value).localeCompare(String(a.value))));
  return out;
}

export interface RecentItem {
  source_id: string;
  source_resource_type: string;
  source_resource_id: string;
  title: string;
  date?: string;
}

/** The dashboard's "recent activity": the newest records across every type, Go's list-item shape. */
export function recentResources(repo: SqliteFhirRepository, limit: number): RecentItem[] {
  const rows = repo.db
    .prepare('SELECT resource_type, id, source_id, content FROM resources WHERE user_id = ? AND deleted = 0')
    .all(repo.userId ?? '') as { resource_type: string; id: string; source_id: string; content: string }[];
  const items = rows.map((r) => {
    const resource = JSON.parse(r.content) as Resource;
    const shaped = toResourceFhir(resource, r.source_id);
    const date = String(shaped['sort_date'] ?? '').slice(0, 10);
    return {
      source_id: r.source_id,
      source_resource_type: r.resource_type,
      source_resource_id: r.id,
      title: String(shaped['sort_title'] ?? ''),
      ...(date ? { date } : {}),
    };
  });
  items.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')); // nil dates last, newest first
  return items.slice(0, limit);
}
