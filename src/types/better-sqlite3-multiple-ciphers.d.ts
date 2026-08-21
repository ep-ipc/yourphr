/**
 * The package ships `index.d.ts` but its package.json "exports" map does not point at it, so
 * TypeScript cannot resolve the real types under moduleResolution "bundler". This is the minimum
 * surface the spike uses, not an attempt at a full definition — if the spike proceeds, replace it
 * by fixing resolution properly rather than growing this file.
 */
declare module 'better-sqlite3-multiple-ciphers' {
  interface Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
  }

  class Database {
    constructor(filename: string, options?: DatabaseOptions);
    prepare(sql: string): Statement;
    pragma(source: string): unknown;
    exec(sql: string): this;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): this;
  }

  export default Database;
}
