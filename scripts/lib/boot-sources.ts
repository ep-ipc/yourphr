/**
 * The managers a sync harness needs (yourphr#612): Records over a records file, Jobs and Sources
 * over an app database, the SMART client allowed to reach loopback fakes. What src/worker's
 * WorkerDeps used to be, now the real composition.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { dirname } from 'node:path';
import { ConfigurationManager } from '../../src/framework/ConfigurationManager.js';
import { FileConfigProvider } from '../../src/framework/providers/FileConfigProvider.js';
import { Engine } from '../../src/framework/Engine.js';
import { ApiContext } from '../../src/framework/ApiContext.js';
import { RecordsManager } from '../../src/app/managers/RecordsManager.js';
import { SqliteRecordsProvider } from '../../src/app/providers/SqliteRecordsProvider.js';
import { JobsManager } from '../../src/framework/managers/JobsManager.js';
import { SqliteJobsProvider } from '../../src/framework/providers/SqliteJobsProvider.js';
import { SourcesManager } from '../../src/app/managers/SourcesManager.js';
import { SqliteSourcesProvider } from '../../src/app/providers/SqliteSourcesProvider.js';
import { SmartSourceClientProvider } from '../../src/app/providers/SmartSourceClientProvider.js';
import { CatalogManager } from '../../src/app/managers/CatalogManager.js';
import { SqliteCatalogProvider } from '../../src/app/providers/SqliteCatalogProvider.js';
import { UsersManager } from '../../src/framework/managers/UsersManager.js';
import { SqliteUsersProvider } from '../../src/framework/providers/SqliteUsersProvider.js';
import { PasswordAuthProvider } from '../../src/framework/providers/PasswordAuthProvider.js';

export interface SourcesHarness {
  engine: Engine;
  records: RecordsManager;
  jobs: JobsManager;
  sources: SourcesManager;
  catalog: CatalogManager;
  /** A system principal acting for one account — what the harness connects sources as. */
  ctxFor: (username: string) => ApiContext;
  close: () => Promise<void>;
}

export async function bootSources(appDb: InstanceType<typeof Database>, recordsFile: string, options: { maxPages?: number; log?: (line: string) => void } = {}): Promise<SourcesHarness> {
  const engine = new Engine();
  const client = new SmartSourceClientProvider({ allowInternal: true });
  engine.register('configuration', new ConfigurationManager(engine, new FileConfigProvider(dirname(recordsFile))));
  engine.register('records', new RecordsManager(engine, new SqliteRecordsProvider(recordsFile, undefined)));
  engine.register('jobs', new JobsManager(engine, new SqliteJobsProvider(appDb)));
  engine.register('sources', new SourcesManager(engine, new SqliteSourcesProvider(appDb), client, { maxPages: options.maxPages ?? 10, log: options.log }));
  engine.register('users', new UsersManager(engine, new SqliteUsersProvider(appDb), new PasswordAuthProvider()));
  // The SSRF rule stays ON for catalog writes; a harness passes allowInternal per entry.
  engine.register('catalog', new CatalogManager(engine, new SqliteCatalogProvider(appDb), client, { allowInternal: false, log: options.log }));
  await engine.initialize();
  const { records, jobs, sources, catalog } = engine.managers;
  records.sourceDisplay = (id) => sources.displayOf(id);
  return { engine, records, jobs, sources, catalog, ctxFor: (u) => ApiContext.system('harness', u, engine), close: () => engine.shutdown() };
}
