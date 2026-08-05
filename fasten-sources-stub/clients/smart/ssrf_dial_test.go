package smart

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// callControl exercises the dial-time guard the way the net stack does: with an already-resolved
// "ip:port".
func callControl(t *testing.T, allowInternal bool, address string) error {
	t.Helper()
	return guardedDialer(allowInternal).Control("tcp4", address, nil)
}

// The addresses that used to sail straight past validateBaseURL, now judged after resolution.
//
// net.ParseIP accepts only dotted-quad, so every other numeric form returned nil, short-circuited
// the `ip != nil && isBlockedIP(ip)` check, and was never examined — while the system resolver
// understood them perfectly well. See yourphr#484.
func TestGuardedDialer_BlocksResolvedInternalAddresses(t *testing.T) {
	blocked := []string{
		"127.0.0.1:443",      // plain loopback
		"169.254.169.254:80", // cloud metadata — what 2130706433/0251.0376.0251.0376 resolve to
		"10.0.0.5:8080",      // RFC1918
		"192.168.1.10:8080",  // RFC1918
		"172.16.0.1:8080",    // RFC1918
		"169.254.1.1:80",     // link-local
		"0.0.0.0:80",         // unspecified
		"[::1]:443",          // IPv6 loopback
		"[fd00::1]:443",      // IPv6 unique-local
		"[fd00:ec2::254]:80", // IPv6 metadata
	}
	for _, addr := range blocked {
		t.Run(addr, func(t *testing.T) {
			err := callControl(t, false, addr)
			if err == nil {
				t.Fatalf("%s must be refused at dial time", addr)
			}
		})
	}
}

func TestGuardedDialer_AllowsPublicAddresses(t *testing.T) {
	for _, addr := range []string{"93.184.216.34:443", "8.8.8.8:53", "[2606:2800:220:1:248:1893:25c8:1946]:443"} {
		if err := callControl(t, false, addr); err != nil {
			t.Errorf("%s is public and must be allowed, got %v", addr, err)
		}
	}
}

// Fails CLOSED on anything unexpected. By the time Control runs the resolver has already produced
// an address, so a malformed one means something is wrong rather than something clever.
func TestGuardedDialer_FailsClosedOnUnparseableAddresses(t *testing.T) {
	for _, addr := range []string{"not-an-address", "", "example.com:443"} {
		if err := callControl(t, false, addr); err == nil {
			t.Errorf("%q must be refused rather than allowed by default", addr)
		}
	}
}

// The test escape hatch must still work, or every httptest-based test in the repo breaks.
func TestGuardedDialer_AllowInternalOptsOut(t *testing.T) {
	if err := callControl(t, true, "127.0.0.1:443"); err != nil {
		t.Fatalf("AllowInternalHosts must permit loopback for tests, got %v", err)
	}

	AllowInternalHostsForTest = true
	t.Cleanup(func() { AllowInternalHostsForTest = false })
	if err := callControl(t, false, "127.0.0.1:443"); err != nil {
		t.Fatalf("AllowInternalHostsForTest must permit loopback, got %v", err)
	}
}

// End to end: a real server on loopback, addressed by a form that defeats validateBaseURL, must not
// be reachable. This is the actual exploit from yourphr#484 rather than a unit test of a predicate.
func TestGuardedTransport_RefusesObfuscatedLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("this must never be reached"))
	}))
	defer srv.Close()

	_, port, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	// 2130706433 is 127.0.0.1 as a decimal integer. validateBaseURL accepts it, because
	// net.ParseIP("2130706433") is nil.
	if _, err := validateBaseURL("http://2130706433:"+port, false); err != nil {
		t.Fatalf("precondition: the pre-check is expected to accept this form, got %v", err)
	}

	client := &http.Client{Transport: GuardedTransport(false)}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://2130706433:"+port, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatal("the request reached a loopback server through an obfuscated address")
	}
	if !strings.Contains(err.Error(), "internal address") {
		t.Errorf("expected the guard's refusal, got %v", err)
	}
}

// A redirect is the case a base-URL check cannot see at all: the validated host is public, and the
// server sends the client somewhere internal.
func TestGuardedTransport_RefusesRedirectToInternalAddress(t *testing.T) {
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("internal service"))
	}))
	defer internal.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, internal.URL, http.StatusFound)
	}))
	defer redirector.Close()

	// The redirector itself is on loopback, so allow the first hop and let the guard judge the
	// second — which is the hop a base-URL check never inspects.
	client := &http.Client{Transport: GuardedTransport(false)}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, redirector.URL, nil)
	resp, err := client.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatal("a redirect reached an internal address")
	}
}
