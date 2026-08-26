/**
 * Medication reconciliation (yourphr#580; Phase 4 of yourphr#542) — MedicationRequest /
 * MedicationStatement / MedicationDispense collapsed into one patient-legible current-medications
 * list, cross-source. A pure derivation over raw FHIR, ported rule-for-rule from the Go package:
 *
 *   - States come ONLY from explicit signals: status, or an explicit past end date. Absent means
 *     Unknown — shown, never assumed Active. For a medication list, a wrong "Active" is a
 *     clinical hazard, not a display bug.
 *   - Dedup is at the clinical-drug level: RxNorm code when present, else the EXACT normalized
 *     display text — never fuzzy, because under-merge is safe and wrong-merge is dangerous. A
 *     nameless resource keys to itself and is never merged blindly.
 *   - Field precedence: prescribed (Request) > self-reported (Statement) > dispense record.
 *   - CONFLICTS ARE SURFACED, NEVER SILENTLY RESOLVED: when sources disagree on state, the row is
 *     flagged, the badge follows the most recently DATED stated contributor (else the deterministic
 *     Active > Suspended > Past priority), and every contributor stays visible as evidence.
 */
import type { Resource } from '@medplum/fhirtypes';

export const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

export type MedState = 'Active' | 'Suspended' | 'Past' | 'Unknown';

export interface MedInput {
  resource: Resource;
  sourceId: string;
}

export interface Contributor {
  resourceType: string;
  id: string;
  sourceId: string;
  status: string;
  state: MedState | '';
  date: string;
  dose: string;
}

export interface ReconciledMedication {
  name: string;
  rxNormCode: string;
  state: MedState;
  /** True when stated contributor states disagree — surfaced, never resolved away. */
  stateConflict: boolean;
  dose: string;
  /** Distinct sources that said anything about this drug. */
  sourceIds: string[];
  contributors: Contributor[];
}

type Raw = Record<string, any>;

function conceptText(cc: Raw | undefined): string {
  if (!cc) return '';
  if (typeof cc['text'] === 'string' && cc['text'] !== '') return cc['text'];
  for (const coding of cc['coding'] ?? []) {
    if (coding?.display) return coding.display;
  }
  return '';
}

function rxCode(cc: Raw | undefined): string {
  for (const coding of cc?.['coding'] ?? []) {
    if (coding?.system === RXNORM && coding?.code) return coding.code;
  }
  return '';
}

/** Explicit-status classification. Dispense/Medication carry no state signal ('' — not Unknown). */
function stateOf(resource: Raw): MedState | '' {
  const type = resource['resourceType'];
  if (type !== 'MedicationRequest' && type !== 'MedicationStatement') {
    return '';
  }
  switch ((resource['status'] ?? '').toLowerCase()) {
    case 'active': return 'Active';
    case 'on-hold': return 'Suspended';
    case 'completed': case 'stopped': case 'cancelled': case 'not-taken': return 'Past';
    default: {
      // An explicit PAST end date is an explicit signal (the one non-status source of Past).
      const end: string | undefined = resource['effectivePeriod']?.end ?? resource['dosageInstruction']?.[0]?.timing?.repeat?.boundsPeriod?.end;
      if (end && end < new Date().toISOString()) return 'Past';
      return 'Unknown';
    }
  }
}

function doseOf(resource: Raw): string {
  const dosage = resource['dosageInstruction']?.[0] ?? resource['dosage']?.[0];
  if (!dosage) return '';
  if (typeof dosage.text === 'string' && dosage.text !== '') return dosage.text;
  const q = dosage.doseAndRate?.[0]?.doseQuantity;
  return q?.value !== undefined ? `${q.value} ${q.unit ?? ''}`.trim() : '';
}

function dateOf(resource: Raw): string {
  return resource['authoredOn'] ?? resource['effectiveDateTime'] ?? resource['whenHandedOver'] ?? resource['dateAsserted'] ?? '';
}

