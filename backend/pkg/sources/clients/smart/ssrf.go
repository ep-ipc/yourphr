package smart

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// validateBaseURL guards the user-supplied FHIR base URL before the backend makes any server-side
// request to it. Because the backend fetches from whatever base a source registers, an unvalidated
// base is a Server-Side Request Forgery (SSRF) vector: it could be aimed at the cloud metadata
// endpoint (169.254.169.254) or an internal RFC1918 service. This is defense-in-depth — in the
// single-user self-hosted model the user controls their own base, but the backend runs with network
// reach the user may not have (k8s, the relay), so we refuse obviously-internal targets.
//
// It accepts only http/https URLs that have a host, and rejects IP-literal hosts in the loopback,
// private, link-local, unique-local, or unspecified ranges (plus the well-known cloud metadata
// addresses) and localhost-ish names. On success it returns the base trimmed of any trailing slash.
//
// It is a PRE-CHECK, not the security boundary. It runs before any connection, so it can give a
// clear error at the moment a source is added — but it cannot be relied on, because it inspects a
// string:
//
//   - net.ParseIP accepts only dotted-quad and IPv6 literals, so "2130706433", "0x7f.0.0.1" and
//     "127.1" all parse as nil and skip the IP check entirely, while the resolver reads them as
//     127.0.0.1 (yourphr#484)
//   - a public name can resolve to a private address, either always or only on the second lookup
//     (DNS rebinding)
//   - a redirect is never seen here at all
//
// The boundary is guardedDialer, which judges the RESOLVED address of every connection at dial
// time. Full egress filtering still belongs at the network layer; these two are defence in depth.
//
// AllowInternalHostsForTest, when true, disables the internal-host SSRF guard process-wide,
// regardless of Config.AllowInternalHosts. It exists ONLY so a consumer's test suite can drive the
// full connect+sync flow (including factory-built clients in background jobs) against httptest
// loopback servers. NEVER set it in production. Per-instance loopback in this package's own tests uses
// Config.AllowInternalHosts instead.
var AllowInternalHostsForTest bool

// allowInternal bypasses the internal-host checks (still validating scheme + host). It is wired to
// Config.AllowInternalHosts (per-instance) and the AllowInternalHostsForTest global — both test-only,
// for httptest loopback servers; never set in production.
func validateBaseURL(raw string, allowInternal bool) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("FHIR base URL is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("FHIR base URL is not a valid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("FHIR base URL must be http(s), got %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("FHIR base URL has no host")
	}
	if !allowInternal && !AllowInternalHostsForTest {
		if isBlockedHostname(host) {
			return "", fmt.Errorf("FHIR base URL host %q is not allowed (internal/loopback)", host)
		}
		if ip := net.ParseIP(host); ip != nil && isBlockedIP(ip) {
			return "", fmt.Errorf("FHIR base URL host %q is a disallowed internal address", host)
		}
	}
	return strings.TrimRight(raw, "/"), nil
}

// isBlockedHostname rejects localhost and the conventional internal-only TLD suffixes.
func isBlockedHostname(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	if h == "localhost" {
		return true
	}
	for _, suffix := range []string{".localhost", ".local", ".internal"} {
		if strings.HasSuffix(h, suffix) {
			return true
		}
	}
	return false
}

// isBlockedIP rejects IP literals that point inward: loopback, RFC1918/ULA private, link-local
// (which already covers 169.254.0.0/16), and the unspecified address, plus the explicit cloud
// metadata addresses for clarity.
func isBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip.Equal(net.ParseIP("169.254.169.254")) || ip.Equal(net.ParseIP("fd00:ec2::254")) {
		return true
	}
	return false
}

// safeBaseURL validates c.FHIRBaseURL and returns the trimmed base used to build every outbound
// request. All request builders go through this so the SSRF guard cannot be bypassed.
func (c Config) safeBaseURL() (string, error) {
	return validateBaseURL(c.FHIRBaseURL, c.AllowInternalHosts)
}

// guardedDialer refuses connections to internal addresses at DIAL time, after resolution.
//
// This is the actual SSRF boundary. validateBaseURL is a pre-check that produces a friendly error;
// it cannot be the boundary, for two reasons that no amount of string inspection fixes:
//
//  1. Go's net.ParseIP accepts only dotted-quad and IPv6 literals, so every other numeric form
//     returned nil and skipped the check entirely — while the system resolver understood them
//     perfectly well (yourphr#484):
//
//     2130706433           -> 127.0.0.1
//     0x7f.0.0.1           -> 127.0.0.1
//     127.1                -> 127.0.0.1
//     2852039166           -> 169.254.169.254   (cloud metadata)
//     0251.0376.0251.0376  -> 169.254.169.254
//
//  2. DNS rebinding. A name can resolve to a public address when validated and an internal one
//     moments later when dialled. Only a check at connection time sees what was actually reached.
//
// Control runs after the address is resolved and before the socket is connected, and it runs for
// EVERY connection — including redirects, which a base-URL check never sees at all.
func guardedDialer(allowInternal bool) *net.Dialer {
	return &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			if allowInternal || AllowInternalHostsForTest {
				return nil
			}
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				// Control is documented to receive a resolved "ip:port"; anything else is
				// unexpected, so fail closed rather than guess.
				return fmt.Errorf("refusing connection to %q: unrecognised address form", address)
			}
			ip := net.ParseIP(host)
			if ip == nil {
				// Also fail closed: by this point the resolver has run, so a non-IP here means
				// something is wrong rather than something clever.
				return fmt.Errorf("refusing connection to %q: not a resolved IP address", address)
			}
			if isBlockedIP(ip) {
				return fmt.Errorf("refusing connection to internal address %s "+
					"(loopback, private, link-local or cloud metadata)", ip)
			}
			return nil
		},
	}
}

// GuardedTransport returns an http.Transport that cannot connect to an internal address.
//
// Built from http.DefaultTransport's settings rather than a bare &http.Transport{}, so connection
// pooling, HTTP/2 and proxy support behave as they do everywhere else — a hand-rolled transport
// silently loses those and the loss is hard to notice.
func GuardedTransport(allowInternal bool) *http.Transport {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		base = &http.Transport{}
	}
	t := base.Clone()
	t.DialContext = guardedDialer(allowInternal).DialContext
	return t
}
