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
import { guardedFetch } from './guarded-fetch.js';
import { REFUSAL, isBlockedHostname, isBlockedIp, validateUrl } from './ssrf.js';
export class OutboundHttp {
    config;
    constructor(config = {}) {
        this.config = config;
        if (config.allowInternal) {
            // Visible rather than silent. An instance that cannot reach internal addresses and one that
            // can are very different things, and the difference should never be discovered from a log
            // nobody read. Ties to the doc's rule that an inert or weakened capability must be announced.
            console.warn('[outbound-http] allowInternal is ON — the SSRF guard is disabled. This must never be a deployment setting.');
        }
    }
    /**
     * Every hop re-checked, redirects followed by hand, body capped. See guarded-fetch.ts for why
     * Node's built-in fetch cannot be used.
     */
    async get(url, options = {}) {
        return guardedFetch(url, {
            maxRedirects: this.config.maxRedirects,
            maxBytes: this.config.maxBytes,
            timeoutMs: this.config.timeoutMs,
            ...options,
            allowInternal: this.config.allowInternal ?? false,
        });
    }
}
export { REFUSAL, isBlockedHostname, isBlockedIp, validateUrl };
//# sourceMappingURL=index.js.map