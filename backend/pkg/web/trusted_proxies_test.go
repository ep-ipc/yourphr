package web

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/middleware"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// clientIPFor spins up a real server so the peer address is a real socket rather than a value the
// test chose. A handler-level test with a synthesised RemoteAddr would prove nothing about spoofing,
// because the thing under test is precisely whether a caller-supplied header can override the peer.
func clientIPFor(t *testing.T, proxies []string, headers map[string]string) string {
	t.Helper()
	gin.SetMode(gin.TestMode)

	r := gin.New()
	require.NoError(t, ApplyTrustedProxies(r, proxies, nil))

	var seen string
	r.GET("/whoami", func(c *gin.Context) {
		seen = c.ClientIP()
		c.Status(http.StatusOK)
	})

	server := httptest.NewServer(r)
	defer server.Close()

	req, err := http.NewRequest(http.MethodGet, server.URL+"/whoami", nil)
	require.NoError(t, err)
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	return seen
}

// The defect in #529: gin trusts every proxy out of the box, so the client picks its own address.
// The per-IP credential limiter keys on this value, which made it bypassable by rotating a header.
func TestClientIP_ForwardedHeaderIsIgnoredWhenNoProxyIsTrusted(t *testing.T) {
	ip := clientIPFor(t, nil, map[string]string{"X-Forwarded-For": "203.0.113.99"})
	require.Equal(t, "127.0.0.1", ip, "a caller-supplied X-Forwarded-For must not become the client address")
}

// X-Real-IP is the second header gin consults; trusting nothing has to cover both or the bypass
// simply moves one header along.
func TestClientIP_RealIPHeaderIsIgnoredWhenNoProxyIsTrusted(t *testing.T) {
	ip := clientIPFor(t, nil, map[string]string{"X-Real-IP": "203.0.113.99"})
	require.Equal(t, "127.0.0.1", ip)
}

// An empty slice and a nil slice must behave identically — an operator clearing the list in the
// config UI produces the former.
func TestClientIP_EmptySliceTrustsNothing(t *testing.T) {
	ip := clientIPFor(t, []string{}, map[string]string{"X-Forwarded-For": "203.0.113.99"})
	require.Equal(t, "127.0.0.1", ip)
}

// The other half of the contract: a real reverse-proxy deployment must still see real client
// addresses, or per-IP limiting collapses everyone into one bucket.
func TestClientIP_ForwardedHeaderIsHonouredFromATrustedProxy(t *testing.T) {
	ip := clientIPFor(t, []string{"127.0.0.1/32"}, map[string]string{"X-Forwarded-For": "203.0.113.99"})
	require.Equal(t, "203.0.113.99", ip, "a proxy the operator listed must be believed")
}

// A proxy that is listed but is not the peer changes nothing — trust is per-connection, not a
// blanket switch.
func TestClientIP_ForwardedHeaderIsIgnoredFromAnUntrustedPeer(t *testing.T) {
	ip := clientIPFor(t, []string{"10.42.0.0/16"}, map[string]string{"X-Forwarded-For": "203.0.113.99"})
	require.Equal(t, "127.0.0.1", ip)
}

// The consequence the issue was actually about: with every proxy trusted, an attacker rotating
// X-Forwarded-For lands in a fresh rate-limit bucket on every request and never meets a 429. This
// drives the real limiter rather than asserting on ClientIP, because the bypass is only interesting
// where it defeats something.
func TestRateLimit_CannotBeBypassedByRotatingForwardedFor(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	require.NoError(t, ApplyTrustedProxies(r, nil, nil))
	r.Use(middleware.RateLimitMiddleware(3, time.Minute))
	r.POST("/api/auth/signin", func(c *gin.Context) { c.Status(http.StatusUnauthorized) })

	server := httptest.NewServer(r)
	defer server.Close()

	statuses := make([]int, 0, 6)
	for i := range 6 {
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/auth/signin", nil)
		require.NoError(t, err)
		// A different source address claimed on every attempt.
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", i+1))
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		statuses = append(statuses, resp.StatusCode)
	}

	require.Contains(t, statuses, http.StatusTooManyRequests,
		"rotating X-Forwarded-For must not win a fresh bucket each time: got %v", statuses)
	require.Equal(t, http.StatusTooManyRequests, statuses[3],
		"the 4th attempt past a limit of 3 must be refused: got %v", statuses)
}

// A typo must fail CLOSED. Restoring gin's trust-everything default because a CIDR was malformed
// would turn a configuration mistake into a silently disabled rate limiter.
func TestApplyTrustedProxies_InvalidEntryFailsClosed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()

	err := ApplyTrustedProxies(r, []string{"not-a-cidr"}, nil)
	require.Error(t, err, "an unparseable entry must be reported, not swallowed")

	var seen string
	r.GET("/whoami", func(c *gin.Context) {
		seen = c.ClientIP()
		c.Status(http.StatusOK)
	})
	server := httptest.NewServer(r)
	defer server.Close()

	req, err := http.NewRequest(http.MethodGet, server.URL+"/whoami", nil)
	require.NoError(t, err)
	req.Header.Set("X-Forwarded-For", "203.0.113.99")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, "127.0.0.1", seen, "after an invalid configuration the engine must trust no proxy")
}
