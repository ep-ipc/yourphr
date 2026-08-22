/**
 * The managers a sync harness needs (yourphr#612): Records over a records file, Jobs and Sources
 * over an app database, the SMART client allowed to reach loopback fakes. What src/worker's
 * WorkerDeps used to be, now the real composition.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { Engine } from '../../src/framework/Engine.js';
import { ApiContext } from '../../src/framework/ApiContext.js';
import { RecordsManager } from '../../src/app/managers/RecordsManager.js';
import { SqliteRecordsProvider } from '../../src/app/providers/SqliteRecordsProvider.js';
import { JobsManager } from '../../src/framework/managers/JobsManager.js';
import { SqliteJobsProvider } from '../../src/framework/providers/SqliteJobsProvider.js';
import { SourcesManager } from '../../src/app/managers/SourcesManager.js';
import { SqliteSourcesProvider } from '../../src/app/providers/SqliteSourcesProvider.js';
import { SmartSourceClientProvider } from '../../src/app/providers/SmartSourceClientProvider.js';

export interface SourcesHarness {
  engine: Engine;
  records: RecordsManager;
  jobs: JobsManager;
  sources: SourcesManager;
  /** A system principal acting for one account — what the harness connects sources as. */
  ctxFor: (username: string) => ApiContext;
  close: () => Promise<void>;
}

export async function bootSources(appDb: InstanceType<typeof Database>, recordsFile: string, options: { maxPages?: number; log?: (line: string) => void } = {}): Promise<SourcesHarness> {
  const engine = new Engine();
  engine.register('records', new RecordsManager(engine, new SqliteRecordsProvider(recordsFile, undefined)));
  engine.register('jobs', new JobsManager(engine, new SqliteJobsProvider(appDb)));
  engine.register('sources', new SourcesManager(engine, new SqliteSourcesProvider(appDb), new SmartSourceClientProvider({ allowInternal: true }), { maxPages: options.maxPages ?? 10, log: options.log }));
  await engine.initialize();
  const { records, jobs, sources } = engine.managers;
  records.sourceDisplay = (id) => sources.displayOf(id);
  return { engine, records, jobs, sources, ctxFor: (u) => ApiContext.system('harness', u, engine), close: () => engine.shutdown() };
}
