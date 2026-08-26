/**
 * Allergies and intolerances, classified (yourphr#595) — ported decision-for-decision from the Go
 * `allergyintolerance` package. Per record: legible state and verification, who asserted it, the
 * "no known allergy" negation flagged so it is never counted as an allergy (#290), reactions made
 * readable. Then duplicates across sources merge on a standard code (else the title): the most
 * recently recorded member drives the status, dates widen to the earliest start and latest end,
 * categories and reactions union. Provenance is absent (not ported), never invented.
 */
import { conceptCode, conceptText, noteText, refIsType, standardCodingsBy, type Coding, type InputResource } from '../conditions/index.js';

export type AllergyState = 'Active' | 'Inactive' | 'Resolved' | 'Unknown' | 'RuledOut';

export interface Reaction {
  manifestations?: string[];
  description?: string;
  severity?: string;
}

export interface ClassifiedAllergy {
  sourceResourceType: string;
  sourceResourceId: string;
  sourceId: string;
  title: string;
  state: AllergyState;
  verification: string;
  selfReported: boolean;
  noKnown?: boolean;
  clinicalStatus?: string;
  verificationStatus?: string;
  type?: string;
  categories?: string[];
  criticality?: string;
  reactions?: Reaction[];
  onset?: string;
  recorded?: string;
  start?: string;
  end?: string;
  lastActivity?: string;
  occurrences?: number;
  note?: string;
  standardCodings?: Coding[];
}

type Raw = Record<string, any>;

const isStandardSystem = (system: string): boolean => {
  const s = system.toLowerCase();
  return s.includes('snomed') || s.includes('rxnorm') || s.includes('unii') || s.includes('icd') || s.includes('ndfrt');
};

const NO_KNOWN_ALLERGY_CODES = new Set(['716186003', '409137002', '429625007', '428607008', '716184000']);

function noKnown(raw: Raw): boolean {
  if (!raw.code) return false;
  for (const c of raw.code.coding ?? []) {
    if (NO_KNOWN_ALLERGY_CODES.has(String(c?.code ?? '').trim())) return true;
  }
  return conceptText(raw.code).toLowerCase().includes('no known');
}

const onsetOf = (raw: Raw): string => raw.onsetDateTime || raw.onsetPeriod?.start || raw.onsetString || '';

function reactionsOf(raw: Raw): Reaction[] {
  const out: Reaction[] = [];
  for (const rx of raw.reaction ?? []) {
    const manifestations = (rx?.manifestation ?? []).map((m: Raw) => conceptText(m)).filter((s: string) => s !== '');
    const description = String(rx?.description ?? '');
    const severity = String(rx?.severity ?? '').toLowerCase();
    if (manifestations.length === 0 && description === '' && severity === '') continue;
    out.push({
      ...(manifestations.length ? { manifestations } : {}),
      ...(description ? { description } : {}),
      ...(severity ? { severity } : {}),
    });
  }
  return out;
}

function resolveState(clinical: string, verif: string): AllergyState {
  if (verif === 'refuted') return 'RuledOut';
  switch (clinical) {
    case 'active': return 'Active';
    case 'inactive': return 'Inactive';
    case 'resolved': return 'Resolved';
    default: return 'Unknown';
  }
}

function verificationLabel(verif: string): string {
  switch (verif) {
    case 'confirmed': return 'Confirmed';
    case 'presumed': return 'Presumed';
    case 'unconfirmed': return 'Unconfirmed';
    case 'refuted': return 'Refuted';
    case '': return 'Unknown';
    default: return verif.charAt(0).toUpperCase() + verif.slice(1);
  }
}

function patientAsserted(raw: Raw): boolean {
  if (refIsType(raw.asserter, 'Patient') || refIsType(raw.asserter, 'RelatedPerson')) return true;
  if (!raw.asserter) return refIsType(raw.recorder, 'Patient') || refIsType(raw.recorder, 'RelatedPerson');
  return false;
}

const firstNonEmpty = (...vals: string[]): string => vals.find((v) => v.trim() !== '') ?? '';
const earlierDate = (a: string, b: string): string => (a === '' ? b : b === '' ? a : a < b ? a : b);
const laterDate = (a: string, b: string): string => (a === '' ? b : b === '' ? a : a > b ? a : b);

