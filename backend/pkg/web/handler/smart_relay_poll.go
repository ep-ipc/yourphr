package handler

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// intGetter is the config surface this file needs (real config.Interface satisfies it).
type intGetter interface {
	GetInt(key string) int
}

// Error codes returned on SMART connect relay failures so the UI can show distinct copy and
// only retry true poll timeouts (#406).
const (
	ErrorCodeRelayNotConfigured = "relay_not_configured"
	ErrorCodeRelayUnauthorized  = "relay_unauthorized"
	ErrorCodeRelayPollTimeout   = "relay_poll_timeout"
	ErrorCodeRelayPollFailed    = "relay_poll_failed"
)

const (
	defaultRelayPollSeconds = 55
	maxRelayPollSeconds     = 60 // relay code TTL is ~60s; longer polls cannot help
)

// relayPollSeconds returns the configured single-connect poll window, clamped to (0, max].
func relayPollSeconds(appConfig intGetter) int {
	sec := appConfig.GetInt("web.smart_connect.relay_poll_seconds")
	if sec <= 0 {
		sec = defaultRelayPollSeconds
	}
	if sec > maxRelayPollSeconds {
		sec = maxRelayPollSeconds
	}
	return sec
}

func relayPollTimeout(appConfig intGetter) time.Duration {
	return time.Duration(relayPollSeconds(appConfig)) * time.Second
}

func respondRelayNotConfigured(c *gin.Context, err error) {
	c.JSON(http.StatusServiceUnavailable, gin.H{
		"success":    false,
		"error":      fmt.Sprintf("relay not configured: %s — set YOURPHR_RELAY_SECRET (relay.secret) on this app; it must match the relay", err),
		"error_code": ErrorCodeRelayNotConfigured,
	})
}

// respondRelayCodeError classifies a PollUntil failure for the connect UI.
func respondRelayCodeError(c *gin.Context, err error) {
	errStr := err.Error()
	code := ErrorCodeRelayPollFailed
	msg := fmt.Sprintf("could not retrieve authorization code from relay: %s", err)

	switch {
	case strings.Contains(errStr, "timed out"):
		code = ErrorCodeRelayPollTimeout
		msg = "timed out waiting for the authorization code from the relay — finish sign-in in the popup; if it already said Connected, click Connect again promptly (codes last about 60 seconds) and confirm the provider redirect URI matches this server's relay callback"
	case strings.Contains(errStr, "unauthorized"):
		code = ErrorCodeRelayUnauthorized
		msg = "relay rejected the shared secret — YOURPHR_RELAY_SECRET on the app must match the relay's YOURPHR_RELAY_SECRET"
	}

	c.JSON(http.StatusBadGateway, gin.H{
		"success":    false,
		"error":      msg,
		"error_code": code,
	})
}
