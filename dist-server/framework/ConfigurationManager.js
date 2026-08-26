/**
 * Configuration as a manager (yourphr#608, #609; reshaped by yourphr#621) — first in every boot
 * order, because everything else reads it.
 *
 * This manager owns the POLICY: the three layers and their precedence, the merge, the catalogue of
 * what each key means, and the refusals (unknown key, bootstrap key, env-pinned key). A
 * `BaseConfigProvider` behind it owns only the STORAGE — fetch the two layers, persist the
 * overrides. That split is deliberate: a provider that could implement its own precedence is a
 * provider that could get it wrong, and "which layer wins" must not vary by where the bytes live.
 *
 * THE BOOTSTRAP EXCEPTION, stated rather than assumed: every other capability in this stack is
 * selected BY configuration (`yourphr.audit.provider`, `yourphr.backup.storage.provider`). This one cannot be —
 * it is what reads configuration. Its provider is chosen by the composition root, from the same
 * place the data directory and the database key already come from. Ratified 2026-08-23.
 *
 * backup() carries the overrides (what the operator changed), never the environment — secrets and
 * bootstrap values are the deployment's, not the backup's.
 */
import { BaseManager } from './BaseManager.js';
import { envNameFor, legacyEnvNameFor, isConfigObject, PUBLIC_KEYS_KEY } from '../config/index.js';
import { coerceToTypeOf, describePropertySource, ENV_KEYS_CONFIG_KEY, FALLBACK_ENV_KEYS, SECRET_KEYS_CONFIG_KEY } from '../config/env-keys.js';
export class ConfigurationManager extends BaseManager {
    provider;
    name = 'configuration';
    env;
    log;
    /** The shipped values, this instance's overrides, and the two merged — ngdpbase's three views. */
    defaults = {};
    custom = {};
    merged = {};
    customUnreadable;
    roots = {};
    constructor(engine, provider, options = {}) {
        super(engine);
        this.provider = provider;
        this.env = options.env ?? process.env;
        this.log = options.log ?? (() => undefined);
        this.reload();
    }
    /**
     * Read both layers and merge. Called from the constructor because the composition root needs
     * configuration before the engine initialises anything — the bootstrap exception in practice.
     */
    reload() {
        const loaded = this.provider.load();
        this.defaults = loaded.defaults;
        this.custom = loaded.custom;
        this.customUnreadable = loaded.customUnreadable;
        this.merged = deepMerge(this.defaults, this.custom);
        // A real environment variable always wins; the provider's roots are the floor, so a template
        // resolves against the root actually in use even when nothing in the environment names it.
        this.roots = { ...this.provider.roots() };
    }
    /** Every key this build understands: the shipped file IS the list (yourphr#629). */
    known(key) {
        return key in this.defaults;
    }
    /** Keys masked on the admin screen until revealed — Go's deny-list, read as data. */
    secretKeys() {
        const raw = this.merged[SECRET_KEYS_CONFIG_KEY];
        return Array.isArray(raw) ? raw.map(String) : [];
    }
    async initialize(config = {}) {
        await super.initialize(config);
        const overridden = Object.keys(this.custom).length;
        this.log(`configuration: ${Object.keys(this.defaults).length} keys from the '${this.provider.name}' provider${overridden ? `, ${overridden} overridden by this instance` : ''}`);
        if (this.customUnreadable)
            this.log(`configuration: overrides could not be read and are being ignored, not overwritten — ${this.customUnreadable}`);
        // Resolve every key once at boot so a missing REQUIRED secret refuses here, naming itself,
        // rather than at the first request that happens to read it (yourphr#622).
        for (const key of Object.keys(this.defaults))
            this.raw(key);
        if (this.envRefHits || this.envRefBraceMisses) {
            this.log(`configuration: ${this.envRefHits} environment reference(s) resolved` +
                (this.envRefBraceMisses ? `, ${this.envRefBraceMisses} left unresolved (embedded form — they fail at point of use)` : ''));
        }
    }
    // --- reading ---------------------------------------------------------------------------------
    raw(key) {
        return this.resolveEnvRef(this.configured(key), key);
    }
    /** The value the layers select, BEFORE environment references are resolved. */
    configured(key) {
        if (!this.known(key))
            throw new Error(`unknown configuration key: ${key}`);
        const shipped = this.defaults[key] ?? null;
        // A DECLARED env-owned key reads from its variable (yourphr#635). An empty value is an
        // operator clearing the variable, not blanking the setting — handled in describePropertySource.
        const envVar = this.envKeyMap()[key];
        if (envVar !== undefined) {
            // The declared variable first, then the pre-yourphr#627 SPIKE_ name. That fallback lived
            // only on the branch below until this line existed, and yourphr#635 moved the encryption
            // keys onto THIS branch — so a deployment still setting SPIKE_DATABASE_ENCRYPTION_KEY
            // opened an encrypted database with an empty key and died with SQLITE_NOTADB. Found by
            // deploying v0.2.0, not by any test: every test sets the new names.
            const raw = this.envValue(envVar) ?? this.legacyEnvValue(key);
            if (raw !== undefined && raw !== '')
                return coerceToTypeOf(raw, shipped);
            return shipped; // the shipped value is this key's boot fallback
        }
        const fromEnv = this.envValue(envNameFor(key)) ?? this.legacyEnvValue(key);
        if (fromEnv !== undefined)
            return coerceFromEnv(fromEnv, this.defaults[key], key);
        if (key in this.custom)
            return this.merged[key];
        return this.defaults[key];
    }
    /** Which keys the environment owns, and the variable supplying each (yourphr#635). */
    envKeyMap() {
        const raw = this.merged[ENV_KEYS_CONFIG_KEY];
        if (isConfigObject(raw))
            return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
        // Config declares none — fall back rather than silently dropping every override, including the
        // at-rest database key. See FALLBACK_ENV_KEYS.
        return FALLBACK_ENV_KEYS;
    }
    /** The declared map, for the admin screen. */
    envControlledKeys() { return { ...this.envKeyMap() }; }
    /**
     * Where a key's value actually comes from (yourphr#635). The admin screen needs three facts
     * `getString()` alone cannot express: the effective value, whether the environment owns the key,
     * and which variable does.
     */
    describeProperty(key) {
        const configValue = (this.merged[key] ?? null);
        const described = describePropertySource(key, this.envKeyMap(), this.env, configValue);
        if (described.source === 'config') {
            try {
                return { ...described, effective: this.resolveEnvRef(described.effective, key) };
            }
            catch {
                // A bare ref to an unset variable throws by design. The screen should show the value as
                // unresolvable, not fail to render.
                return { ...described, effective: null };
            }
        }
        return described;
    }
    /**
     * Environment references (yourphr#622), ngdpbase's `resolveEnvRef` (#775) carried with its three
     * forms and — the part that matters — its deliberately DIFFERENT strictness between them:
     *
     *   `$$literal`  escape, for a value that genuinely starts with `$`. Checked FIRST, or `$$VAR`
     *                reads as a malformed bare reference.
     *   `$VAR`       the WHOLE value is one variable. STRICT: an unset variable throws, naming both
     *                the variable and the key that wanted it. This is the form for secrets — an
     *                operator who wrote it meant it, and silently falling back to a shipped empty
     *                string is how an instance ends up serving with its cipher key missing.
     *   `${VAR}`     embedded, for path templates. SILENT on a miss: the placeholder is left intact
     *                and fails at point of use, where the message names the actual path.
     *
     * Resolved at LOOKUP time, not load time, so a test that changes the environment mid-run sees it.
     */
    resolveEnvRef(value, key) {
        if (typeof value !== 'string')
            return value;
        if (value.startsWith('$$'))
            return value.slice(1);
        const bare = /^\$([A-Z_][A-Z0-9_]*)$/.exec(value);
        if (bare) {
            const name = bare[1];
            const found = this.envValue(name);
            if (found !== undefined) {
                this.envRefHits++;
                return found;
            }
            this.envRefMisses++;
            throw new Error(`configuration: ${key} is set to the environment variable ${name}, which is unset — add ${name}=... to the deployment (a .env file, a Kubernetes Secret) and restart`);
        }
        if (value.includes('${')) {
            return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
                const found = this.envValue(name);
                if (found === undefined) {
                    this.envRefBraceMisses++;
                    return match; // left intact on purpose: it fails at point of use, where the path is visible
                }
                this.envRefHits++;
                return found;
            });
        }
        return value;
    }
    /** Counters for the boot summary — an instance says how many references resolved. */
    envRefHits = 0;
    envRefMisses = 0;
    envRefBraceMisses = 0;
    /** Is this key's configured value a whole-value environment reference — i.e. does it hold a secret? */
    isEnvReference(key) {
        const value = this.configured(key);
        return typeof value === 'string' && !value.startsWith('$$') && /^\$[A-Z_][A-Z0-9_]*$/.test(value);
    }
    /**
     * The value with secrets masked, for anything that prints configuration — boot banners, the
     * admin listing, a debug dump. Masking is STRUCTURAL: it follows from the value being an
     * environment reference, so a newly referenced secret is masked without anyone remembering to
     * flag it. The catalogue's `secret` marker still covers values secret without being referenced.
     */
    maskedValue(key) {
        if (this.isEnvReference(key))
            return '••••';
        const value = this.raw(key);
        // Go's deny-list, read as data rather than compiled (yourphr#629): masking a value an admin
        // could otherwise read on their own screen. Deliberately short — masking everything outside
        // `public` trains an operator to click reveal without reading.
        return this.secretKeys().includes(key) && String(value) !== '' ? '••••' : value;
    }
    getString(key) { return String(this.raw(key)); }
    getInt(key) { return Number(this.raw(key)); }
    getBool(key) { return this.raw(key) === true; }
    getStringList(key) {
        const value = this.raw(key);
        if (Array.isArray(value))
            return value.map(String);
        return String(value).split(',').map((v) => v.trim()).filter(Boolean);
    }
    /** A structured setting, merged per entry. */
    getObject(key) {
        const value = this.raw(key);
        if (!isConfigObject(value))
            throw new Error(`configuration key ${key} is not a structured setting`);
        return value;
    }
    /** The raw value of a secret — a logged, deliberate act; the caller names who asked. */
    reveal(key) { return this.raw(key); }
    /**
     * The SHIPPED value, ignoring this instance's overrides — ngdpbase's `getDefaultProperty()`,
     * which exists because an instance whose overrides carried a whole-catalogue snapshot shadowed
     * every entry shipped afterwards (its #895). Needed rarely; when it is needed, nothing else does.
     */
    shippedValue(key) { return this.defaults[key]; }
    /** Only what this instance changed — the admin screen's "customised" view. */
    customValues() { return { ...this.custom }; }
    isSetByEnvironment(key) {
        return this.envValue(envNameFor(key)) !== undefined || this.legacyEnvValue(key) !== undefined;
    }
    /** A pre-yourphr#627 `SPIKE_*` variable, warned about once so an operator knows to move it. */
    /** The environment as this manager sees it: the real one, over the provider's roots. */
    envValue(name) {
        return this.env[name] ?? this.roots[name];
    }
    legacyEnvValue(key) {
        const legacy = legacyEnvNameFor(key);
        if (legacy === undefined)
            return undefined;
        const value = this.env[legacy];
        if (value !== undefined && !this.warnedLegacy.has(legacy)) {
            this.warnedLegacy.add(legacy);
            this.log(`configuration: ${legacy} is the old name for ${envNameFor(key)} and still works — update the deployment before the cut-over (yourphr#588)`);
        }
        return value;
    }
    warnedLegacy = new Set();
    customConfigPath() { return this.provider.customLocation(); }
    /**
     * Override keys this build does not define — reported, never silently dropped (yourphr#473).
     * The shipped file is the list, so no second structure is needed to detect one.
     */
    unknownKeys() {
        if (this.customUnreadable)
            return [`<unreadable: ${this.provider.customLocation()}>`];
        return Object.keys(this.custom).filter((k) => !this.known(k));
    }
    /** Every key this build defines, for the admin screen and the drift checks. */
    keys() { return Object.keys(this.defaults); }
    /** The SHIPPED allow-list, so the admin screen can say which entries this instance added. */
    shippedPublicKeys() {
        const raw = this.defaults[PUBLIC_KEYS_KEY];
        return Array.isArray(raw) ? raw.map(String) : [];
    }
    /** Is this key masked on the admin screen? Go's `secret` deny-list. */
    isSecret(key) { return this.secretKeys().includes(key); }
    /** The admin view: every known key, its effective value (secrets masked), and its source. */
    snapshot() {
        return Object.keys(this.defaults).map((key) => {
            const source = this.isSetByEnvironment(key) ? 'environment' : key in this.custom ? 'custom' : 'default';
            return { key, value: this.maskedValue(key), source };
        });
    }
    // --- writing ---------------------------------------------------------------------------------
    set(key, value) {
        if (!this.known(key))
            throw new Error(`unknown configuration key: ${key}`);
        // Declared ownership, NOT "is the variable set right now" (yourphr#635): an env-owned key is
        // read-only either way, or the same key is editable on one instance and refused on another.
        const owner = this.envKeyMap()[key];
        if (owner !== undefined)
            throw new Error(`${key} is owned by the environment variable ${owner} — set it there and restart; this screen cannot change it`);
        if (this.isSetByEnvironment(key))
            throw new Error(`${key} is set in the environment (${envNameFor(key)}); remove the variable to manage it here`);
        if (this.customUnreadable)
            throw new Error(`${this.provider.customLocation()} exists but cannot be parsed — refusing to overwrite it`);
        // Writing a literal over an environment reference would move a secret out of the deployment
        // and into a file on disk — silently, and from a screen that was only showing '••••'.
        if (this.isEnvReference(key) && !(typeof value === 'string' && value.startsWith('$'))) {
            throw new Error(`${key} is set to an environment variable; writing a literal here would copy a secret out of the deployment and into ${this.provider.customLocation()}`);
        }
        this.custom[key] = value;
        this.merged = deepMerge(this.defaults, this.custom);
        this.provider.saveCustom(this.custom);
    }
    /** Removes an override so the key reads its shipped value again. False when there was none. */
    clear(key) {
        if (!this.known(key))
            throw new Error(`unknown configuration key: ${key}`);
        if (this.customUnreadable)
            throw new Error(`${this.provider.customLocation()} exists but cannot be parsed — refusing to overwrite it`);
        if (!(key in this.custom))
            return false;
        delete this.custom[key];
        this.merged = deepMerge(this.defaults, this.custom);
        this.provider.saveCustom(this.custom);
        return true;
    }
    /** Every override dropped; the instance follows the product again. */
    resetToDefaults() {
        this.custom = {};
        this.merged = { ...this.defaults };
        this.provider.saveCustom(this.custom);
    }
    async backup() {
        return { manager: this.name, takenAt: new Date().toISOString(), payload: this.customValues() };
    }
    async restore(data) {
        for (const [key, value] of Object.entries((data.payload ?? {}))) {
            if (this.known(key))
                this.custom[key] = value;
        }
        this.merged = deepMerge(this.defaults, this.custom);
        this.provider.saveCustom(this.custom);
    }
}
/** SPIKE_X=... is text; the shipped value's type says what it must become. */
function coerceFromEnv(fromEnv, shipped, key) {
    if (typeof shipped === 'number')
        return Number(fromEnv);
    if (typeof shipped === 'boolean')
        return fromEnv === 'true' || fromEnv === '1';
    if (Array.isArray(shipped))
        return fromEnv.split(',').map((s) => s.trim()).filter(Boolean);
    if (isConfigObject(shipped)) {
        // Unparseable is an ERROR, not a silent fall back: an operator who set the variable meant it
        // to apply, and configuration that quietly reverts is the failure this area exists to prevent.
        try {
            const parsed = JSON.parse(fromEnv);
            if (!isConfigObject(parsed))
                throw new Error('expected a JSON object');
            return parsed;
        }
        catch (err) {
            throw new Error(`${envNameFor(key)} must be a JSON object: ${err.message}`);
        }
    }
    return fromEnv;
}
/**
 * ngdpbase's merge (`ConfigurationManager.ts:488`), carried as-is: objects merge per key, arrays of
 * `{id, …}` merge BY ID (an override replaces the matching entry and adds new ones), and any other
 * array is replaced wholesale. Per-entry merging is what stops one overridden entry from freezing
 * the rest of a structured setting against everything shipped later.
 */
export function deepMerge(defaults, custom) {
    const result = { ...defaults };
    for (const [key, customValue] of Object.entries(custom)) {
        const defaultValue = result[key];
        if (customValue === undefined)
            continue;
        if (Array.isArray(customValue) && Array.isArray(defaultValue))
            result[key] = mergeArrays(defaultValue, customValue);
        else if (isConfigObject(customValue) && isConfigObject(defaultValue))
            result[key] = deepMerge(defaultValue, customValue);
        else
            result[key] = customValue;
    }
    return result;
}
function mergeArrays(defaults, custom) {
    const hasIds = (a) => a.length > 0 && isConfigObject(a[0]) && 'id' in a[0];
    if (hasIds(defaults) && hasIds(custom)) {
        const merged = new Map();
        for (const item of [...defaults, ...custom])
            merged.set(item['id'], item);
        return Array.from(merged.values());
    }
    return custom;
}
//# sourceMappingURL=ConfigurationManager.js.map