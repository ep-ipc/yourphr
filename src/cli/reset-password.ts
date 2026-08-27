/**
 * `reset-password` — the way back in when nobody can sign in at all (yourphr#510), reachable from
 * the image rather than nowhere (yourphr#654).
 *
 *   yourphr reset-password --user <account> [--data <data dir>]
 *
 * Go shipped this as a subcommand and the TypeScript stack implemented the behaviour
 * (`UsersManager.recoverAccess`) without ever exposing it. Same gap as `migrate`, same shape,
 * fixed in the same place.
 *
 * The generated password is written to `<data>/.recovery_password` at mode 0600 and is NEVER
 * printed: stdout of a `docker run` goes to the container log, and a password in a log is a
 * password in a log aggregator. The path is printed instead — the same contract first start uses
 * for the bootstrap admin.
 *
 * Deliberately NOT reachable from a route, and this command is why it does not need to be: the
 * proof of authority is that you can run a process against the data directory, not that you hold
 * a session.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStores } from '../app.js';
import { flag, unknownFlags } from './args.js';

const VALUED = ['--user', '--data'] as const;

export const RESET_PASSWORD_USAGE = 'usage: yourphr reset-password --user <account> [--data <data dir>]';

const EX_USAGE = 2;

export async function resetPassword(argv: string[]): Promise<number> {
  const unknown = unknownFlags(argv, VALUED, []);
  if (unknown.length > 0) {
    console.error(`reset-password: unknown ${unknown.length === 1 ? 'flag' : 'flags'} ${unknown.join(' ')}\n${RESET_PASSWORD_USAGE}`);
    return EX_USAGE;
  }

  const username = flag(argv, '--user');
  if (!username) {
    console.error(RESET_PASSWORD_USAGE);
    return EX_USAGE;
  }

  // The same default and the same pre-#630 fallback the server resolves, so an operator who set
  // nothing gets the instance they are already running rather than a second one.
  const dataDir = resolve(flag(argv, '--data') ?? process.env['YOURPHR_FAST_STORAGE'] ?? process.env['YOURPHR_STORAGE_DATA_DIR'] ?? './data');
  // Unlike `migrate`, which creates the directory it is given, recovery only ever acts on an
  // instance that already exists. Creating one here would answer a mistyped --data with a fresh
  // empty database and the honest-but-useless report that the account does not exist.
  if (!existsSync(dataDir)) {
    console.error(`reset-password: ${dataDir} does not exist — name the running instance's data directory with --data`);
    return EX_USAGE;
  }

  const stores = await openStores(dataDir, process.env);
  try {
    const { passwordFile } = await stores.users.recoverAccess(dataDir, username);
    console.log(`reset ${username}: the new password is in ${passwordFile} (mode 0600) — sign in once and change it. Every existing session of this account has ended.`);
    return 0;
  } finally {
    await stores.close();
  }
}
