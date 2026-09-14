// What POST /secure/source/manual reports about an uploaded file (#736, #735): the counts behind
// "it worked", so the page can say what actually happened instead of saying nothing.
export interface UploadResult {
  // 'fhir' for a FHIR file, or the format it was converted from ('ccda').
  format: string;
  received: number;
  created: number;
  updated: number;
  // Records another connected source already holds under the same id — not imported, never merged.
  collisions: number;
  // Entries or lines in the file that could not be read.
  skipped: number;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// Plain language for the person who uploaded the file (#262): what was added, what was refreshed,
// and — the part a silent success would hide — what was left out and why.
export function uploadResultMessage(r: UploadResult): string {
  const parts: string[] = [];
  if (r.created > 0) parts.push(`Added ${plural(r.created, 'new record', 'new records')}.`);
  if (r.updated > 0) parts.push(`Refreshed ${plural(r.updated, 'record', 'records')} you already had from this file.`);
  if (r.created === 0 && r.updated === 0) parts.push('Nothing new was added.');
  if (r.collisions > 0) parts.push(`${plural(r.collisions, 'record was', 'records were')} left out because another of your connected sources already has ${r.collisions === 1 ? 'it' : 'them'}.`);
  if (r.skipped > 0) parts.push(`${plural(r.skipped, 'part', 'parts')} of the file could not be read and ${r.skipped === 1 ? 'was' : 'were'} skipped.`);
  return parts.join(' ');
}
