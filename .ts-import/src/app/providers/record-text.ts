/**
 * The human-readable text of a record (yourphr#599): what a person would recognise — display names,
 * code text, notes, narrative, dates — derived from the resource, never the raw JSON. Ids, system
 * URIs, references and bare codes are left out on purpose: "metformin" should match the
 * medication, not every record that mentions an identifier containing those letters.
 */
const TEXT_KEYS = new Set(['text', 'display', 'title', 'description', 'name', 'family', 'given', 'prefix', 'suffix', 'valueString', 'comment', 'conclusion', 'summary', 'detail', 'unit', 'status', 'outcome', 'criticality', 'severity']);
const DATE_KEYS = new Set(['effectiveDateTime', 'issued', 'onsetDateTime', 'abatementDateTime', 'recordedDate', 'occurrenceDateTime', 'performedDateTime', 'authoredOn', 'date', 'created', 'dateAsserted', 'start', 'end', 'birthDate']);
const SKIP_KEYS = new Set(['id', 'reference', 'system', 'code', 'url', 'identifier', 'meta', 'extension', 'modifierExtension', 'data', 'contentType', 'fullUrl', 'versionId', 'lastUpdated', 'profile', 'fhir_comments']);
const MAX_CHARS = 8_000;

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function textFor(resource: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown, key: string): void => {
    if (out.join(' ').length > MAX_CHARS) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, key)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (SKIP_KEYS.has(k)) continue;
        if (k === 'div' && typeof v === 'string') { out.push(stripTags(v)); continue; }
        walk(v, k);
      }
      return;
    }
    if (typeof node === 'string') {
      if (key === 'resourceType') out.push(node.replace(/([a-z])([A-Z])/g, '$1 $2'));
      else if (TEXT_KEYS.has(key)) out.push(node);
      else if (DATE_KEYS.has(key)) out.push(node.slice(0, 10));
    } else if (typeof node === 'number' && key === 'value') {
      out.push(String(node));
    }
  };
  walk(resource, '');
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

/** A person's words as an FTS5 query: every term required, the last one as a prefix, nothing else interpreted. */
export function ftsQuery(q: string): string {
  const terms = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0).slice(0, 12);
  if (terms.length === 0) return '';
  return terms.map((t, i) => `"${t.replace(/"/g, '')}"${i === terms.length - 1 ? '*' : ''}`).join(' AND ');
}
