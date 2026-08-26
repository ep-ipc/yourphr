/**
 * The configuration storage seam (yourphr#621). Deliberately narrow: a provider FETCHES the
 * shipped defaults and the instance's overrides, and PERSISTS the overrides. It does not merge,
 * does not apply precedence, and does not know about the environment layer.
 *
 * That line is the point. Merge order, the deltas-only rule and the environment's precedence are
 * policy, and policy that varies by storage backend is policy that will eventually be wrong in one
 * of them. A database-backed provider must not be able to invent its own idea of which layer wins.
 *
 * Bootstrap: this is the one capability NOT selected by configuration, because it is what reads
 * configuration. The composition root chooses it, alongside the data directory and the database
 * key — the values that must already hold before any settings screen can exist.
 */
import type { ConfigValue } from '../../config/index.js';

/** What a provider hands back at load: the product's values, and this instance's overrides. */
export interface LoadedConfig {
  /** The shipped defaults — what this release understands. Never written.  */
  defaults: Record<string, ConfigValue>;
  /** Only what the operator changed. Never a copy of the defaults (see the #895 note in the doc). */
  custom: Record<string, ConfigValue>;
  /**
   * Set when the overrides exist but could not be read. The manager reports it rather than
   * clobbering the file on the next save — it may hold settings the operator wants back.
   */
  customUnreadable?: string;
}

export abstract class BaseConfigProvider {
  /** For the boot log and the admin screen: which source this instance's configuration came from. */
  abstract readonly name: string;

  /**
   * Read both layers. Throws when the SHIPPED defaults are missing or unreadable — an instance
   * with no catalogue of values cannot be reasoned about, and guessing is worse than refusing.
   * Missing overrides are normal and return `{}`.
   */
  abstract load(): LoadedConfig;

  /** Persist the operator's overrides. Receives ONLY the deltas; never the merged view. */
  abstract saveCustom(custom: Record<string, ConfigValue>): void;

  /** Where the overrides live, so an operator can find the file (or the row, or the ConfigMap). */
  abstract customLocation(): string;

  /**
   * The storage roots this provider was built over, as environment names (yourphr#626). The manager
   * seeds `${VAR}` resolution with these so a path template resolves against the root actually in
   * use — including a test's temporary directory, which no environment variable names. A real
   * environment variable of the same name still wins.
   */
  roots(): Record<string, string> { return {}; }
}
