/**
 * The outbound HTTP capability — the only way anything in this codebase reaches the network.
 *
 * Follows `docs/planning/architecture-principles-typescript.md` in the product repo. Two rules from
 * it shape this file:
 *
 *   "All code that touches a resource goes through that resource's manager. There is no second
 *    path." The network is such a resource here. A guard that any file can walk around by importing
 *    node:https itself is decoration, so this directory is the single door and
 *    scripts/check-http-boundary.sh fails the build when anything else opens one.
 *
 *   "Configuration binds capabilities to providers; providers supply behaviour." allowInternal is
 *    therefore read from configuration ONCE, here, rather than being a per-call argument. That
 *    difference matters: a per-call flag means any caller can disable the SSRF guard for one
 *    request, and the disabling looks like an ordinary option at the call site. yourphr#548 has the
 *    same open question about the Go side's AllowInternalHosts.
 */
import { guardedFetch, type GuardedFetchOptions, type GuardedResponse } from './guarded-fetch.js';
import { REFUSAL, isBlockedHostname, isBlockedIp, validateUrl } from './ssrf.js';

export interface OutboundHttpConfig {
  /**
   * Permits connections to internal addresses. Exists for tests, which drive loopback servers.
   * Never true in a deployment: it disables the SSRF guard entirely.
   */
  allowInternal?: boolean;
  /**
   * Hostnames an operator named in configuration, exempted from the internal-address refusal —
   * a sidecar they deployed and addressed by name (`http://typesense:8108`). Read from
   * configuration ONCE, here, for the same reason `allowInternal` is: a per-call list would let
   * any caller widen the guard for one request, and the widening would look like an ordinary
   * option at the call site. `RequestOptions` strips it for exactly that reason.
   */
  allowHosts?: readonly string[];
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Per-request options, minus anything that could weaken the guard. */
export type RequestOptions = Omit<GuardedFetchOptions, 'allowInternal' | 'allowHosts'>;

export class OutboundHttp {
  private readonly config: OutboundHttpConfig;
  private readonly allowHosts: ReadonlySet<string>;

  constructor(config: OutboundHttpConfig = {}) {
    this.config = config;
    this.allowHosts = new Set((config.allowHosts ?? []).map((h) => h.toLowerCase()));
    if (this.allowHosts.size > 0) {
      // Named, not silent. An exemption an operator wrote down should still be visible in the boot
      // log, so "why can this instance reach that box" is answerable without reading the config.
      console.warn(`[outbound-http] internal-address exemption for: ${[...this.allowHosts].join(', ')}`);
    }
    if (config.allowInternal) {
      // Visible rather than silent. An instance that cannot reach internal addresses and one that
      // can are very different things, and the difference should never be discovered from a log
      // nobody read. Ties to the doc's rule that an inert or weakened capability must be announced.
      console.warn(
        '[outbound-http] allowInternal is ON — the SSRF guard is disabled. This must never be a deployment setting.'
      );
    }
  }

  /**
   * Every hop re-checked, redirects followed by hand, body capped. See guarded-fetch.ts for why
   * Node's built-in fetch cannot be used.
   */
  async get(url: string, options: RequestOptions = {}): Promise<GuardedResponse> {
    // Deliberately does NOT pin method:'GET'. Callers pass `method: 'POST'` through here — the
    // OAuth token exchange is the main one — and forcing the verb silently turned every token
    // refresh into a GET, which the provider answered with a 401 that looked like an expired
    // credential. The name is historical; `request` below is the honest one.
    return this.request(url, options);
  }

  /** A request the capability shapes: the guard's settings win over anything the caller passed. */
  async request(url: string, options: RequestOptions = {}): Promise<GuardedResponse> {
    return guardedFetch(url, {
      maxRedirects: this.config.maxRedirects,
      maxBytes: this.config.maxBytes,
      timeoutMs: this.config.timeoutMs,
      ...options,
      allowInternal: this.config.allowInternal ?? false,
      allowHosts: this.allowHosts,
    });
  }
}

export { REFUSAL, isBlockedHostname, isBlockedIp, validateUrl };
export type { GuardedResponse };
