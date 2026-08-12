package middleware_test

import (
	"testing"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/middleware"
	"github.com/stretchr/testify/require"
)

func TestFixedWindowLimiter_AllowsUpToTheLimit(t *testing.T) {
	l := middleware.NewFixedWindowLimiter(3, time.Minute)

	for i := 1; i <= 3; i++ {
		allowed, _ := l.Allow("jim")
		require.Truef(t, allowed, "attempt %d is within the limit", i)
	}

	allowed, retryAfter := l.Allow("jim")
	require.False(t, allowed)
	require.Equal(t, time.Minute, retryAfter, "callers need the window to send Retry-After")
}

// Separate keys are separate budgets — otherwise one account being attacked would lock out everyone.
func TestFixedWindowLimiter_KeysAreIndependent(t *testing.T) {
	l := middleware.NewFixedWindowLimiter(1, time.Minute)

	allowed, _ := l.Allow("jim")
	require.True(t, allowed)
	allowed, _ = l.Allow("jim")
	require.False(t, allowed)

	allowed, _ = l.Allow("someone-else")
	require.True(t, allowed, "another account must not inherit the first one's exhausted budget")
}

// Reset is what makes the sign-in throttle count failures only: a success clears the counter.
func TestFixedWindowLimiter_ResetClearsOneKey(t *testing.T) {
	l := middleware.NewFixedWindowLimiter(1, time.Minute)

	l.Allow("jim")
	allowed, _ := l.Allow("jim")
	require.False(t, allowed)

	l.Reset("jim")
	allowed, _ = l.Allow("jim")
	require.True(t, allowed, "a successful sign-in must not leave earlier failures on the clock")
}

// The documented escape hatch: an operator whose deployment genuinely cannot use a limit sets it to
// zero. Reading a non-positive limit as "allow nothing" would lock everyone out of their records.
func TestFixedWindowLimiter_NonPositiveLimitDisablesIt(t *testing.T) {
	for _, limit := range []int{0, -1} {
		l := middleware.NewFixedWindowLimiter(limit, time.Minute)
		for i := 0; i < 50; i++ {
			allowed, _ := l.Allow("jim")
			require.Truef(t, allowed, "limit %d must disable the limiter, not invert it", limit)
		}
	}
}

func TestFixedWindowLimiter_WindowExpiryStartsAFreshCount(t *testing.T) {
	l := middleware.NewFixedWindowLimiter(1, 30*time.Millisecond)

	allowed, _ := l.Allow("jim")
	require.True(t, allowed)
	allowed, _ = l.Allow("jim")
	require.False(t, allowed)

	time.Sleep(40 * time.Millisecond)

	allowed, _ = l.Allow("jim")
	require.True(t, allowed, "the window is fixed, so it eventually forgives")
}

// A nil limiter is what a caller gets if construction is ever skipped; it must fail OPEN rather than
// panic inside the sign-in path.
func TestFixedWindowLimiter_NilIsInert(t *testing.T) {
	var l *middleware.FixedWindowLimiter
	allowed, _ := l.Allow("jim")
	require.True(t, allowed)
	l.Reset("jim")
}
