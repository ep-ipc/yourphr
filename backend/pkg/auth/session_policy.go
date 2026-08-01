package auth

import (
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
)

// SessionPolicy controls browser session JWT lifetime (#445 Option A — sliding + absolute cap).
//
// TTL is the sliding window: each renew sets exp = min(now+TTL, session_start+AbsoluteMax).
// RenewIfRemaining triggers renew when time-until-exp is at most this duration (activity near end of life).
// AbsoluteMax is the hard cap from session_start (first login); never extended.
type SessionPolicy struct {
	TTL              time.Duration
	AbsoluteMax      time.Duration
	RenewIfRemaining time.Duration
}

// DefaultSessionPolicy matches pre-#445 behaviour for the sliding window (1h) with a 12h absolute cap
// and renew when ≤30 minutes remain.
func DefaultSessionPolicy() SessionPolicy {
	return SessionPolicy{
		TTL:              time.Hour,
		AbsoluteMax:      12 * time.Hour,
		RenewIfRemaining: 30 * time.Minute,
	}
}

// SessionPolicyFromConfig reads jwt.session_* keys (YOURPHR_JWT_SESSION_*). Zero/negative → defaults.
func SessionPolicyFromConfig(cfg config.Interface) SessionPolicy {
	p := DefaultSessionPolicy()
	if cfg == nil {
		return p
	}
	if m := cfg.GetInt("jwt.session_ttl_minutes"); m > 0 {
		p.TTL = time.Duration(m) * time.Minute
	}
	if h := cfg.GetInt("jwt.session_absolute_hours"); h > 0 {
		p.AbsoluteMax = time.Duration(h) * time.Hour
	}
	if m := cfg.GetInt("jwt.session_renew_if_remaining_minutes"); m > 0 {
		p.RenewIfRemaining = time.Duration(m) * time.Minute
	}
	// Cap renew threshold at TTL so we never "always renew" unintentionally.
	if p.RenewIfRemaining > p.TTL {
		p.RenewIfRemaining = p.TTL
	}
	return p
}

// CookieMaxAgeSeconds is the Set-Cookie Max-Age for a freshly issued session JWT.
func (p SessionPolicy) CookieMaxAgeSeconds() int {
	sec := int(p.TTL.Seconds())
	if sec < 1 {
		return 3600
	}
	return sec
}
