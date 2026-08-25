/**
 * The per-IP budget on the sign-in routes (yourphr#647). Time is passed in, never read from the
 * clock, so the window behaviour is asserted rather than waited for.
 */
import { describe, expect, it } from 'vitest';
import { SimpleRateLimiter } from '../rate-limit.js';

const OPTS = { max: 3, windowMs: 60_000 };

describe('SimpleRateLimiter — requests per window, per key', () => {
  it('allows up to the budget and denies past it', () => {
    const limiter = new SimpleRateLimiter(OPTS);
    expect([1, 2, 3].map((i) => limiter.consume('ip-a', 1000 + i).allowed)).toEqual([true, true, true]);
    expect(limiter.consume('ip-a', 1004).allowed).toBe(false);
  });

  it('keys are independent — one noisy address does not throttle everyone', () => {
    const limiter = new SimpleRateLimiter(OPTS);
    for (let i = 0; i < 5; i++) limiter.consume('ip-a', 1000 + i);
    expect(limiter.consume('ip-b', 1005).allowed).toBe(true);
  });

  it('the window resets, and a denied event still counts inside it', () => {
    const limiter = new SimpleRateLimiter(OPTS);
    for (let i = 0; i < 10; i++) limiter.consume('ip-a', 1000 + i);
    // Still denied a moment later: a flood must not amortise back to allowed the instant the
    // legitimate traffic stops.
    expect(limiter.consume('ip-a', 30_000).allowed).toBe(false);
    expect(limiter.consume('ip-a', 62_000).allowed).toBe(true);
  });

  it('reports how long to wait, which is what Retry-After is made of', () => {
    const limiter = new SimpleRateLimiter(OPTS);
    for (let i = 0; i < 4; i++) limiter.consume('ip-a', 1000);
    expect(limiter.consume('ip-a', 21_000).retryAfterMs).toBe(40_000);
  });

  it('a budget of 0 or less is OFF, not "deny everything" (yourphr#481)', () => {
    for (const max of [0, -1]) {
      const limiter = new SimpleRateLimiter({ max, windowMs: 60_000 });
      expect(limiter.enabled).toBe(false);
      for (let i = 0; i < 100; i++) expect(limiter.consume('ip-a', 1000 + i).allowed).toBe(true);
    }
  });

  it('sweeps expired buckets rather than growing forever', () => {
    const limiter = new SimpleRateLimiter(OPTS);
    for (let i = 0; i < 50; i++) limiter.consume(`ip-${i}`, 1000);
    limiter.consume('ip-new', 200_000); // one window later: the sweep runs
    expect(limiter.consume('ip-0', 200_001).count).toBe(1); // ip-0's old bucket is gone
  });
});
