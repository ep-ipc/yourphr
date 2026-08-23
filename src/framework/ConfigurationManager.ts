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
 * selected BY configuration (`audit.provider`, `backup.storage.provider`). This one cannot be —
 * it is what reads configuration. Its provider is chosen by the composition root, from the same
 * place the data directory and the database key already come from. Ratified 2026-08-23.
 *
 * backup() carries the overrides (what the operator changed), never the environment — secrets and
 * bootstrap values are the deployment's, not the backup's.
 */
import { BaseManager, type BackupData } from './BaseManager.js';
import type { Engine } from './Engine.js';
import type { BaseConfigProvider } from './providers/BaseConfigProvider.js';
import { ConfigCatalog, envNameFor, isConfigObject, type ConfigKeySpec, type ConfigObject, type ConfigValue } from '../config/index.js';

declare module './Engine.js' {
  interface ManagerRegistry {
    configuration: ConfigurationManager;
  }
}

/** One row of the admin view: the effective value (secrets masked) and which layer it came from. */
export interface ConfigRow {
  key: string;
  value: ConfigValue | '••••';
  source: 'environment' | 'custom' | 'default';
  description: string;
}

export interface ConfigurationOptions {
  /** The catalogue of what each key means. Injectable so a test can describe its own keys. */
  catalog?: Record<string, ConfigKeySpec>;
  /** The environment layer. Injectable so a test need not mutate the process. */
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export class ConfigurationManager extends BaseManager {
  readonly name = 'configuration' as const;

  private readonly catalog: Record<string, ConfigKeySpec>;
  private readonly env: Record<string, string | undefined>;
  private readonly log: (line: string) => void;

  /** The shipped values, this instance's overrides, and the two merged — ngdpbase's three views. */
  private defaults: Record<string, ConfigValue> = {};
  private custom: Record<string, ConfigValue> = {};
  private merged: Record<string, ConfigValue> = {};
  private customUnreadable: string | undefined;

  constructor(engine: Engine, private readonly provider: BaseConfigProvider, options: ConfigurationOptions = {}) {
    super(engine);
    this.catalog = options.catalog ?? ConfigCatalog;
    this.env = options.env ?? process.env;
    this.log = options.log ?? (() => undefined);
    this.reload();
  }

  /**
   * Read both layers and merge. Called from the constructor because the composition root needs
   * configuration before the engine initialises anything — the bootstrap exception in practice.
   */
  reload(): void {
    const loaded = this.provider.load();
    this.defaults = loaded.defaults;
    this.custom = loaded.custom;
    this.customUnreadable = loaded.customUnreadable;
    this.merged = deepMerge(this.defaults, this.custom);
    const described = Object.keys(this.catalog);
    // Two lists that must agree, and nothing else checks them: a shipped value nobody described is
    // unfindable in the admin UI, and a described key with no value reads as undefined at runtime.
    const undescribed = Object.keys(this.defaults).filter((k) => !described.includes(k));
    const valueless = described.filter((k) => !(k in this.defaults));
    if (undescribed.length || valueless.length) {
      throw new Error(
        'configuration: the shipped defaults and the catalogue disagree — ' +
        [undescribed.length ? `no description for ${undescribed.join(', ')}` : '', valueless.length ? `no shipped value for ${valueless.join(', ')}` : '']
          .filter(Boolean).join('; ')
      );
    }
  }

  override async initialize(config: Record<string, unknown> = {}): Promise<void> {
    await super.initialize(config);
    const overridden = Object.keys(this.custom).length;
    this.log(`configuration: ${Object.keys(this.defaults).length} keys from the '${this.provider.name}' provider${overridden ? `, ${overridden} overridden by this instance` : ''}`);
    if (this.customUnreadable) this.log(`configuration: overrides could not be read and are being ignored, not overwritten — ${this.customUnreadable}`);
  }

  // --- reading ---------------------------------------------------------------------------------

  private raw(key: string): ConfigValue {
    const spec = this.catalog[key];
    if (!spec) throw new Error(`unknown configuration key: ${key}`);
    const fromEnv = this.env[envNameFor(key)];
    if (fromEnv !== undefined) return coerceFromEnv(fromEnv, this.defaults[key], key);
    // A bootstrap key ignores the overrides by design: it must hold before an admin could set it.
    if (!spec.bootstrap && key in this.custom) return this.merged[key] as ConfigValue;
    return this.defaults[key] as ConfigValue;
  }

  getString(key: string): string { return String(this.raw(key)); }
  getInt(key: string): number { return Number(this.raw(key)); }
  getBool(key: string): boolean { return this.raw(key) === true; }
  getStringList(key: string): string[] {
    const value = this.raw(key);
    if (Array.isArray(value)) return value.map(String);
    return String(value).split(',').map((v) => v.trim()).filter(Boolean);
  }

  /** A structured setting, merged per entry. */
  getObject(key: string): ConfigObject {
    const value = this.raw(key);
    if (!isConfigObject(value)) throw new Error(`configuration key ${key} is not a structured setting`);
    return value;
  }

  /** The raw value of a secret — a logged, deliberate act; the caller names who asked. */
  reveal(key: string): ConfigValue { return this.raw(key); }

  /**
   * The SHIPPED value, ignoring this instance's overrides — ngdpbase's `getDefaultProperty()`,
   * which exists because an instance whose overrides carried a whole-catalogue snapshot shadowed
   * every entry shipped afterwards (its #895). Needed rarely; when it is needed, nothing else does.
   */
  shippedValue(key: string): ConfigValue | undefined { return this.defaults[key]; }

  /** Only what this instance changed — the admin screen's "customised" view. */
  customValues(): Record<string, ConfigValue> { return { ...this.custom }; }

  specOf(key: string): ConfigKeySpec | undefined { return this.catalog[key]; }
  isSetByEnvironment(key: string): boolean { return this.env[envNameFor(key)] !== undefined; }
  customConfigPath(): string { return this.provider.customLocation(); }

  /** Override keys the catalogue does not know — reported, never silently dropped (yourphr#473). */
  unknownKeys(): string[] {
    if (this.customUnreadable) return [`<unreadable: ${this.provider.customLocation()}>`];
    return Object.keys(this.custom).filter((k) => !(k in this.catalog));
  }

  /** The admin view: every known key, its effective value (secrets masked), and its source. */
  snapshot(): ConfigRow[] {
    return Object.entries(this.catalog).map(([key, spec]) => {
      const source = this.isSetByEnvironment(key) ? 'environment' : key in this.custom && !spec.bootstrap ? 'custom' : 'default';
      const raw = this.raw(key);
      return { key, value: spec.secret && String(raw) !== '' ? ('••••' as const) : raw, source, description: spec.description };
    });
  }

  // --- writing ---------------------------------------------------------------------------------

  set(key: string, value: ConfigValue): void {
    const spec = this.catalog[key];
    if (!spec) throw new Error(`unknown configuration key: ${key}`);
    if (spec.bootstrap) throw new Error(`${key} is bootstrap configuration — set it in the environment (${envNameFor(key)}), not the settings store`);
    if (this.isSetByEnvironment(key)) throw new Error(`${key} is set in the environment (${envNameFor(key)}); remove the variable to manage it here`);
    if (this.customUnreadable) throw new Error(`${this.provider.customLocation()} exists but cannot be parsed — refusing to overwrite it`);
    this.custom[key] = value;
    this.merged = deepMerge(this.defaults, this.custom);
    this.provider.saveCustom(this.custom);
  }

  /** Removes an override so the key reads its shipped value again. False when there was none. */
  clear(key: string): boolean {
    if (!this.catalog[key]) throw new Error(`unknown configuration key: ${key}`);
    if (this.customUnreadable) throw new Error(`${this.provider.customLocation()} exists but cannot be parsed — refusing to overwrite it`);
    if (!(key in this.custom)) return false;
    delete this.custom[key];
    this.merged = deepMerge(this.defaults, this.custom);
    this.provider.saveCustom(this.custom);
    return true;
  }

  /** Every override dropped; the instance follows the product again. */
  resetToDefaults(): void {
    this.custom = {};
    this.merged = { ...this.defaults };
    this.provider.saveCustom(this.custom);
  }

  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString(), payload: this.customValues() };
  }

  async restore(data: BackupData): Promise<void> {
    for (const [key, value] of Object.entries((data.payload ?? {}) as Record<string, ConfigValue>)) {
      if (this.catalog[key] && !this.catalog[key]!.bootstrap) this.custom[key] = value;
    }
    this.merged = deepMerge(this.defaults, this.custom);
    this.provider.saveCustom(this.custom);
  }
}

