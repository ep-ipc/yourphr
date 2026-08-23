/**
 * The configuration TYPES and CATALOGUE (yourphr#542, reshaped by yourphr#621).
 *
 * What used to live here — a `ConfigStore` doing file I/O, merging and precedence all at once —
 * is now split the way every other resource in this stack is split: `ConfigurationManager` is the
 * door and owns the policy (merge order, precedence, the environment layer, this catalogue), and a
 * `BaseConfigProvider` behind it owns the storage. What remains in this file is the vocabulary
 * both sides share.
 *
 * The rules the catalogue exists to serve, each with its reason:
 *
 *   - Three layers, strict precedence: environment > instance overrides > shipped defaults.
 *     Environment carries BOOTSTRAP AND SECRETS ONLY — things that must hold before any admin
 *     could open a settings screen. Everything else is a setting, edited at runtime.
 *   - The overrides hold only what the operator changed — never the merged view. Writing the
 *     merged view would freeze today's defaults into the instance forever, so a later release that
 *     changed a default would silently not apply. ngdpbase shipped that bug (its #895) and had to
 *     add an escape hatch around its own merge.
 *   - A key pinned by the environment is READ-ONLY to set(): env wins at read time, so accepting
 *     the write would store a value that never applies. Refusing is the honest answer (the Go
 *     config screen returns 409 for the same reason).
 *   - Writes apply to the running process immediately — a saved setting that needs a restart is a
 *     setting that lies until one happens.
 *   - Unknown keys in the overrides are REPORTED, not silently carried or silently dropped
 *     (yourphr#473): a typo'd key that vanishes teaches the operator the setting "does not work".
 *   - Secret-flagged keys never leave snapshot() unmasked (yourphr#286's json:"-" made the same
 *     promise in Go).
 *
 * VALUES live in config/app-default-config.json; MEANING lives in the catalogue below. Meaning is
 * a property of the release, not of the instance, so an operator cannot edit it and an upgrade
 * updates it for free. ngdpbase keeps documentation in sibling `_comment_*` string keys instead,
 * which is honest but unreachable from code — nothing can render it or check that a key was
 * described at all.
 */
/**
 * A structured setting — a JSON object whose leaves are ordinary values. ngdpbase carries its
 * permission registry and role definitions this way (`ngdpbase.permissions.definitions`), and
 * deepMerge below merges one PER ENTRY rather than whole-value, so overriding one entry does not
 * freeze the rest against everything shipped afterwards.
 */
export type ConfigObject = { [key: string]: ConfigValue };

export type ConfigValue = string | number | boolean | ConfigValue[] | ConfigObject;

