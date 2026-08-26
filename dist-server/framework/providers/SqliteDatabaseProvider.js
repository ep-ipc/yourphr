/** The app database as a SQLite (SQLCipher) file (yourphr#617): opened and migrated at construction so sibling providers see a finished schema. */
import Database from 'better-sqlite3-multiple-ciphers';
import { BaseDatabaseProvider } from './BaseDatabaseProvider.js';
import { runMigrations } from './sqlite-migrations.js';
import { existsSync, statSync } from 'node:fs';
export class SqliteDatabaseProvider extends BaseDatabaseProvider {
    file;
    name = 'sqlite';
    db;
    closed = false;
    /** What the ledger did at open — applied ids, skipped count. */
    migrations;
    constructor(file, key, ledger) {
        super();
        this.file = file;
        this.db = new Database(file);
        if (key !== '') {
            this.db.pragma("cipher='sqlcipher'");
            this.db.pragma(`key='${key.replace(/'/g, "''")}'`);
        }
        try {
            this.migrations = runMigrations(this.db, ledger);
        }
        catch (err) {
            this.db.close();
            throw err;
        }
    }
    get handle() { return this.db; }
    async initialize() { }
    storage() {
        return { location: this.file, sizeBytes: existsSync(this.file) ? statSync(this.file).size : 0 };
    }
    async integrityOk() {
        try {
            return String(this.db.pragma('quick_check')[0]?.quick_check ?? '').toLowerCase() === 'ok';
        }
        catch {
            return false;
        }
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.db.close();
    }
}
//# sourceMappingURL=SqliteDatabaseProvider.js.map