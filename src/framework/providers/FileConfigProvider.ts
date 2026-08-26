/**
 * Configuration from the two files (yourphr#621) — the shape Go, ngdpbase and this stack now share:
 *
 *   config/app-default-config.json          ships with the product, required, read-only
 *   <data>/config/app-custom-config.json    the instance's overrides, optional, written here
 *
 * `_`-prefixed keys are comments: filtered out on load and a `_comment` header written back on
 * save, as ngdpbase does (`ConfigurationManager.ts:398,846`). The saved file holds ONLY what the
 * operator changed — writing the merged view would freeze today's defaults into the instance and
 * silently shadow everything a later release ships (ngdpbase's #895).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BaseConfigProvider, type LoadedConfig } from './BaseConfigProvider.js';
import type { ConfigValue } from '../../config/index.js';

/** Comments live alongside values; a key starting with `_` is never a setting. */
const isComment = (key: string): boolean => key.startsWith('_');

const HEADER = 'This file holds ONLY what this instance changed. It is merged over config/app-default-config.json, and the environment overrides both. Do not paste the defaults in here: a copy would shadow every value a later release ships.';

export class FileConfigProvider extends BaseConfigProvider {
  readonly name = 'file';
  private readonly defaultsPath: string;
  private readonly customPath: string;

  constructor(private readonly dataDir: string, defaultsPath = join(process.cwd(), 'config', 'app-default-config.json')) {
    super();
    this.defaultsPath = defaultsPath;
    this.customPath = join(dataDir, 'config', 'app-custom-config.json');
  }

  load(): LoadedConfig {
    if (!existsSync(this.defaultsPath)) {
      throw new Error(`configuration: the shipped defaults are missing at ${this.defaultsPath} — this file is part of the product and the instance cannot boot without it`);
    }
    let defaults: Record<string, ConfigValue>;
    try {
      defaults = strip(JSON.parse(readFileSync(this.defaultsPath, 'utf8')) as Record<string, ConfigValue>);
    } catch (err) {
      throw new Error(`configuration: the shipped defaults at ${this.defaultsPath} could not be read: ${(err as Error).message}`);
    }
    if (!existsSync(this.customPath)) return { defaults, custom: {} };
    try {
      return { defaults, custom: strip(JSON.parse(readFileSync(this.customPath, 'utf8')) as Record<string, ConfigValue>) };
    } catch (err) {
      // Left alone, never clobbered: the operator's settings may still be recoverable from it.
      return { defaults, custom: {}, customUnreadable: `${this.customPath}: ${(err as Error).message}` };
    }
  }

  saveCustom(custom: Record<string, ConfigValue>): void {
    mkdirSync(dirname(this.customPath), { recursive: true });
    writeFileSync(this.customPath, JSON.stringify({ _comment: HEADER, ...custom }, null, 2) + '\n', { mode: 0o600 });
  }

  customLocation(): string {
    return this.customPath;
  }

  /**
   * The roots path templates resolve against (yourphr#630). The fast root is the directory this
   * provider was pointed at; the slow root defaults to it, so a single-volume instance sets
   * nothing. A real environment variable outranks both — the manager checks it first.
   */
  override roots(): Record<string, string> {
    return { YOURPHR_FAST_STORAGE: this.dataDir, YOURPHR_SLOW_STORAGE: this.dataDir };
  }
}

function strip(raw: Record<string, ConfigValue>): Record<string, ConfigValue> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !isComment(key)));
}
