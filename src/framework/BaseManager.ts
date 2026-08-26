/**
 * The base contract every manager answers (yourphr#608): lifecycle, and — because a manager is
 * the only door to its resource — backup and restore. ngdpbase's `BaseManager` has the same four
 * methods; here `backup()` and `restore()` are abstract rather than defaulted, so a manager cannot
 * exist without answering how its resource is copied and brought back. The engine calls
 * initialize() in validated dependency order and shutdown() in reverse.
 *
 * A manager takes the request context on every call that acts for someone ("who is asking"); it
 * never reads `ctx.engine` — it reaches siblings through its own `engine` field. That is the
 * context rule decided on #608, and the store-boundary lint is what enforces it.
 */
import type { Engine, ManagerName } from './Engine.js';

/** What a manager hands the backup coordinator: its own files or payload, dated and named. */
export interface BackupData {
  manager: string;
  takenAt: string;
  /** Files the manager wrote under the backup destination; the coordinator lists and prunes them. */
  files?: string[];
  /** An in-memory payload for managers whose state is small (configuration, favourites). */
  payload?: unknown;
}

export abstract class BaseManager {
  /** The registry key; also what the backup data and the boot log name. */
  abstract readonly name: ManagerName;
  /** Managers that must initialise first. The engine validates and orders. */
  readonly dependsOn: readonly ManagerName[] = [];
  protected initialized = false;
  protected config: Record<string, unknown> = {};

  constructor(protected readonly engine: Engine) {}

  async initialize(config: Record<string, unknown> = {}): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  abstract backup(options: { destination: string; key: string }): Promise<BackupData>;
  abstract restore(data: BackupData, options: { key: string }): Promise<void>;
}
