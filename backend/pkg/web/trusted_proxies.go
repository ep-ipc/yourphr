package web

import (
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// TrustedProxiesConfigKey names the CIDRs (or bare addresses) whose forwarding headers are believed.
const TrustedProxiesConfigKey = "web.trusted_proxies"

// ApplyTrustedProxies decides whether `X-Forwarded-For` is evidence or merely input (#529).
//
// Gin's defaults trust EVERY proxy: ForwardedByClientIP is true, RemoteIPHeaders is
// [X-Forwarded-For, X-Real-IP], and trustedCIDRs is 0.0.0.0/0 + ::/0. So out of the box c.ClientIP()
// returns whatever the caller puts in a header — the client chooses its own identity. That is not
// only an audit problem: the per-IP credential limiter (middleware.RateLimitMiddleware, #104) keys
// on that value, so rotating the header lands in a fresh bucket every request and the brute-force
// backstop never fires.
//
// EMPTY MEANS TRUST NOTHING, and that is the default. With no trusted CIDRs, gin's isTrustedProxy
// returns false for every peer, the forwarding headers are ignored, and ClientIP falls back to the
// actual socket address. That is the correct behaviour for a directly reachable instance — which
// includes every port-forwarded or tunnelled home deployment, where a header no proxy ever set would
// otherwise be honoured.
//
// A deployment behind a reverse proxy sets the proxy's address or subnet, and only then is the
// header believed. The cost of getting THAT wrong is the opposite failure: every client shares the
// proxy's bucket. Both directions are wrong in different ways, which is exactly why it is a setting
// with a safe default rather than a guess.
//
// An unparseable entry is reported and leaves the engine trusting nothing. Failing closed is the
// only safe direction here: continuing with gin's trust-everything default because a CIDR had a typo
// would turn a configuration mistake into a silently disabled rate limiter.
func ApplyTrustedProxies(r *gin.Engine, proxies []string, logger *logrus.Entry) error {
	if len(proxies) == 0 {
		if err := r.SetTrustedProxies(nil); err != nil {
			return fmt.Errorf("could not disable proxy trust: %w", err)
		}
		if logger != nil {
			logger.Infof(
				"%s is empty: forwarding headers are ignored and the client address is the socket peer. Set it if this instance runs behind a reverse proxy.",
				TrustedProxiesConfigKey,
			)
		}
		return nil
	}

	if err := r.SetTrustedProxies(proxies); err != nil {
		// Leave the engine in the safe state rather than whatever gin had before.
		if resetErr := r.SetTrustedProxies(nil); resetErr != nil {
			return fmt.Errorf("invalid %s (%v), and could not fall back to trusting nothing: %w", TrustedProxiesConfigKey, err, resetErr)
		}
		return fmt.Errorf("invalid %s: %w — trusting no proxy instead", TrustedProxiesConfigKey, err)
	}

	if logger != nil {
		logger.Infof("%s: trusting forwarding headers from %v", TrustedProxiesConfigKey, proxies)
	}
	return nil
}
