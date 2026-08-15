/**
 * Export FHIR resources out of a YourPHR SQLite database into newline-delimited JSON.
 *
 * The whole spike rests on one property of the existing schema: every `fhir_*` table carries
 * `resource_raw JSON` holding the canonical FHIR resource intact, alongside the extracted
 * search-parameter columns. So getting data out is a read, not a transformation — nothing is
 * reinterpreted on the way, and the same corpus can be replayed against both stacks and diffed.
 *
 * PHI: the output goes to ./phi/, which .gitignore excludes. Never move it elsewhere in the tree.
 * Prefer pointing --out at a path OUTSIDE this repo entirely.
 *
 *   npm run export -- --db /path/to/fasten.db [--out phi/resources.ndjson] [--key <sqlcipher key>]
 *
 * The key may also come from YOURPHR_DB_KEY. Omit it for an unencrypted database.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface Args {
  db: string;
  out: string;
  key?: string;
  /** Export one account's records only. The API is per-user, so a shadow comparison must be too. */
  user?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const db = get('--db');
  if (!db) {
    console.error('usage: npm run export -- --db <path> [--out phi/resources.ndjson] [--key <key>]');
    process.exit(2);
  }
  return {
    db: resolve(db),
    out: resolve(get('--out') ?? 'phi/resources.ndjson'),
    key: get('--key') ?? process.env.YOURPHR_DB_KEY,
    user: get('--user'),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const db = new Database(args.db, { readonly: true });
  if (args.key) {
    // Matches the DSN pragmas the Go side uses (`_cipher=sqlcipher`). If this throws or the first
    // query fails with "file is not a database", the key is wrong — that is the SQLCipher
    // compatibility question the evaluation flagged as needing proof, so treat it as a finding.
    db.pragma("cipher='sqlcipher'");
    db.pragma(`key='${args.key.replace(/'/g, "''")}'`);
  }

  let userId: string | undefined;
  if (args.user) {
    const row = db.prepare('SELECT id FROM users WHERE username = ?').get(args.user) as
      | {id: string}
      | undefined;
    if (!row) {
      console.error(`no user named ${args.user} in ${args.db}`);
      process.exit(1);
    }
    userId = row.id;
    console.log(`exporting records belonging to ${args.user} only`);
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fhir_%' ORDER BY name")
    .all() as { name: string }[];

  if (tables.length === 0) {
    console.error(`no fhir_* tables in ${args.db} — is this a YourPHR database?`);
    process.exit(1);
  }

  mkdirSync(dirname(args.out), { recursive: true });
  const out = createWriteStream(args.out, { encoding: 'utf8' });

  let total = 0;
  const perTable: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  for (const { name } of tables) {
    let rows: { resource_raw: string | null }[];
    try {
      // Scoped to one user when asked. Every fhir_* table carries user_id, and YourPHR's API
      // enforces the same isolation, so an unscoped export cannot be compared against it.
      const sql = userId
        ? `SELECT resource_raw FROM "${name}" WHERE deleted_at IS NULL AND user_id = ?`
        : `SELECT resource_raw FROM "${name}" WHERE deleted_at IS NULL`;
      rows = (userId ? db.prepare(sql).all(userId) : db.prepare(sql).all()) as {
        resource_raw: string | null;
      }[];
    } catch {
      // Not every fhir_* table necessarily has the same shape; skip rather than abort a long export.
      continue;
    }

    for (const row of rows) {
      if (!row.resource_raw) {
        skipped[name] = (skipped[name] ?? 0) + 1;
        continue;
      }
      // Written through unparsed: the point is that nothing is reinterpreted on the way out.
      out.write(row.resource_raw.replace(/\n/g, ' ') + '\n');
      perTable[name] = (perTable[name] ?? 0) + 1;
      total++;
    }
  }

  out.end();
  db.close();

  for (const [table, count] of Object.entries(perTable).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(7)}  ${table}`);
  }
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal > 0) {
    console.log(`\n${skippedTotal} row(s) had a NULL resource_raw and were skipped:`, skipped);
  }
  console.log(`\n${total} resources -> ${args.out}`);
}

main();
