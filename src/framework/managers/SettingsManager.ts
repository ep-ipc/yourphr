/**
 * Settings (yourphr#618): the one door to what this instance says about itself — the public
 * instance keys an anonymous caller may read, the signed-in member's view, and the operator's
 * configuration and instance cards. The doc's `SettingsManager` (Q8), over the `configuration`
 * manager: it holds no state of its own, so backup() is empty and the configuration manager's
 * overlay is the thing that travels.
 *
 * Why a manager and not closures in the composition root: the caller is passed in. Until #618 the
 * admin card took no context at all — the route gate decided who was an admin and the log said
 * "admin revealed configuration value" without a name. Every method here takes `ctx`, the admin
 * methods re-check `requireAdmin()` themselves (the route's gate is the outer wall, not the only
 * one), and reveal / set / reset are logged by `ctx.actor`. Policy lives here too — unknown key
 * 400, env-pinned 409, coercion to the shipped type, the contact-address shape checks — as
 * ApiError, so the one error boundary renders it and a harness reads the same message.
 */
import { BaseManager, type BackupData } from '../BaseManager.js';
import type { Engine } from '../Engine.js';
import { ApiError, type ApiContext } from '../ApiContext.js';
import { envNameFor, type ConfigValue } from '../../config/index.js';

declare module '../Engine.js' {
  interface ManagerRegistry {
    settings: SettingsManager;
  }
}

/** Go's AdminConfigResponse row (yourphr#602). */
export interface ConfigEntry {
  key: string;
  value: ConfigValue | '••••';
  masked: boolean;
  source: 'custom' | 'default';
  public: boolean;
  promoted: boolean;
  default: ConfigValue | '••••';
  from_env: boolean;
  env_var: string;
  description: string;
  bootstrap: boolean;
}

export interface InstanceSettings {
  name: string;
  contact_email: string;
  contact_url: string;
}

export interface SettingsOptions {
  /** Where the admin's deliberate acts are recorded (reveal, set, reset). */
  log?: (line: string) => void;
}

/** The keys /api/instance/public publishes — Go's `public` list, as far as this stack has values. */
const PUBLIC_KEYS = new Set(['operator.name', 'operator.contact_url', 'auth.password.min-length']);

export class SettingsManager extends BaseManager {
  readonly name = 'settings';
  override readonly dependsOn = ['configuration'] as const;
  private readonly log: (line: string) => void;

  constructor(engine: Engine, options: SettingsOptions = {}) {
    super(engine);
    this.log = options.log ?? (() => undefined);
  }

  private get configuration() {
    return this.engine.managers.configuration;
  }

  /**
   * Only what an anonymous caller may know. The instance keys Go publishes that this stack has a
   * value for; a key this stack does not have (theme, demo, signup, the wider password policy) is
   * ABSENT, and the Angular app's mapper already defaults an absent key — nothing is invented to
   * fill Go's list. The password minimum is published so the UI can say it before the server
   * refuses (yourphr#506's shape).
   */
  publicInstance(_ctx: ApiContext): Record<string, unknown> {
    const config = this.configuration;
    return {
      'operator.name': config.getString('operator.name'),
      'operator.contact_url': config.getString('operator.contact_url'),
      'password.min_length': config.getInt('auth.password.min-length'),
    };
  }

  /** What a signed-in member may know (yourphr#593): public plus the operator contact (yourphr#459). */
  instanceForUser(ctx: ApiContext): Record<string, unknown> {
    ctx.requireAuthenticated();
    return {
      ...this.publicInstance(ctx),
      'operator.contact_email': this.configuration.getString('operator.contact_email'),
      'demo.admin.session': false, // this stack has no demo admin; the UI reads strictly true
    };
  }

  /** GET /admin/config in Go's AdminConfigResponse shape (yourphr#602). */
  configSnapshot(ctx: ApiContext): { entries: ConfigEntry[]; custom_config_path: string; warnings: string[] } {
    ctx.requireAdmin();
    const config = this.configuration;
    return {
      entries: config.snapshot().map((row) => {
        const spec = config.specOf(row.key)!;
        return {
          key: row.key,
          value: row.value,
          masked: row.value === '••••',
          source: row.source === 'custom' ? 'custom' : 'default',
          public: PUBLIC_KEYS.has(row.key),
          promoted: false,
          default: spec.secret && String(spec.default) !== '' ? '••••' : spec.default,
          from_env: row.source === 'environment',
          env_var: envNameFor(row.key),
          description: row.description,
          bootstrap: spec.bootstrap === true,
        };
      }),
      custom_config_path: config.customConfigPath(),
      warnings: [],
    };
  }

