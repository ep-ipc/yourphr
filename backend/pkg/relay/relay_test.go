package relay

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const testSecret = "test-secret"

func newClient(srv *httptest.Server) Client {
	return Client{BaseURL: srv.URL, Secret: testSecret, HTTPClient: srv.Client()}
}

func TestPollSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pending" {
			t.Errorf("path = %q, want /pending", r.URL.Path)
		}
		if got := r.Header.Get("X-Yourphr-Token"); got != testSecret {
			t.Errorf("token header = %q, want %q", got, testSecret)
		}
		if got := r.URL.Query().Get("state"); got != "S1" {
			t.Errorf("state = %q, want S1", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"ABC123"}`))
	}))
	defer srv.Close()

	code, err := newClient(srv).Poll(context.Background(), "S1")
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if code != "ABC123" {
		t.Errorf("code = %q, want ABC123", code)
	}
}

func TestPollNotReady(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := newClient(srv).Poll(context.Background(), "S1")
	if !errors.Is(err, ErrNotReady) {
		t.Errorf("err = %v, want ErrNotReady", err)
	}
}

func TestPollUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer srv.Close()

	if _, err := newClient(srv).Poll(context.Background(), "S1"); err == nil || errors.Is(err, ErrNotReady) {
		t.Errorf("expected a hard auth error, got %v", err)
	}
}

func TestPollValidation(t *testing.T) {
	if _, err := (Client{}).Poll(context.Background(), "S1"); err == nil {
		t.Error("expected error when BaseURL/Secret unset")
	}
	if _, err := (Client{BaseURL: "http://x", Secret: "s"}).Poll(context.Background(), ""); err == nil {
		t.Error("expected error when state empty")
	}
}

func TestPollUntilSucceedsAfterRetries(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 404 for the first two polls, then the code on the third.
		if atomic.AddInt32(&hits, 1) < 3 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"code":"LATE"}`))
	}))
	defer srv.Close()

	code, err := newClient(srv).PollUntil(context.Background(), "S1", 5*time.Millisecond, 2*time.Second)
	if err != nil {
		t.Fatalf("PollUntil: %v", err)
	}
	if code != "LATE" {
		t.Errorf("code = %q, want LATE", code)
	}
	if atomic.LoadInt32(&hits) < 3 {
		t.Errorf("expected at least 3 polls, got %d", hits)
	}
}

func TestPollUntilTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := newClient(srv).PollUntil(context.Background(), "S1", 5*time.Millisecond, 40*time.Millisecond)
	if err == nil || errors.Is(err, ErrNotReady) {
		t.Errorf("expected timeout error, got %v", err)
	}
}

// fakeGetter is a minimal config.Interface stand-in for the Getter subset this package uses.
type fakeGetter map[string]string

func (f fakeGetter) GetString(key string) string { return f[key] }

// TestResolvePublicBaseURL covers the split introduced by #399: the URL the backend POLLS can be
// cluster-internal, while the URL the PROVIDER redirects the browser to must be public.
func TestResolvePublicBaseURL(t *testing.T) {
	tests := []struct {
		name      string
		publicURL string
		pollURL   string
		want      string
	}{
		{"neither set falls back to the project relay", "", "", DefaultBaseURL},
		{"public url wins", "https://relay.example.org", "http://yourphr-relay.yourphr.svc.cluster.local:8080", "https://relay.example.org"},
		{"public url wins over a public poll url too", "https://relay.example.org", "https://other.example.org", "https://relay.example.org"},
		{"public https poll url is inherited", "", "https://relay.example.org", "https://relay.example.org"},
		{"internal http poll url is NOT inherited", "", "http://yourphr-relay.yourphr.svc.cluster.local:8080", DefaultBaseURL},
		{"trailing slash is trimmed", "https://relay.example.org/", "", "https://relay.example.org"},
		{"whitespace is trimmed", "  https://relay.example.org  ", "", "https://relay.example.org"},
		{"scheme match is case-insensitive", "", "HTTPS://relay.example.org", "HTTPS://relay.example.org"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ResolvePublicBaseURL(tt.publicURL, tt.pollURL); got != tt.want {
				t.Errorf("ResolvePublicBaseURL(%q, %q) = %q, want %q", tt.publicURL, tt.pollURL, got, tt.want)
			}
		})
	}
}

// TestCallbackURLFromConfig is the #399 regression: a deployment that polls an internal relay must
// still hand the provider its PUBLIC callback URL.
func TestCallbackURLFromConfig(t *testing.T) {
	cfg := fakeGetter{
		ConfigKeyURL:       "http://yourphr-relay.yourphr.svc.cluster.local:8080",
		ConfigKeyPublicURL: "https://relay.example.org",
	}
	if got, want := CallbackURL(cfg), "https://relay.example.org/callback"; got != want {
		t.Errorf("CallbackURL = %q, want %q", got, want)
	}
}

func TestFromConfig(t *testing.T) {
	t.Run("requires a secret", func(t *testing.T) {
		if _, err := FromConfig(fakeGetter{ConfigKeyURL: "https://relay.example.org"}); err == nil {
			t.Fatal("expected an error when the shared secret is unset")
		}
	})
	t.Run("polls the configured url", func(t *testing.T) {
		c, err := FromConfig(fakeGetter{ConfigKeyURL: "http://internal:8080", ConfigKeySecret: testSecret})
		if err != nil {
			t.Fatalf("FromConfig: %v", err)
		}
		if c.BaseURL != "http://internal:8080" || c.Secret != testSecret {
			t.Errorf("got %+v", c)
		}
	})
	t.Run("defaults the poll url", func(t *testing.T) {
		c, err := FromConfig(fakeGetter{ConfigKeySecret: testSecret})
		if err != nil {
			t.Fatalf("FromConfig: %v", err)
		}
		if c.BaseURL != DefaultBaseURL {
			t.Errorf("BaseURL = %q, want %q", c.BaseURL, DefaultBaseURL)
		}
	})
}
