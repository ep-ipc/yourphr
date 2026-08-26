/**
 * Per-key fixed-window rate limiter (yourphr#647), ported from ngdpbase's
 * `src/utils/SimpleRateLimiter.ts` — same shape, same `consume(key, now)` contract, same
 * opportunistic sweep, because a limiter is exactly the kind of thing two codebases should not
 * have two opinions about.
 *
 * WHY IT EXISTS HERE. The failure throttle inside SessionsManager answers "is somebody guessing
 * this account's password" — it counts FAILURES, and only ones that reach a password comparison.
 * It says nothing about a caller making well-formed requests as fast as the process will serve
 * them. `POST /api/auth/demo-signin` is the clearest case: anonymous, no body, and a bcrypt verify
 * per call, which is CPU the caller does not pay for. That is what this bounds.
 *
 * NOT DISTRIBUTED. Each process keeps its own counters, so N replicas allow N times the budget.
 * Fine at this scale — one pod — and the honest alternative is a shared store, not a fudge factor.
 */
export class SimpleRateLimiter {
    opts;
    buckets = new Map();
    lastGc = 0;
    constructor(opts) {
        this.opts = opts;
    }
    /**
     * Replace the options at runtime, keeping the buckets — an operator narrowing the budget on the
     * Configuration screen should take effect without a restart, and a live flood must not be handed
     * a clean slate by the change. Shrinking the window may retire in-flight buckets on the next
     * consume, which is the intended reading of "tighten this now".
     */
    configure(opts) {
        this.opts = opts;
    }
    /** Is the limiter doing anything at all? A budget of 0 or less is the documented off switch. */
    get enabled() {
        return this.opts.max > 0;
    }
    /**
     * Record an event under `key` and say whether to allow it. A denied event still increments, so a
     * flood does not amortise back to "allowed" the moment the legitimate traffic stops.
     */
    consume(key, now = Date.now()) {
        if (!this.enabled)
            return { allowed: true, count: 0, retryAfterMs: 0 };
        this.maybeGc(now);
        const bucket = this.buckets.get(key);
        if (!bucket || now - bucket.windowStart >= this.opts.windowMs) {
            this.buckets.set(key, { count: 1, windowStart: now });
            return { allowed: true, count: 1, retryAfterMs: this.opts.windowMs };
        }
        bucket.count += 1;
        const retryAfterMs = Math.max(0, this.opts.windowMs - (now - bucket.windowStart));
        return { allowed: bucket.count <= this.opts.max, count: bucket.count, retryAfterMs };
    }
    /** Drop all state. Test-only. */
    reset() {
        this.buckets.clear();
    }
    maybeGc(now) {
        // At most once per window, so a long-idle IP cannot pile up forever and the sweep costs nothing
        // on a busy instance.
        if (now - this.lastGc < this.opts.windowMs)
            return;
        this.lastGc = now;
        for (const [key, bucket] of this.buckets) {
            if (now - bucket.windowStart >= this.opts.windowMs)
                this.buckets.delete(key);
        }
    }
}
//# sourceMappingURL=rate-limit.js.map