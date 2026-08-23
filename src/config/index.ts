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
   *
   * NOTE (yourphr#622): this flag is currently doing two jobs, and they should be separated.
   * Of the eight keys carrying it, most are not secrets at all (`yourphr.web.listen.port`, `yourphr.web.listen.host`,
   * `yourphr.web.static-dir`) — they are marked bootstrap because changing them from a settings screen
   * would not take effect until a restart, which is what `restartRequired` should say
   * (yourphr#624). The remaining two are secrets, which environment references now express
   * directly: a value of `$YOURPHR_DATABASE_ENCRYPTION_KEY` names its variable in the file an
   * operator reads, and masks itself. Once yourphr#624 lands, this flag can retire in favour of
   * the two concepts it fused. It is kept for now because removing it today would let an admin
   * screen change a listen port that silently does not apply.
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
  'yourphr.storage.data-dir': { bootstrap: true, description: 'Directory holding everything this instance owns. Bootstrap: must exist before any setting screen can.' },
  'yourphr.database.location': { bootstrap: true, description: 'SQLite database file path. Bootstrap.' },
  'yourphr.database.encryption.key': { bootstrap: true, secret: true, description: 'At-rest cipher key. Bootstrap and secret: env only, never the overlay.' },
  'yourphr.web.listen.port': { bootstrap: true, description: 'TCP port the process listens on. Bootstrap.' },
  'yourphr.web.listen.host': { bootstrap: true, description: 'Address the process binds. Bootstrap.' },
  'yourphr.web.secure-cookies': { bootstrap: true, description: 'Mark the session cookie Secure. Off behind a TLS-terminating proxy that reaches this process over plain HTTP. Bootstrap.' },
  'yourphr.web.static-dir': { bootstrap: true, description: 'Directory holding the built Angular app (index.html at its root). Empty = API only. Bootstrap.' },
  'yourphr.sync.interval-seconds': { description: 'How often the background worker refreshes tokens and syncs connected sources. 0 disables the worker.' },
  'yourphr.auth.session.sliding-seconds': { description: 'A session use inside this window is valid and renews the window.' },
  'yourphr.auth.session.absolute-seconds': { description: 'No session outlives issue time plus this, however active.' },
  'yourphr.auth.throttle.max-failures': { description: 'Sign-in failures per account/IP window before refusal.' },
  'yourphr.auth.throttle.window-seconds': { description: 'The throttle window.' },
  'yourphr.auth.password.min-length': { description: 'Server-enforced password minimum (yourphr#506).' },
  'yourphr.auth.trusted-proxies': { description: 'Direct peers whose X-Forwarded-For is believed (yourphr#529). Empty = believe nobody.' },
  'yourphr.auth.providers': { description: 'The authentication providers available (any-of alternatives). Only password exists today (yourphr#611).' },
  // Authorization as data (yourphr#623). The names are the enforcement contract — a role may only
  // grant a permission this build defines, checked at boot — but WHICH role holds WHICH permission
  // is the operator's, so a caregiver or a read-only demo operator is an edit, not a release.
  'yourphr.auth.permissions.definitions': { description: 'Every permission this build enforces, as {target}-{action}, with what it governs in the operator\'s words. Not the operator\'s to extend: a name nothing enforces would be a grant that silently means nothing.' },
  'yourphr.auth.roles.definitions': { description: 'What each role may do. Deep-merged per role, so adding one in app-custom-config.json does not restate the others; a role\'s permission list is replaced wholesale on override. An unknown permission name refuses the boot.' },
  'yourphr.auth.factors': { description: 'The factors EVERY sign-in must pass (all-of; password AND totp, never try-each). A factor with no provider refuses to boot.' },
  'yourphr.audit.provider': { description: "Where the patient-visible access log is kept. REQUIRED (yourphr#614): there is no inert default — an unknown or unhealthy provider refuses to boot rather than run with auditing off." },
  'yourphr.sources.client.provider': { description: "How connected sources are reached: 'smart' (SMART on FHIR over the guarded HTTP client) or 'null' (an instance that never syncs — nothing fetched, every sync says why). Optional capability (yourphr#612)." },
  'yourphr.sync.max-pages': { description: 'Refused past this rather than paging forever on a provider that always returns a next link.' },
  'yourphr.backup.storage.provider': { description: "Where backup artifacts live: 'filesystem' (a local folder — the data directory, a NAS mount) or 'null' (no backup storage: the instance serves, every backup action refuses with a reason). Optional capability (yourphr#615)." },
  'yourphr.backup.destination': { description: 'Folder scheduled and manual backups are written to. Empty = <data dir>/backups.' },
  'yourphr.backup.max-backups': { description: 'Retention: newest N backups are kept; 0 disables pruning.' },
  'yourphr.backup.schedule.enabled': { description: 'Run scheduled backups from this process (yourphr#602).' },
  'yourphr.backup.schedule.time': { description: 'When the scheduled backup runs, HH:MM, server-local time.' },
  'yourphr.backup.schedule.days': { description: "'daily' or 'weekly' (weekly = Sundays)." },
  'yourphr.operator.name': { description: 'Who runs this instance — shown on the contact, privacy and help pages (yourphr#593). Public.' },
  'yourphr.operator.contact-email': { description: 'How a signed-in member reaches the operator. Withheld from anonymous callers (yourphr#459).' },
  'yourphr.operator.contact-url': { description: 'A contact page or form for this instance. Public.' },
  'yourphr.backup.encryption.key': { bootstrap: true, secret: true, description: 'Backups are ALWAYS encrypted under this key — its own secret, not the database key, because the copy that travels and the copy that stays should not fall together. Bootstrap: env only.' },
};

/**
 * `yourphr.auth.session.sliding-seconds` -> `YOURPHR_AUTH_SESSION_SLIDING_SECONDS`. The key carries
 * its own `yourphr.` prefix (yourphr#627), so the environment name derives from the key alone
 * rather than gluing a second prefix in front of it.
 *
 * NOT injective on its own: both `.` and `-` collapse to `_`, so `a.b-c` and `a-b.c` produce the
 * same name. The catalogue is checked for collisions by the framework harness rather than trusted.
 */
export function envNameFor(key: string): string {
  return key.toUpperCase().replace(/[.-]/g, '_');
}

/**
 * The name this key had before yourphr#627, for instances still setting it. The deployed manifests
 * carry `SPIKE_*` — including two SOPS-encrypted secrets whose variable names are inside the
 * encrypted payload — so a hard rename would crash-loop a running pod on a key it cannot read.
 * Read the new name first, accept the old one with a warning, and drop this at the cut-over
 * (yourphr#588) once the manifests are updated.
 */
export function legacyEnvNameFor(key: string): string | undefined {
  const withoutPrefix = key.startsWith('yourphr.') ? key.slice('yourphr.'.length) : undefined;
  return withoutPrefix === undefined ? undefined : 'SPIKE_' + withoutPrefix.toUpperCase().replace(/[.-]/g, '_');
}