function medConcept(resource: Raw): Raw | undefined {
  return resource['medicationCodeableConcept'];
}

const TYPE_PRECEDENCE: Record<string, number> = {
  MedicationRequest: 0,
  MedicationStatement: 1,
  MedicationDispense: 2,
  Medication: 3,
};

function dedupKey(name: string, code: string, fallbackId: string): string {
  if (code !== '') return `rxnorm:${code}`;
  const norm = name.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  if (norm !== '') return `text:${norm}`;
  return `self:${fallbackId}`; // nameless: never merged blindly
}

function resolveState(contributors: Contributor[]): { state: MedState; conflict: boolean } {
  const stated = contributors.filter((c) => c.state !== '' && c.state !== 'Unknown');
  const distinct = new Set(stated.map((c) => c.state));
  if (distinct.size === 0) return { state: 'Unknown', conflict: false };
  if (distinct.size === 1) return { state: stated[0]!.state as MedState, conflict: false };

  // Conflict: most recently DATED stated contributor drives the badge; undated falls back to the
  // deterministic priority. The flag is the point — the disagreement stays visible.
  const dated = stated.filter((c) => c.date !== '').sort((a, b) => b.date.localeCompare(a.date));
  if (dated.length > 0) return { state: dated[0]!.state as MedState, conflict: true };
  const priority: MedState[] = ['Active', 'Suspended', 'Past'];
  for (const p of priority) {
    if (distinct.has(p)) return { state: p, conflict: true };
  }
  return { state: 'Unknown', conflict: true };
}

export function reconcile(inputs: MedInput[]): ReconciledMedication[] {
  const groups = new Map<string, { name: string; code: string; contributors: Contributor[] }>();

  for (const input of inputs) {
    const raw = input.resource as Raw;
    if ((raw['status'] ?? '').toLowerCase() === 'entered-in-error') continue;
    const type = raw['resourceType'];
    if (!(type in TYPE_PRECEDENCE)) continue;

    const concept = medConcept(raw);
    const name = conceptText(concept) || '';
    const code = rxCode(concept);
    const key = dedupKey(name, code, `${type}/${raw['id']}`);

    let group = groups.get(key);
    if (!group) {
      group = { name: name || `Unnamed medication`, code, contributors: [] };
      groups.set(key, group);
    }
    if (group.name === 'Unnamed medication' && name !== '') group.name = name;
    if (group.code === '' && code !== '') group.code = code;
    group.contributors.push({
      resourceType: type,
      id: raw['id'] ?? '',
      sourceId: input.sourceId,
      status: raw['status'] ?? '',
      state: stateOf(raw),
      date: dateOf(raw),
      dose: doseOf(raw),
    });
  }

  const rows: ReconciledMedication[] = [];
  for (const group of groups.values()) {
    const ordered = [...group.contributors].sort(
      (a, b) => (TYPE_PRECEDENCE[a.resourceType] ?? 9) - (TYPE_PRECEDENCE[b.resourceType] ?? 9)
    );
    const { state, conflict } = resolveState(ordered);
    const dose = ordered.map((c) => c.dose).find((d) => d !== '') ?? '';
    rows.push({
      name: group.name,
      rxNormCode: group.code,
      state,
      stateConflict: conflict,
      dose,
      sourceIds: [...new Set(ordered.map((c) => c.sourceId).filter(Boolean))],
      contributors: ordered,
    });
  }

  // Deterministic, patient-first order: Active, conflicts next (they need attention), then the rest;
  // alphabetical inside each band.
  const band = (r: ReconciledMedication) => (r.state === 'Active' ? 0 : r.stateConflict ? 1 : r.state === 'Suspended' ? 2 : r.state === 'Unknown' ? 3 : 4);
  rows.sort((a, b) => band(a) - band(b) || a.name.localeCompare(b.name));
  return rows;
}
