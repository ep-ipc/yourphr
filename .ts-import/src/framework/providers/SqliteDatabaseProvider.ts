/** The app database as a SQLite (SQLCipher) file (yourphr#617): opened and migrated at construction so sibling providers see a finished schema. */
import Database from 'better-sqlite3-multiple-ciphers';
import { BaseDatabaseProvider } from './BaseDatabaseProvider.js';
import { runMigrations, type Migration, type MigrationReport } from './sqlite-migrations.js';
import { existsSync, statSync } from 'node:fs';

export class SqliteDatabaseProvider extends BaseDatabaseProvider<InstanceType<typeof Database>> {
  readonly name = 'sqlite';
  private readonly db: InstanceType<typeof Database>;
  private closed = false;
  /** What the ledger did at open — applied ids, skipped count. */
  readonly migrations: MigrationReport;

  constructor(private readonly file: string, key: string, ledger: Migration[]) {
    super();
    this.db = new Database(file);
    if (key !== '') {
      this.db.pragma("cipher='sqlcipher'");
      this.db.pragma(`key='${key.replace(/'/g, "''")}'`);
    }
    try {
      this.migrations = runMigrations(this.db, ledger);
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  get handle(): InstanceType<typeof Database> { return this.db; }

  async initialize(): Promise<void> { /* opened and migrated in the constructor, before any sibling provider */ }

  storage(): { location: string; sizeBytes: number } {
    return { location: this.file, sizeBytes: existsSync(this.file) ? statSync(this.file).size : 0 };
  }

  async integrityOk(): Promise<boolean> {
    try {
      return String((this.db.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check ?? '').toLowerCase() === 'ok';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
