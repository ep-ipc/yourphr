const ID_SHAPE = /^\d{14}$/;
/**
 * ADD COLUMN with a default AND a backfill of existing rows, in one statement pair — the #528
 * spelling. SQLite's ADD COLUMN ... DEFAULT only applies the default to rows created afterwards
 * on some historic versions and to reads via the schema on others; the explicit UPDATE removes
 * the ambiguity for every row that already exists.
 */
export function addColumnWithDefault(db, table, column, type, defaultValue) {
    const quoted = typeof defaultValue === 'string' ? `'${defaultValue.replace(/'/g, "''")}'` : String(defaultValue);
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type} NOT NULL DEFAULT ${quoted}`);
    db.exec(`UPDATE "${table}" SET "${column}" = ${quoted} WHERE "${column}" IS NULL`);
}
/**
 * Applies every pending migration, in order, each in its own transaction. Stops loudly at the
 * first failure, leaving everything before it applied and everything from it untouched — a rerun
 * after the fix picks up exactly there.
 */
export function runMigrations(db, registry) {
    // Registry hygiene before anything touches the database.
    let previous = '';
    for (const m of registry) {
        if (!ID_SHAPE.test(m.id)) {
            throw new Error(`migration id ${m.id} is not YYYYMMDDHHMMSS`);
        }
        if (m.id <= previous) {
            throw new Error(`migration ids must be strictly ascending: ${m.id} follows ${previous}`);
        }
        previous = m.id;
    }
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
    // Downgrade protection: an applied id the registry does not know means the database belongs to a
    // NEWER build. Opening it anyway is how corruption happens — refuse, name the ids.
    const appliedIds = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
    const known = new Set(registry.map((m) => m.id));
    const fromTheFuture = [...appliedIds].filter((id) => !known.has(id));
    if (fromTheFuture.length > 0) {
        throw new Error(`database schema is newer than this build — applied migrations this build does not know: ${fromTheFuture.sort().join(', ')}. Refusing to start; upgrade the app or restore the matching backup.`);
    }
    const report = { applied: [], skipped: 0 };
    for (const migration of registry) {
        if (appliedIds.has(migration.id)) {
            report.skipped++;
            continue;
        }
        db.exec('BEGIN');
        try {
            migration.up(db);
            db.prepare('INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)').run(migration.id, migration.description, new Date().toISOString());
            db.exec('COMMIT');
        }
        catch (err) {
            db.exec('ROLLBACK');
            // The id in the error is what makes a 2am failure debuggable from the log line alone.
            throw new Error(`migration ${migration.id} (${migration.description}) failed and was rolled back: ${err.message}`);
        }
        report.applied.push(migration.id);
    }
    return report;
}
//# sourceMappingURL=sqlite-migrations.js.map