/**
 * Configuration held in memory (yourphr#621): what a test uses instead of creating a temporary
 * directory on disk purely to have configuration. Before this, six unit-test files and two
 * harnesses did exactly that in tests that were not about configuration at all.
 */
import { BaseConfigProvider, type LoadedConfig } from '../BaseConfigProvider.js';
import { ConfigCatalog, type ConfigValue } from '../../../config/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The real shipped values, read once, so a fake is not a second opinion about what ships. */
const SHIPPED: Record<string, ConfigValue> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(join(process.cwd(), 'config', 'app-default-config.json'), 'utf8')) as Record<string, ConfigValue>)
    .filter(([key]) => !key.startsWith('_'))
);

export class FakeConfigProvider extends BaseConfigProvider {
  readonly name = 'fake';
  saves = 0;

  constructor(
    private custom: Record<string, ConfigValue> = {},
    private readonly defaults: Record<string, ConfigValue> = SHIPPED,
    private readonly unreadable?: string
  ) {
    super();
  }

  load(): LoadedConfig {
    return { defaults: { ...this.defaults }, custom: { ...this.custom }, ...(this.unreadable ? { customUnreadable: this.unreadable } : {}) };
  }

  saveCustom(custom: Record<string, ConfigValue>): void {
    this.saves++;
    this.custom = { ...custom };
  }

  /** What the "file" holds now — so a test can assert deltas were written, not the merged view. */
  written(): Record<string, ConfigValue> {
    return { ...this.custom };
  }

  customLocation(): string {
    return '<in-memory>';
  }
}

export { ConfigCatalog };