function unionStrings(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let v of [...a, ...b]) {
    v = v.trim();
    if (v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function mergeReactions(a: Reaction[], b: Reaction[]): Reaction[] {
  const seen = new Set<string>();
  const out: Reaction[] = [];
  for (const r of [...a, ...b]) {
    const key = `${(r.manifestations ?? []).join('|')}::${r.description ?? ''}::${r.severity ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function classifyOne(res: InputResource): ClassifiedAllergy | undefined {
  const raw = res.raw as Raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const verif = conceptCode(raw.verificationStatus);
  if (verif === 'entered-in-error') return undefined;
  const clinical = conceptCode(raw.clinicalStatus);
  const onset = onsetOf(raw);
  const recorded = String(raw.recordedDate ?? '');
  const start = firstNonEmpty(onset, recorded);
  const end = firstNonEmpty(String(raw.lastOccurrence ?? ''), recorded);
  const ca: ClassifiedAllergy = {
    sourceResourceType: res.sourceResourceType,
    sourceResourceId: res.sourceResourceId,
    sourceId: res.sourceId,
    title: conceptText(raw.code) || 'Unknown allergy',
    state: resolveState(clinical, verif),
    verification: verificationLabel(verif),
    selfReported: patientAsserted(raw),
    occurrences: 1,
  };
  if (noKnown(raw)) ca.noKnown = true;
  const set = (k: keyof ClassifiedAllergy, v: string): void => { if (v !== '') (ca as Raw)[k] = v; };
  set('clinicalStatus', clinical);
  set('verificationStatus', verif);
  set('type', String(raw.type ?? ''));
  if (Array.isArray(raw.category) && raw.category.length) ca.categories = raw.category.map(String);
  set('criticality', String(raw.criticality ?? ''));
  const reactions = reactionsOf(raw);
  if (reactions.length) ca.reactions = reactions;
  set('onset', onset);
  set('recorded', recorded);
  set('start', start);
  set('end', end);
  set('lastActivity', end);
  set('note', noteText(raw.note));
  const codings = standardCodingsBy(raw.code, isStandardSystem);
  if (codings) ca.standardCodings = codings;
  return ca;
}

function dedupKey(c: ClassifiedAllergy): string {
  for (const cd of c.standardCodings ?? []) {
    if (cd.code) return `code:${(cd.system ?? '').toLowerCase()}|${cd.code.toLowerCase()}`;
  }
  return `title:${c.title.trim().toLowerCase()}`;
}

const recency = (c: ClassifiedAllergy): string => firstNonEmpty(c.recorded ?? '', c.end ?? '', c.start ?? '');

function mergeGroup(g: ClassifiedAllergy[]): ClassifiedAllergy {
  let rep = g[0]!;
  for (const c of g.slice(1)) if (recency(c) > recency(rep)) rep = c;
  const merged: ClassifiedAllergy = { ...rep, occurrences: g.length };
  let start = merged.start ?? '';
  let end = merged.end ?? '';
  let categories = merged.categories ?? [];
  let reactions = merged.reactions ?? [];
  let known = merged.noKnown ?? false;
  for (const c of g) {
    start = earlierDate(start, c.start ?? '');
    end = laterDate(end, c.end ?? '');
    known = known || (c.noKnown ?? false);
    categories = unionStrings(categories, c.categories ?? []);
    reactions = mergeReactions(reactions, c.reactions ?? []);
  }
  if (start) merged.start = start; else delete merged.start;
  if (end) { merged.end = end; merged.lastActivity = end; } else { delete merged.end; delete merged.lastActivity; }
  if (known) merged.noKnown = true; else delete merged.noKnown;
  if (categories.length) merged.categories = categories; else delete merged.categories;
  if (reactions.length) merged.reactions = reactions; else delete merged.reactions;
  return merged;
}

export function classifyAllergies(resources: InputResource[]): ClassifiedAllergy[] {
  const order: string[] = [];
  const groups = new Map<string, ClassifiedAllergy[]>();
  for (const res of resources) {
    const c = classifyOne(res);
    if (!c) continue;
    const k = dedupKey(c);
    if (!groups.has(k)) { order.push(k); groups.set(k, []); }
    groups.get(k)!.push(c);
  }
  return order.map((k) => mergeGroup(groups.get(k)!));
}
