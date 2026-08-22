/**
 * The process (yourphr#587). The environment carries BOOTSTRAP and secrets only — where the data
 * lives, which port, the at-rest keys — and the settings store owns everything else, per the rule
 * ratified on yourphr#472. Every key here is named by envNameFor(), the same mapping the settings
 * screen shows, so an operator reading the screen knows which variable to set.
 *
 * Refuses to start rather than degrade. A missing data directory, an unwritable one, or a static
 * directory with no index.html is a configuration error; a process that boots "inert" in that
 * state is the failure yourphr#546 names, and it is worse than a crash because nobody notices.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleApp } from './app.js';
import { ConfigStore, envNameFor } from './config/index.js';
import { appLog } from './log/index.js';

const EX_CONFIG = 78;

function refuse(message: string): never {
  console.error(`refusing to start: ${message}`);
  process.exit(EX_CONFIG);
}

const env = process.env;

const dataDir = env[envNameFor('storage.data_dir')] ?? '';
if (dataDir === '') {
  refuse(`${envNameFor('storage.data_dir')} is not set — the data directory is bootstrap configuration and has no default`);
}
try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
} catch (err) {
  refuse(`${dataDir} is not a writable directory (${(err as Error).message})`);
}

const webDir = env[envNameFor('web.static-dir')] ?? '';
if (webDir !== '' && !existsSync(join(webDir, 'index.html'))) {
  refuse(`${envNameFor('web.static-dir')}=${webDir} holds no index.html — the built Angular app is expected there`);
}

// Bootstrap values are read once here; assembleApp() reads the same store again for everything
// else. Two reads of one file, one truth.
const bootstrap = new ConfigStore(dataDir, undefined, env);
const port = bootstrap.getInt('web.listen.port');
const host = bootstrap.getString('web.listen.host');
const intervalSeconds = bootstrap.getInt('sync.interval-seconds');
if (bootstrap.getString('database.encryption.key') === '') {
  appLog.warn(`${envNameFor('database.encryption.key')} is not set — the database and the tokens in it are stored in the clear`);
}

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const app = await assembleApp(dataDir, {
  env,
  webDir: webDir === '' ? undefined : webDir,
  workerIntervalMs: intervalSeconds > 0 ? intervalSeconds * 1000 : undefined,
  version,
});

if (app.bootstrapPasswordFile) {
  appLog.info(`first start: bootstrap admin created; its password is in ${app.bootstrapPasswordFile} (mode 0600) — sign in once and change it`);
}

app.server.listen(port, host, () => {
  appLog.info(`yourphr-ts-spike ${version} listening on ${host}:${port}; data in ${dataDir}; ${webDir === '' ? 'API only' : `serving ${webDir}`}; worker ${intervalSeconds > 0 ? `every ${intervalSeconds}s` : 'off'}`);
});

const shutdown = (signal: string): void => {
  appLog.info(`${signal}: closing`);
  app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
