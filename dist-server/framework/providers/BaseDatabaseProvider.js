/**
 * The application database (yourphr#617): the one connection the app-level providers share —
 * accounts, sessions' users, sources, jobs, catalog, audit, favourites. The provider opens it under
 * its key, runs the schema ledger, answers for its integrity and closes it; the composition root
 * hands the handle to sibling providers and nobody else.
 */
export class BaseDatabaseProvider {
}
//# sourceMappingURL=BaseDatabaseProvider.js.map