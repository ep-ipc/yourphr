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
// MUST be first: a side-effecting import that populates process.env from .env before any other
// module's top-level code runs (yourphr#630). Imports are hoisted, so ordering here is the
// mechanism, not a style choice.
import './bootstrap-env.js';
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleApp } from './app.js';
import { envNameFor } from './config/index.js';
import { Engine } from './framework/Engine.js';
import { ConfigurationManager } from './framework/ConfigurationManager.js';
import { FileConfigProvider } from './framework/providers/FileConfigProvider.js';
import { appLog } from './log/index.js';

const EX_CONFIG = 78;

function refuse(message: string): never {
  console.error(`refusing to start: ${message}`);
  process.exit(EX_CONFIG);
}

const env = process.env;

// The fast storage root is a plain environment variable, not a configuration key: it is what
// LOCATES the configuration, so it cannot be set inside it (yourphr#630). `./data` is the default,
// which is what lets an unpacked copy run without an operator setting anything — ngdpbase ships
// the same default. The pre-#630 name is still honoured so an existing deployment keeps booting.
const dataDir = env['YOURPHR_FAST_STORAGE'] ?? env['YOURPHR_STORAGE_DATA_DIR'] ?? './data';
try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
} catch (err) {
  refuse(`${dataDir} is not a writable directory (${(err as Error).message})`);
}

const webDir = env[envNameFor('yourphr.web.static-dir')] ?? '';
if (webDir !== '' && !existsSync(join(webDir, 'index.html'))) {
  refuse(`${envNameFor('yourphr.web.static-dir')}=${webDir} holds no index.html — the built Angular app is expected there`);
}

// Bootstrap values are read once here; assembleApp() builds its own manager over the same files
// for everything else. Two reads of one file, one truth. Configuration is the bootstrap layer
// (yourphr#621), so its provider is chosen here rather than by configuration.
const bootstrap = new ConfigurationManager(new Engine(), new FileConfigProvider(dataDir), { env });
const port = bootstrap.getInt('yourphr.web.listen.port');
const host = bootstrap.getString('yourphr.web.listen.host');
const intervalSeconds = bootstrap.getInt('yourphr.sync.interval-seconds');
if (bootstrap.getString('yourphr.database.encryption.key') === '') {
  appLog.warn(`${envNameFor('yourphr.database.encryption.key')} is not set — the database and the tokens in it are stored in the clear`);
} else if (existsSync(join(dataDir, '.env'))) {
  // The keys came from a file on the data volume, which is the arrangement yourphr#630 moves to
  // and the one that loses them if the volume is lost. There is no way to check whether the
  // operator recorded them elsewhere, so say it every start rather than assume: the failure is
  // silent until a restore, and by then it is not recoverable.
  appLog.warn(`the encryption keys are on this volume only (${join(dataDir, '.env')}) — if it is lost, the database and every backup become permanently unreadable. Record ${envNameFor('yourphr.database.encryption.key')} and ${envNameFor('yourphr.backup.encryption.key')} somewhere that is not this instance.`);
}

/**
 * The version the UI shows, read from package.json beside the compiled output — found by walking UP
 * rather than by counting directories.
 *
 * `../package.json` was right while main.js sat at dist/main.js and wrong the moment the build
 * output moved to dist/server/ (yourphr#652). It crash-looped the instance at import time, before
 * anything served, on a path that exists in the source tree and not in the image — the kind of
 * mistake a relative literal makes and a search does not. tsx runs this from src/ and the image
 * runs it from dist/server/; both find the same file.
 */
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 5; up++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return (JSON.parse(readFileSync(candidate, 'utf8')) as { version: string }).version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not fatal: an instance that cannot name its own version should still serve records. The banner
  // says 0.0.0-unknown, which is visibly wrong rather than quietly stale (yourphr#642's lesson).
  appLog.warn('could not find package.json beside the build output — reporting the version as 0.0.0-unknown');
  return '0.0.0-unknown';
}

const version = readVersion();

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
