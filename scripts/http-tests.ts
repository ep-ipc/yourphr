/**
 * Does the TypeScript stack serve what the Angular frontend expects (#537)?
 *
 * The evaluation assumes a backend rewrite does not force a frontend rewrite. This tests that over
 * real HTTP, against real records, by comparing the served payloads with what the Go stack answered
 * for the same corpus (phi/go-ids.json, produced by TestShadowExport in the product repo).
 *
 *   npm run http -- --db phi/shadow-spike.db --go phi/go-ids.json
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {AddressInfo} from 'node:net';
import {SqliteFhirRepository} from '../src/SqliteFhirRepository.js';
import {createYourPhrServer} from '../src/server.js';

function arg(flag: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}

const results: {name: string; ok: boolean; detail: string}[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({name, ok, detail});
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const dbFile = resolve(arg('--db', 'phi/shadow-spike.db'));
  const goPath = resolve(arg('--go', 'phi/go-ids.json'));
  const goAnswers = JSON.parse(readFileSync(goPath, 'utf8')) as Record<string, string[]>;

  const repo = new SqliteFhirRepository({file: dbFile});
  const server = createYourPhrServer({repo});
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const {port} = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  console.log(`\nserving on ${base}\n`);

  // 1. The list endpoint the record screens call.
  const conditions = (await (await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition`)).json()) as any;
  check('the list endpoint answers in YourPHR\'s envelope', conditions.success === true && Array.isArray(conditions.data));
  check('it returns the same records the Go stack returns',
    conditions.data.length === (goAnswers['Condition']?.length ?? -1),
    `${conditions.data.length} vs go ${goAnswers['Condition']?.length}`);

  const goIds = new Set(goAnswers['Condition'] ?? []);
  const servedIds = conditions.data.map((r: any) => r.source_resource_id);
  check('every id matches the Go stack', servedIds.every((id: string) => goIds.has(id)));

  // 2. The wrapper shape the Angular ResourceFhir model expects.
  const sample = conditions.data[0];
  const required = ['source_id', 'source_resource_type', 'source_resource_id', 'fhir_version', 'resource_raw'];
  check('each record carries the fields the frontend model reads',
    required.every((field) => sample?.[field] !== undefined),
    required.filter((field) => sample?.[field] === undefined).join(', ') || 'all present');

  check('resource_raw is the FHIR resource itself', sample?.resource_raw?.resourceType === 'Condition');

  // sort_title drives the list labels. Empty means a screen of blank rows — the kind of break that
  // passes every assertion about ids and is obvious the moment a human looks.
  const titled = conditions.data.filter((r: any) => (r.sort_title ?? '') !== '').length;
  check('records carry a display title', titled > 0,
    `${titled}/${conditions.data.length} have sort_title`);

  // 3. The detail endpoint.
  const detail = (await (await fetch(`${base}/api/secure/resource/fhir/spike/${sample.source_resource_id}`)).json()) as any;
  check('the detail endpoint returns one record', detail.success === true &&
    detail.data?.source_resource_id === sample.source_resource_id);

  const missing = await fetch(`${base}/api/secure/resource/fhir/spike/does-not-exist`);
  check('an unknown record is 404, not 500', missing.status === 404);

  // 4. The summary the dashboard counts from.
  const summary = (await (await fetch(`${base}/api/secure/summary`)).json()) as any;
  const counts: Record<string, number> = {};
  for (const row of summary.data.resource_type_counts) {
    counts[row.resource_type] = row.count;
  }
  const mismatched = Object.keys(goAnswers).filter(
    (type) => (counts[type] ?? 0) !== (goAnswers[type]?.length ?? 0)
  );
  check('summary counts match the Go stack for every resource type', mismatched.length === 0,
    mismatched.length ? `differ: ${mismatched.slice(0, 5).join(', ')}` : `${Object.keys(counts).length} types`);

  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