  /** The raw value — a logged, deliberate act, recorded by who asked. Undefined for an unknown key. */
  configReveal(ctx: ApiContext, key: string): { key: string; value: ConfigValue; default: ConfigValue } | undefined {
    ctx.requireAdmin();
    const spec = this.configuration.specOf(key);
    if (!spec) return undefined;
    this.log(`${ctx.actor} revealed configuration value for ${key}`);
    return { key, value: this.configuration.reveal(key), default: spec.default };
  }

  /** ApiError 400 unknown key / invalid value, 409 env-pinned. */
  configSet(ctx: ApiContext, key: string, value: unknown): void {
    ctx.requireAdmin();
    const config = this.configuration;
    const spec = config.specOf(key);
    if (!spec) throw new ApiError(400, `unknown configuration key ${JSON.stringify(key)} — only keys this stack describes can be set`);
    if (config.isSetByEnvironment(key)) {
      throw new ApiError(409, `${key} is set by the environment variable ${envNameFor(key)}, which takes precedence over this screen — change it in your deployment configuration instead`);
    }
    let coerced: ConfigValue;
    try {
      coerced = coerceToShippedType(value, spec.default);
    } catch (err) {
      throw new ApiError(400, `${key}: ${(err as Error).message}`);
    }
    try {
      config.set(key, coerced);
    } catch (err) {
      throw new ApiError(400, (err as Error).message);
    }
    this.log(`${ctx.actor} set configuration ${key}`);
  }

  /** Removes an override; false when there was none. ApiError 400 for an unknown key. */
  configReset(ctx: ApiContext, key: string): boolean {
    ctx.requireAdmin();
    if (!this.configuration.specOf(key)) throw new ApiError(400, `unknown configuration key ${JSON.stringify(key)}`);
    let cleared: boolean;
    try {
      cleared = this.configuration.clear(key);
    } catch (err) {
      throw new ApiError(400, (err as Error).message);
    }
    if (cleared) this.log(`${ctx.actor} reset configuration ${key} to its default`);
    return cleared;
  }

  instanceSettings(ctx: ApiContext): InstanceSettings {
    ctx.requireAdmin();
    const config = this.configuration;
    return {
      name: config.getString('operator.name'),
      contact_email: config.getString('operator.contact_email'),
      contact_url: config.getString('operator.contact_url'),
    };
  }

  /** ApiError 400 when an address is the wrong shape; the values are stored trimmed. */
  setInstanceSettings(ctx: ApiContext, s: InstanceSettings): InstanceSettings {
    ctx.requireAdmin();
    const settings: InstanceSettings = { name: s.name.trim(), contact_email: s.contact_email.trim(), contact_url: s.contact_url.trim() };
    if (settings.contact_email !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(settings.contact_email)) {
      throw new ApiError(400, 'contact_email is not an email address');
    }
    if (settings.contact_url !== '' && !/^https?:\/\//.test(settings.contact_url)) {
      throw new ApiError(400, 'contact_url must start with http:// or https://');
    }
    const config = this.configuration;
    config.set('operator.name', settings.name);
    config.set('operator.contact_email', settings.contact_email);
    config.set('operator.contact_url', settings.contact_url);
    this.log(`${ctx.actor} set the instance settings`);
    return settings;
  }

  /** Nothing of its own: the configuration manager's overlay is what travels. */
  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString() };
  }

  async restore(): Promise<void> { /* the configuration manager restores the overlay */ }
}

/** Go's coerceToShippedType: the stored value keeps the type of the shipped default. */
export function coerceToShippedType(value: unknown, shipped: ConfigValue): ConfigValue {
  if (typeof shipped === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    throw new Error('expected true or false');
  }
  if (typeof shipped === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'boolean' || value === '' || !Number.isFinite(n)) throw new Error('expected a number');
    return n;
  }
  if (Array.isArray(shipped)) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
    throw new Error('expected a list');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('expected text');
}
