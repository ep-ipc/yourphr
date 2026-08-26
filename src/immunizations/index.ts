/**
 * Immunizations, classified (yourphr#595) — ported decision-for-decision from the Go
 * `immunization` package. Per record: a legible state (given / not given / unknown), who the
 * information came from (primarySource, never assumed), the dose details the record states. Then
 * the same vaccine repeated across records collapses on a standard code (CVX, NDC, SNOMED; else
 * the title): the most recent administration drives the displayed date and status, `doses` counts
 * the members (#289). Provenance is absent (not ported), never invented.
 */
import { conceptText, noteText, standardCodingsBy, type Coding, type InputResource } from '../conditions/index.js';

export type ImmunizationState = 'Completed' | 'NotDone' | 'Unknown';

export interface ClassifiedImmunization {
  sourceResourceType: string;
  sourceResourceId: string;
  sourceId: string;
  title: string;
  state: ImmunizationState;
  source: string;
  reportOrigin?: string;
  status?: string;
  statusReason?: string;
  occurrence?: string;
  recorded?: string;
  doses?: number;
  lastActivity?: string;
  manufacturer?: string;
  lotNumber?: string;
  expirationDate?: string;
  note?: string;
  standardCodings?: Coding[];
}

type Raw = Record<string, any>;

const isStandardSystem = (system: string): boolean => {
  const s = system.toLowerCase();
  return s.includes('cvx') || s.includes('ndc') || s.includes('snomed');
};

const firstNonEmpty = (...vals: string[]): string => vals.find((v) => v.trim() !== '') ?? '';

function stateLabel(status: string): ImmunizationState {
  switch (status.toLowerCase()) {
    case 'completed': return 'Completed';
    case 'not-done': return 'NotDone';
    default: return 'Unknown';
  }
}

function sourceAttribution(primarySource: unknown): string {
  if (typeof primarySource !== 'boolean') return 'Unknown';
  return primarySource ? 'Recorded by provider' : 'Reported';
}

function classifyOne(res: InputResource): ClassifiedImmunization | undefined {
  const raw = res.raw as Raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const status = String(raw.status ?? '');
  if (status.toLowerCase() === 'entered-in-error') return undefined;
  const occurrence = String(raw.occurrenceDateTime || raw.occurrenceString || '');
  const recorded = String(raw.recorded ?? '');
  const ci: ClassifiedImmunization = {
    sourceResourceType: res.sourceResourceType,
    sourceResourceId: res.sourceResourceId,
    sourceId: res.sourceId,
    title: conceptText(raw.vaccineCode) || 'Unknown vaccine',
    state: stateLabel(status),
    source: sourceAttribution(raw.primarySource),
    doses: 1,
  };
  const set = (k: keyof ClassifiedImmunization, v: string): void => { if (v !== '') (ci as Raw)[k] = v; };
  set('reportOrigin', raw.primarySource === false ? conceptText(raw.reportOrigin) : '');
  set('status', status);
  set('statusReason', conceptText(raw.statusReason));
  set('occurrence', occurrence);
  set('recorded', recorded);
  set('lastActivity', firstNonEmpty(occurrence, recorded));
  set('manufacturer', String(raw.manufacturer?.display ?? ''));
  set('lotNumber', String(raw.lotNumber ?? ''));
  set('expirationDate', String(raw.expirationDate ?? ''));
  set('note', noteText(raw.note));
  const codings = standardCodingsBy(raw.vaccineCode, isStandardSystem);
  if (codings) ci.standardCodings = codings;
  return ci;
}

function dedupKey(c: ClassifiedImmunization): string {
  for (const cd of c.standardCodings ?? []) {
    if (cd.code) return `code:${(cd.system ?? '').toLowerCase()}|${cd.code.toLowerCase()}`;
  }
  return `title:${c.title.trim().toLowerCase()}`;
}

export function classifyImmunizations(resources: InputResource[]): ClassifiedImmunization[] {
  const order: string[] = [];
  const groups = new Map<string, ClassifiedImmunization[]>();
  for (const res of resources) {
    const c = classifyOne(res);
    if (!c) continue;
    const k = dedupKey(c);
    if (!groups.has(k)) { order.push(k); groups.set(k, []); }
    groups.get(k)!.push(c);
  }
  return order.map((k) => {
    const g = groups.get(k)!;
    let rep = g[0]!;
    for (const c of g.slice(1)) if ((c.lastActivity ?? '') > (rep.lastActivity ?? '')) rep = c;
    return { ...rep, doses: g.length };
  });
}
