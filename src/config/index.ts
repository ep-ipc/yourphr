/**
 * The configuration system — Phase 4 opens here (yourphr#542), because everything else in the long
 * tail reads configuration. The shape is the one the Go stack and ngdpbase both converged on
 * (yourphr#472, ngdpbase#1042-era config), each decision carried with its reason:
 *
 *   - ONE store, three layers, strict precedence: environment > custom overlay > defaults.
 *     Environment carries BOOTSTRAP AND SECRETS ONLY — things that must exist before any admin
 *     could open a settings screen. Everything else is a setting, edited at runtime, persisted to
 *     the overlay.
 *   - The overlay file holds only what the operator changed — never the merged view. Writing the
 *     merged view would freeze today's defaults into the instance forever, so a later release that
 *     changed a default would silently not apply.
 *   - A key pinned by the environment is READ-ONLY to set(): env wins at read time, so accepting
 *     the write would store a value that never applies. Refusing is the honest answer (the Go
 *     config screen returns 409 for the same reason).
 *   - Writes apply to the running process immediately — a saved setting that needs a restart is a
 *     setting that lies until one happens.
 *   - Unknown keys in the overlay are REPORTED, not silently carried or silently dropped
 *     (yourphr#473): a typo'd key that vanishes teaches the operator the setting "does not work".
 *   - Secret-flagged keys never leave snapshot() unmasked (yourphr#286's json:"-" made the same
 *     promise in Go).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ConfigValue = string | number | boolean | string[];

export interface ConfigKeySpec {
  default: ConfigValue;
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
export const DefaultConfigSpec: Record<string, ConfigKeySpec> = {
  'storage.data_dir': { default: '', bootstrap: true, description: 'Directory holding everything this instance owns. Bootstrap: must exist before any setting screen can.' },
  'database.location': { default: 'spike.db', bootstrap: true, description: 'SQLite database file path. Bootstrap.' },
  'database.encryption.key': { default: '', bootstrap: true, secret: true, description: 'At-rest cipher key. Bootstrap and secret: env only, never the overlay.' },
  'auth.session.sliding-seconds': { default: 3600, description: 'A session use inside this window is valid and renews the window.' },
  'auth.session.absolute-seconds': { default: 43200, description: 'No session outlives issue time plus this, however active.' },
  'auth.throttle.max-failures': { default: 5, description: 'Sign-in failures per account/IP window before refusal.' },
  'auth.throttle.window-seconds': { default: 900, description: 'The throttle window.' },
  'auth.password.min-length': { default: 12, description: 'Server-enforced password minimum (yourphr#506).' },
  'auth.trusted-proxies': { default: [] as string[], description: 'Direct peers whose X-Forwarded-For is believed (yourphr#529). Empty = believe nobody.' },
  'sync.max-pages': { default: 500, description: 'Refused past this rather than paging forever on a provider that always returns a next link.' },
  'backup.destination': { default: '', description: 'Folder scheduled and manual backups are written to. Empty = <data dir>/backups.' },
  'backup.max-backups': { default: 7, description: 'Retention: newest N backups are kept; 0 disables pruning.' },
  'backup.encryption.key': { default: '', bootstrap: true, secret: true, description: 'Backups are ALWAYS encrypted under this key — its own secret, not the database key, because the copy that travels and the copy that stays should not fall together. Bootstrap: env only.' },
};

const ENV_PREFIX = 'SPIKE_';

/** SPIKE_AUTH_SESSION_SLIDING_SECONDS for auth.session.sliding-seconds — the Go convention. */
export function envNameFor(key: string): string {
  return ENV_PREFIX + key.toUpperCase().replace(/[.-]/g, '_');
}

export class ConfigStore {
  private overlay: Record<string, unknown> = {};
  private readonly overlayPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly spec: Record<string, ConfigKeySpec> = DefaultConfigSpec,
    private readonly env: Record<string, string | undefined> = process.env
  ) {
    this.overlayPath = join(dataDir, 'config', 'app-custom-config.json');
    if (existsSync(this.overlayPath)) {
      // A file we cannot parse is left alone and reported by unknownKeys() as unreadable rather
      // than clobbered on the next save — it may hold settings the operator wants back.
      try {
        this.overlay = JSON.parse(readFileSync(this.overlayPath, 'utf8')) as Record<string, unknown>;
      } catch {
        this.overlayBroken = true;
      }
    }
  }

  private overlayBroken = false;

  isSetByEnvironment(key: string): boolean {
    return this.env[envNameFor(key)] !== undefined;
  }

  private raw(key: string): ConfigValue {
    const spec = this.spec[key];
    if (!spec) {
      throw new Error(`unknown configuration key: ${key}`);
    }
    const fromEnv = this.env[envNameFor(key)];
    if (fromEnv !== undefined) {
      if (typeof spec.default === 'number') return Number(fromEnv);
      if (typeof spec.default === 'boolean') return fromEnv === 'true' || fromEnv === '1';
      if (Array.isArray(spec.default)) return fromEnv.split(',').map((s) => s.trim()).filter(Boolean);
      return fromEnv;
    }
    if (key in this.overlay && !spec.bootstrap) {
      return this.overlay[key] as ConfigValue;
    }
    return spec.default;
  }

  getString(key: string): string { return String(this.raw(key)); }
  getInt(key: string): number { return Number(this.raw(key)); }
  getBool(key: string): boolean { return this.raw(key) === true; }
  getStringList(key: string): string[] {
    const v = this.raw(key);
    return Array.isArray(v) ? v : v === '' ? [] : [String(v)];
  }

  /**
   * Persist a setting into the overlay and apply it live. Refuses: unknown keys (a typo must fail
   * loudly, not vanish), env-pinned keys (env wins at read, so the write would lie), and bootstrap
   * keys (they must hold before any admin exists — environment only).
   */
  set(key: string, value: ConfigValue): void {
    const spec = this.spec[key];
    if (!spec) {
      throw new Error(`unknown configuration key: ${key}`);
    }
    if (spec.bootstrap) {
      throw new Error(`${key} is bootstrap configuration — set it in the environment (${envNameFor(key)}), not the settings store`);
    }
    if (this.isSetByEnvironment(key)) {
      throw new Error(`${key} is set in the environment (${envNameFor(key)}); remove the variable to manage it here`);
    }
    if (this.overlayBroken) {
      throw new Error(`${this.overlayPath} exists but cannot be parsed — refusing to overwrite it`);
    }
    this.overlay[key] = value;
    mkdirSync(dirname(this.overlayPath), { recursive: true });
    writeFileSync(this.overlayPath, JSON.stringify(this.overlay, null, 2) + '\n', { mode: 0o600 });
  }

  /** Overlay keys the catalogue does not know — reported, never silently dropped (yourphr#473). */
  unknownKeys(): string[] {
    if (this.overlayBroken) {
      return [`<unreadable: ${this.overlayPath}>`];
    }
    return Object.keys(this.overlay).filter((k) => !(k in this.spec));
  }

  /** The admin-UI view: every known key, its effective value (secrets masked), and its source. */
  snapshot(): { key: string; value: ConfigValue | '••••'; source: 'environment' | 'custom' | 'default'; description: string }[] {
    return Object.entries(this.spec).map(([key, spec]) => {
      const source = this.isSetByEnvironment(key) ? 'environment' : key in this.overlay && !spec.bootstrap ? 'custom' : 'default';
      const value = spec.secret && String(this.raw(key)) !== '' ? ('••••' as const) : this.raw(key);
      return { key, value, source, description: spec.description };
    });
  }
}
