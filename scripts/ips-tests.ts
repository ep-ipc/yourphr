/**
 * IPS harness (yourphr#577). Synthetic corpus only, no PHI.
 *
 * Load-bearing checks: a REQUIRED section with no data still appears with its explicit empty
 * statement (silence and "no known allergies" are different clinical facts); narratives carry the
 * record's own words, no raw codes, nothing guessed; the build is deterministic byte for byte.
 *
 *   npm run ips
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Resource } from '@medplum/fhirtypes';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';
import { buildIps, IPSSections } from '../src/ips/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-ips-'));

  // The same generated corpus CI uses — patients, conditions, observations, encounters,
  // immunizations, allergies, documents. Notably NO medications: the required medication section
  // must therefore appear as an explicit empty statement, which is the check that matters.
  const corpus = join(dir, 'corpus.ndjson');
  execFileSync('npx', ['tsx', 'scripts/make-synthetic-corpus.ts', '--out', corpus], { stdio: 'ignore' });
  const repo = new SqliteFhirRepository({ file: join(dir, 'ips.db'), userId: 'ips-user' });
  for (const line of readFileSync(corpus, 'utf8').split('\n').filter(Boolean)) {
    await repo.updateResource(JSON.parse(line) as Resource);
  }

  const NOW = new Date('2026-08-20T12:00:00Z');
  const { bundle, sections } = await buildIps(repo, NOW);

  check('the document is a FHIR document Bundle led by a Composition',
    bundle.type === 'document' && bundle.entry?.[0]?.resource?.resourceType === 'Composition');

  const composition = bundle.entry?.[0]?.resource as { section?: { title?: string; text?: { div?: string }; entry?: unknown[]; emptyReason?: unknown }[]; subject?: { reference?: string } };
  check('the Composition names the patient as its subject', composition.subject?.reference?.startsWith('Patient/') === true);

  const required = IPSSections.filter((s) => s.group === 'required').map((s) => s.key);
  check('every REQUIRED section is present even when the record holds nothing for it',
    required.every((k) => sections.includes(k)), sections.join(','));

  const meds = composition.section?.find((s) => s.title === 'Medications');
  check('the empty required section carries an explicit statement and emptyReason — not silence',
    !!meds && !meds.entry && !!meds.emptyReason && (meds.text?.div ?? '').includes('No medications are recorded'));

  const problems = composition.section?.find((s) => s.title === 'Health problems');
  check('a populated section lists its records and references each one',
    (problems?.entry?.length ?? 0) === 6 && (problems?.text?.div ?? '').includes('Hypertension'));

  const allNarratives = (composition.section ?? []).map((s) => s.text?.div ?? '').join('');
  check('narratives are the record\'s own words with dates — no raw codes leak',
    allNarratives.includes('Hypertension — 2024-01-10') && !allNarratives.includes('38341003') && !allNarratives.includes('http://snomed'));
  check('recommended sections with data are present; empty ones are omitted, not fabricated',
    sections.includes('immunizations') && !sections.includes('medical_devices'));

  const again = await buildIps(repo, NOW);
  check('the build is deterministic — two runs are byte-identical',
    JSON.stringify(bundle) === JSON.stringify(again.bundle));

  const everyReferenced = (composition.section ?? []).flatMap((s) => (s.entry ?? []) as { reference: string }[]).map((e) => e.reference);
  const inBundle = new Set((bundle.entry ?? []).slice(1).map((e) => `${e.resource?.resourceType}/${e.resource?.id}`));
  check('every section reference resolves inside the document bundle',
    everyReferenced.every((ref) => inBundle.has(ref)), `${everyReferenced.length} refs`);

  // No-guessing: a record with no display text must say so, not invent one.
  await repo.updateResource({ resourceType: 'Condition', id: 'nameless', subject: { reference: 'Patient/syn-patient-1' } } as never);
  const withNameless = await buildIps(repo, NOW);
  const problemsDiv = (withNameless.bundle.entry?.[0]?.resource as { section?: { title?: string; text?: { div?: string } }[] }).section?.find((s) => s.title === 'Health problems')?.text?.div ?? '';
  check('a record with no stated name shows as Unnamed, never a guessed label', problemsDiv.includes('Unnamed Condition'));

  repo.db.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`ips harness failed: ${(err as Error).message}`);
  process.exit(1);
});