/** A plain object, not an array and not null — ngdpbase's `isPlainObject`. */
export function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a key MEANS. Deliberately not what it is worth: the value ships in
 * config/app-default-config.json, while meaning is a property of the release and stays in code so
 * an upgrade updates it and an operator cannot edit it (yourphr#621). ngdpbase has no equivalent —
 * it keeps `_comment_*` string keys, which nothing can render in an admin screen or check.
 */
export interface ConfigKeySpec {
  /** Never shown by snapshot(); still readable by code that holds the store. */
  secret?: boolean;
  /**
   * Bootstrap keys may ONLY come from defaults or environment — set() refuses them even when no
   * env var is present, because they must hold before any admin exists to have set them.
   */
  bootstrap?: boolean;
  description: string;
}

/**
 * The catalogue of every setting this stack understands — flat dotted keys, the single source the
 * unknown-key check measures against. Deliberately small; Phase 4 consumers add keys here as they
 * arrive, with a description, because an undescribed setting is unfindable in an admin UI.
 */
export const ConfigCatalog: Record<string, ConfigKeySpec> = {
  'storage.data_dir': { bootstrap: true, description: 'Directory holding everything this instance owns. Bootstrap: must exist before any setting screen can.' },
  'database.location': { bootstrap: true, description: 'SQLite database file path. Bootstrap.' },
  'database.encryption.key': { bootstrap: true, secret: true, description: 'At-rest cipher key. Bootstrap and secret: env only, never the overlay.' },
  'web.listen.port': { bootstrap: true, description: 'TCP port the process listens on. Bootstrap.' },
  'web.listen.host': { bootstrap: true, description: 'Address the process binds. Bootstrap.' },
  'web.secure-cookies': { bootstrap: true, description: 'Mark the session cookie Secure. Off behind a TLS-terminating proxy that reaches this process over plain HTTP. Bootstrap.' },
  'web.static-dir': { bootstrap: true, description: 'Directory holding the built Angular app (index.html at its root). Empty = API only. Bootstrap.' },
  'sync.interval-seconds': { description: 'How often the background worker refreshes tokens and syncs connected sources. 0 disables the worker.' },
  'auth.session.sliding-seconds': { description: 'A session use inside this window is valid and renews the window.' },
  'auth.session.absolute-seconds': { description: 'No session outlives issue time plus this, however active.' },
  'auth.throttle.max-failures': { description: 'Sign-in failures per account/IP window before refusal.' },
  'auth.throttle.window-seconds': { description: 'The throttle window.' },
  'auth.password.min-length': { description: 'Server-enforced password minimum (yourphr#506).' },
  'auth.trusted-proxies': { description: 'Direct peers whose X-Forwarded-For is believed (yourphr#529). Empty = believe nobody.' },
  'auth.providers': { description: 'The authentication providers available (any-of alternatives). Only password exists today (yourphr#611).' },
  'auth.factors': { description: 'The factors EVERY sign-in must pass (all-of; password AND totp, never try-each). A factor with no provider refuses to boot.' },
  'audit.provider': { description: "Where the patient-visible access log is kept. REQUIRED (yourphr#614): there is no inert default — an unknown or unhealthy provider refuses to boot rather than run with auditing off." },
  'sources.client.provider': { description: "How connected sources are reached: 'smart' (SMART on FHIR over the guarded HTTP client) or 'null' (an instance that never syncs — nothing fetched, every sync says why). Optional capability (yourphr#612)." },
  'sync.max-pages': { description: 'Refused past this rather than paging forever on a provider that always returns a next link.' },
  'backup.storage.provider': { description: "Where backup artifacts live: 'filesystem' (a local folder — the data directory, a NAS mount) or 'null' (no backup storage: the instance serves, every backup action refuses with a reason). Optional capability (yourphr#615)." },
  'backup.destination': { description: 'Folder scheduled and manual backups are written to. Empty = <data dir>/backups.' },
  'backup.max-backups': { description: 'Retention: newest N backups are kept; 0 disables pruning.' },
  'backup.schedule.enabled': { description: 'Run scheduled backups from this process (yourphr#602).' },
  'backup.schedule.time': { description: 'When the scheduled backup runs, HH:MM, server-local time.' },
  'backup.schedule.days': { description: "'daily' or 'weekly' (weekly = Sundays)." },
  'operator.name': { description: 'Who runs this instance — shown on the contact, privacy and help pages (yourphr#593). Public.' },
  'operator.contact_email': { description: 'How a signed-in member reaches the operator. Withheld from anonymous callers (yourphr#459).' },
  'operator.contact_url': { description: 'A contact page or form for this instance. Public.' },
  'backup.encryption.key': { bootstrap: true, secret: true, description: 'Backups are ALWAYS encrypted under this key — its own secret, not the database key, because the copy that travels and the copy that stays should not fall together. Bootstrap: env only.' },
};

const ENV_PREFIX = 'SPIKE_';

/** SPIKE_AUTH_SESSION_SLIDING_SECONDS for auth.session.sliding-seconds — the Go convention. */
export function envNameFor(key: string): string {
  return ENV_PREFIX + key.toUpperCase().replace(/[.-]/g, '_');
}