/** SPIKE_X=... is text; the shipped value's type says what it must become. */
function coerceFromEnv(fromEnv: string, shipped: ConfigValue | undefined, key: string): ConfigValue {
  if (typeof shipped === 'number') return Number(fromEnv);
  if (typeof shipped === 'boolean') return fromEnv === 'true' || fromEnv === '1';
  if (Array.isArray(shipped)) return fromEnv.split(',').map((s) => s.trim()).filter(Boolean);
  if (isConfigObject(shipped)) {
    // Unparseable is an ERROR, not a silent fall back: an operator who set the variable meant it
    // to apply, and configuration that quietly reverts is the failure this area exists to prevent.
    try {
      const parsed: unknown = JSON.parse(fromEnv);
      if (!isConfigObject(parsed)) throw new Error('expected a JSON object');
      return parsed;
    } catch (err) {
      throw new Error(`${envNameFor(key)} must be a JSON object: ${(err as Error).message}`);
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
export function deepMerge(defaults: Record<string, ConfigValue>, custom: Record<string, ConfigValue>): Record<string, ConfigValue> {
  const result: Record<string, ConfigValue> = { ...defaults };
  for (const [key, customValue] of Object.entries(custom)) {
    const defaultValue = result[key];
    if (customValue === undefined) continue;
    if (Array.isArray(customValue) && Array.isArray(defaultValue)) result[key] = mergeArrays(defaultValue, customValue);
    else if (isConfigObject(customValue) && isConfigObject(defaultValue)) result[key] = deepMerge(defaultValue, customValue) as ConfigObject;
    else result[key] = customValue;
  }
  return result;
}

function mergeArrays(defaults: ConfigValue[], custom: ConfigValue[]): ConfigValue[] {
  const hasIds = (a: ConfigValue[]): boolean => a.length > 0 && isConfigObject(a[0]) && 'id' in (a[0] as ConfigObject);
  if (hasIds(defaults) && hasIds(custom)) {
    const merged = new Map<unknown, ConfigValue>();
    for (const item of [...defaults, ...custom]) merged.set((item as ConfigObject)['id'], item);
    return Array.from(merged.values());
  }
  return custom;
}
