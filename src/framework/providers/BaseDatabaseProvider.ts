/**
 * The application database (yourphr#617): the one connection the app-level providers share —
 * accounts, sessions' users, sources, jobs, catalog, audit, favourites. The provider opens it under
 * its key, runs the schema ledger, answers for its integrity and closes it; the composition root
 * hands the handle to sibling providers and nobody else.
 */
export abstract class BaseDatabaseProvider<Handle = unknown> {
  abstract readonly name: string;
  /** The open, migrated connection — for the sibling providers' constructors, via the composition root. */
  abstract get handle(): Handle;
  abstract initialize(): Promise<void>;
  abstract integrityOk(): Promise<boolean>;
  /** Where the data lives and how big it is — the admin's Database card (yourphr#619). */
  abstract storage(): { location: string; sizeBytes: number };
  abstract close(): Promise<void>;
}
