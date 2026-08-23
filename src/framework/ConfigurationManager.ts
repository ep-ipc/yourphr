/**
 * Configuration as a manager (yourphr#608): ngdpbase's `ConfigurationManager`, first in every boot
 * order, over the spike's existing configuration store (defaults + instance overlay + environment
 * for bootstrap and secrets — the yourphr#472 split). The store stays the implementation; this is
 * the door the engine and the other managers reach it through.
 *
 * backup() carries the overlay (what the operator changed), never the environment — secrets and
 * bootstrap values are the deployment's, not the backup's.
 */
import { BaseManager, type BackupData } from './BaseManager.js';
import type { Engine } from './Engine.js';
import { ConfigStore, type ConfigKeySpec, type ConfigValue } from '../config/index.js';

/** One row of the admin view: the effective value (secrets masked) and where it came from. */
export type ConfigRow = ReturnType<ConfigStore['snapshot']>[number];

declare module './Engine.js' {
  interface ManagerRegistry {
    configuration: ConfigurationManager;
  }
}

export class ConfigurationManager extends BaseManager {
  readonly name = 'configuration' as const;

  constructor(engine: Engine, readonly store: ConfigStore) {
    super(engine);
  }

  getString(key: string): string { return this.store.getString(key); }
  getInt(key: string): number { return this.store.getInt(key); }
  getBool(key: string): boolean { return this.store.getBool(key); }
  getStringList(key: string): string[] { return this.store.getStringList(key); }
  set(key: string, value: ConfigValue): void { this.store.set(key, value); }

  // The rest of the door (yourphr#618): what the settings manager needs to show, reveal, set and
  // reset keys through its sibling rather than around it. Each is the store's call by the same name.
  specOf(key: string): ConfigKeySpec | undefined { return this.store.specOf(key); }
  snapshot(): ConfigRow[] { return this.store.snapshot(); }
  /** The raw value of a secret — a logged, deliberate act; the caller names who asked. */
  reveal(key: string): ConfigValue { return this.store.reveal(key); }
  /** Removes an override. False when there was none. */
  clear(key: string): boolean { return this.store.clear(key); }
  isSetByEnvironment(key: string): boolean { return this.store.isSetByEnvironment(key); }
  customConfigPath(): string { return this.store.customConfigPath(); }

  async backup(): Promise<BackupData> {
    const overlay: Record<string, ConfigValue> = {};
    for (const row of this.store.snapshot()) {
      if (row.source === 'custom') overlay[row.key] = this.store.reveal(row.key);
    }
    return { manager: this.name, takenAt: new Date().toISOString(), payload: overlay };
  }

  async restore(data: BackupData): Promise<void> {
    for (const [key, value] of Object.entries((data.payload ?? {}) as Record<string, ConfigValue>)) {
      this.store.set(key, value);
    }
  }
}
