package smart

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

// CodeQL flags client.go's Discover and capability_fetch.go's patientIDFrom as request-forgery
// (alerts 62 and 63, yourphr#548): the URL of each request derives from a user-supplied value. It
// cannot see the control, because the control lives in a DialContext rather than at the call site.
//
// These tests assert what CodeQL cannot: that the exact transport those call sites use refuses
// internal addresses, and that both entry points refuse a loopback base URL outright. The existing
// TestGuardedDialer_* cases prove the dialer itself; what was missing was proof that these two
// paths are wired to it.

// The transport is the boundary, so this drives its DialContext directly — the same function the
// flagged call sites reach through c.httpClient().
func TestFlaggedCallSitesUseAGuardedTransport(t *testing.T) {
	c := Config{FHIRBaseURL: "https://fhir.example.com"}

	client := c.httpClient()
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("httpClient() must carry a guarded *http.Transport, got %T", client.Transport)
	}
	if transport.DialContext == nil {
		t.Fatal("the transport has no DialContext, so nothing is guarding the connection")
	}

	for _, address := range []string{
		"127.0.0.1:80",
		"169.254.169.254:80", // cloud metadata: the classic SSRF prize
		"10.0.0.5:8080",
		"[::1]:443",
	} {
		// Bounded, so that a run with the guard REMOVED fails in two seconds with a readable
		// message instead of hanging until the whole package times out. A guard that is working
		// refuses before any connection is attempted, so this timeout never fires in a green run.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		conn, err := transport.DialContext(ctx, "tcp", address)
		cancel()
		if err == nil {
			conn.Close()
			t.Errorf("the transport connected to %s", address)
			continue
		}
		if !strings.Contains(err.Error(), "internal address") {
			t.Errorf("dialing %s: expected the guard's refusal, got %v", address, err)
		}
	}
}

// (A public address must still be allowed, or the guard is just a broken client — that is
// TestGuardedDialer_AllowsPublicAddresses in ssrf_dial_test.go, which decides without dialling.
// Dialling a real public host here cost 30s of CI time waiting for a connection that will never
// come, and made the suite depend on network access.)

// Discover is alert 63's call site. A loopback base URL must be refused before any request is made.
//
// Each case asserts WHICH guard refused, not merely that something did. Without that, removing the
// hostname check still looks green: "localhost" resolves to 127.0.0.1, so the IP guard catches it
// and the test cannot tell the difference. Defence in depth is good; a test that cannot see through
// it is not.
func TestDiscoverRefusesAnInternalBaseURL(t *testing.T) {
	cases := []struct {
		base   string
		reason string
	}{
		{"http://localhost/fhir", "not allowed (internal/loopback)"},
		{"http://printer.local/fhir", "not allowed (internal/loopback)"},
		{"http://db.internal/fhir", "not allowed (internal/loopback)"},
		{"http://127.0.0.1:8080/fhir", "disallowed internal address"},
		{"http://169.254.169.254/fhir", "disallowed internal address"},
		{"http://[::1]/fhir", "disallowed internal address"},
		{"http://10.0.0.5/fhir", "disallowed internal address"},
		{"file:///etc/passwd", "must be http(s)"},
	}

	for _, tc := range cases {
		c := Config{FHIRBaseURL: tc.base}
		_, err := c.Discover(context.Background())
		if err == nil {
			t.Errorf("Discover(%q) was allowed", tc.base)
			continue
		}
		if !strings.Contains(err.Error(), tc.reason) {
			t.Errorf("Discover(%q): expected %q, got %v", tc.base, tc.reason, err)
		}
	}
}

// DiscoverPatientID reaches alert 62's call site (patientIDFrom). Same requirement.
func TestDiscoverPatientIDRefusesAnInternalBaseURL(t *testing.T) {
	c := Config{FHIRBaseURL: "http://169.254.169.254/fhir", ClientID: "x"}
	endpoints := Endpoints{
		Authorization: "https://auth.example.com/authorize",
		Token:         "https://auth.example.com/token",
	}

	_, err := c.DiscoverPatientID(context.Background(), endpoints, &oauth2.Token{AccessToken: "t"})
	if err == nil {
		t.Fatal("DiscoverPatientID was allowed to fetch from cloud metadata")
	}
	if !strings.Contains(err.Error(), "disallowed internal address") {
		t.Errorf("expected the base-URL guard's refusal, got %v", err)
	}
}

// The escape hatch is process-wide and exported, so anything importing this package could switch
// the guard off for the whole process. Nothing outside a _test.go file assigns it today; this
// asserts the default, so a change that flips it has to change a test that says why.
func TestAllowInternalHostsForTestDefaultsOff(t *testing.T) {
	if AllowInternalHostsForTest {
		t.Fatal("AllowInternalHostsForTest is on by default — the SSRF guard is disabled process-wide")
	}
}
