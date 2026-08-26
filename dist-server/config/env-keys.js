/** Config key holding the declared map of env-owned keys. */
export const ENV_KEYS_CONFIG_KEY = 'yourphr.config.env-keys';
/** Config key holding the keys masked on the admin screen until revealed. */
export const SECRET_KEYS_CONFIG_KEY = 'yourphr.config.secret-keys';
/**
 * Last-resort map used when the merged config declares none.
 *
 * Not a second source of truth in the harmful sense: it applies ONLY when `yourphr.config.env-keys`
 * is absent entirely, which is an abnormal state — the shipped default config always declares it.
 * It exists because the alternative failure mode is worse: without it, a partial or unreadable
 * default config makes every environment override silently stop working, including the at-rest
 * database key. An override that keeps working is a safer degradation than one that vanishes
 * without a word.
 *
 * Keep in step with `yourphr.config.env-keys` in `config/app-default-config.json`; a drift here
 * only shows up when the config cannot be read at all.
 */
export const FALLBACK_ENV_KEYS = {
    'yourphr.web.listen.port': 'YOURPHR_WEB_LISTEN_PORT',
    'yourphr.web.listen.host': 'YOURPHR_WEB_LISTEN_HOST',
    'yourphr.web.secure-cookies': 'YOURPHR_WEB_SECURE_COOKIES',
    'yourphr.web.static-dir': 'YOURPHR_WEB_STATIC_DIR',
    'yourphr.database.encryption.key': 'YOURPHR_DATABASE_ENCRYPTION_KEY',
    'yourphr.backup.encryption.key': 'YOURPHR_BACKUP_ENCRYPTION_KEY',
};
/**
 * Coerce an environment value to the type of the shipped default.
 *
 * Environment values are always strings, but the rest of the code expects the declared type —
 * `yourphr.web.listen.port` ships as `8080`, so `YOURPHR_WEB_LISTEN_PORT=9090` must not arrive as
 * `"9090"` and quietly fail a comparison somewhere downstream.
 *
 * Using the default's own type rather than a per-key table means there is one rule and nothing to
 * keep in sync as keys are added.
 *
 * When the value cannot be coerced — a non-numeric string against a numeric default — the raw
 * string is returned. Handing the caller something visibly wrong beats handing them a silent `NaN`.
 */
export function coerceToTypeOf(value, defaultValue) {
    if (typeof defaultValue === 'number') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
    }
    if (typeof defaultValue === 'boolean') {
        // Only an explicit "true" enables something. Treating "yes" or "1" as true is the sort of
        // guess that surprises an operator months later.
        return value === 'true';
    }
    if (Array.isArray(defaultValue))
        return value.split(',').map((v) => v.trim()).filter(Boolean);
    return value;
}
/**
 * Describe where a config key's value comes from.
 *
 * @param key the config key
 * @param envKeys the declared map, or null when unavailable
 * @param env environment to read, normally `process.env`. Injected so this stays pure and testable
 * @param configValue the merged config value, used both as the fallback and as the type to coerce
 *   an environment value to
 */
export function describePropertySource(key, envKeys, env, configValue) {
    const envVar = envKeys?.[key] ?? null;
    if (!envVar) {
        return { envControlled: false, envVar: null, effective: configValue, source: 'config' };
    }
    const raw = env[envVar];
    // An empty value is an operator CLEARING the variable, not setting it to the empty string —
    // `YOURPHR_WEB_LISTEN_PORT=` in a .env should not blank the port.
    if (raw === undefined || raw === '') {
        return { envControlled: true, envVar, effective: configValue, source: 'config' };
    }
    return { envControlled: true, envVar, effective: coerceToTypeOf(raw, configValue), source: 'env' };
}
//# sourceMappingURL=env-keys.js.map