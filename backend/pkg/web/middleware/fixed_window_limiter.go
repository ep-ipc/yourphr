package middleware

import (
	"sync"
	"time"
)

// FixedWindowLimiter counts events per key in a fixed window. Extracted from RateLimitMiddleware so
// the per-ACCOUNT sign-in throttle (#509) shares one implementation with the per-IP one rather than
// growing a second, subtly different counter.
//
// Deliberately not a token bucket or sliding window: this is a brute-force backstop, not a
// throughput control. bcrypt already makes each attempt expensive, so the job here is to cap how
// many an attacker gets per window, and a fixed window is the shape that is obvious to reason about
// when reading a log line.
//
// No background goroutine, so it is safe to construct on every Setup()/Reinitialize(); memory is
// bounded by opportunistic sweeping.
type FixedWindowLimiter struct {
	mu      sync.Mutex
	entries map[string]*rateLimitEntry
	limit   int
	window  time.Duration
}

// NewFixedWindowLimiter returns a limiter allowing `limit` events per `window` per key.
//
// A limit of zero or less DISABLES the limiter — Allow always returns true. That is the documented
// escape hatch for an operator whose deployment genuinely cannot use one (an automated suite, a
// single-user LAN instance), and it is also what keeps a mis-set key from silently locking everyone
// out instead of silently letting everyone in.
func NewFixedWindowLimiter(limit int, window time.Duration) *FixedWindowLimiter {
	return &FixedWindowLimiter{
		entries: make(map[string]*rateLimitEntry),
		limit:   limit,
		window:  window,
	}
}

// Allow records one event against key and reports whether it is within the limit. It returns the
// window as retryAfter so callers can send a Retry-After header without knowing the configuration.
func (l *FixedWindowLimiter) Allow(key string) (allowed bool, retryAfter time.Duration) {
	if l == nil || l.limit <= 0 || l.window <= 0 {
		return true, 0
	}

	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	e := l.entries[key]
	if e == nil || now.Sub(e.windowStart) >= l.window {
		e = &rateLimitEntry{windowStart: now}
		l.entries[key] = e
	}
	e.count++
	over := e.count > l.limit

	// Opportunistic cleanup so the map cannot grow without bound. Same threshold as the per-IP
	// middleware: a sweep only when the map is already large, rather than a goroutine to maintain.
	if len(l.entries) > 1024 {
		for k, v := range l.entries {
			if now.Sub(v.windowStart) >= l.window {
				delete(l.entries, k)
			}
		}
	}

	return !over, l.window
}

// Reset clears the counter for one key. Called after a SUCCESSFUL sign-in so a person who fumbled
// their password twice and then got it right does not carry those failures for the rest of the
// window.
func (l *FixedWindowLimiter) Reset(key string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	delete(l.entries, key)
	l.mu.Unlock()
}
