/**
 * Shadow read-only: does the TypeScript stack answer what the GO stack answers, for one account's
 * real records?
 *
 * This is the migration plan's first step — run both over one corpus and diff the responses before
 * anything owns a surface. The `diff` script compares this implementation against Medplum's
 * reference; THIS one compares it against the system actually in production, which is the harder
 * and more meaningful test: the reference and the spike share a worldview, YourPHR's Go backend
 * does not.
 *
 * The Go side is produced by TestShadowExport in the product repo, which reads through
 * GormRepository — the same code path the HTTP handler uses — so no session or credentials are
 * involved, and it reads a COPY of a snapshot rather than any live database:
 *
 *   SHADOW_DB=<copy> SHADOW_USER=<account> SHADOW_OUT=<file> \
 *     go test ./backend/pkg/database/ -run TestShadowExport
 *
 * Then:
 *
 *   npm run shadow -- --go <file> --db phi/shadow-spike.db
 *
 * Exits non-zero on any disagreement.
 */
import type {ResourceType} from '@medplum/fhirtypes';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {SqliteFhirRepository} from '../src/SqliteFhirRepository.js';

function arg(flag: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}

async function main(): Promise<void> {
  const goPath = resolve(arg('--go', 'phi/go-ids.json'));
  const dbFile = resolve(arg('--db', 'phi/shadow-spike.db'));

  const goAnswers = JSON.parse(readFileSync(goPath, 'utf8')) as Record<string, string[]>;
  const repo = new SqliteFhirRepository({file: dbFile});

  const types = Object.keys(goAnswers).sort();
  let agreed = 0;
  const disagreements: string[] = [];

  console.log(`comparing ${types.length} resource types\n`);

  for (const resourceType of types) {
    const expected = [...goAnswers[resourceType]].sort();

    let actual: string[];
    try {
      // Ask for more than the corpus holds so nothing is truncated: a page-limited comparison is
      // what produced three false disagreements the first time this was run against real data.
      const bundle = await repo.search({
        resourceType: resourceType as ResourceType,
        count: expected.length + 1000,
      });
      actual = (bundle.entry ?? []).map((entry) => entry.resource?.id ?? '').sort();
    } catch (err) {
      disagreements.push(`${resourceType}: sqlite threw — ${(err as Error).message}`);
      continue;
    }

    if (expected.join(',') === actual.join(',')) {
      agreed++;
      console.log(`  OK   ${resourceType.padEnd(28)} ${expected.length}`);
      continue;
    }

    const missing = expected.filter((id) => !actual.includes(id));
    const extra = actual.filter((id) => !expected.includes(id));
    console.log(`  DIFF ${resourceType.padEnd(28)} go=${expected.length} ts=${actual.length}`);
    disagreements.push(
      `${resourceType}: go=${expected.length} ts=${actual.length}` +
        (missing.length ? `\n      missing from ts: ${missing.slice(0, 3).join(', ')}` : '') +
        (extra.length ? `\n      extra in ts: ${extra.slice(0, 3).join(', ')}` : '')
    );
  }

  console.log(`\n${agreed}/${types.length} resource types agree exactly`);

  if (disagreements.length) {
    console.log(`\n${disagreements.length} DISAGREEMENT(S):`);
    for (const line of disagreements) {
      console.log(`  - ${line}`);
    }
  }

  repo.db.close();

  if (disagreements.length > 0) {
    process.exit(1);
  }
  console.log('\nthe TypeScript stack returns exactly what the Go stack returns');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
