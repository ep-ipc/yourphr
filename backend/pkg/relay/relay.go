// Package relay is a tiny client for the YourPHR SMART on FHIR OAuth store-and-poll
// relay (EPIC #20, issue #50). The relay is a small public service that receives the
// provider's authorization redirect at /callback (storing {state -> code} briefly) and
// serves a shared-secret-gated /pending endpoint that the (internal) YourPHR backend
// polls to retrieve the code. The backend then completes the token exchange itself; the
// relay never sees tokens. See backend/cmd/relay and docs/planning/smart-on-fhir.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// DefaultBaseURL is the project's dev/demo relay (overridable via YOURPHR_RELAY_URL).
const DefaultBaseURL = "https://relay.nerdsbythehour.com"

// CallbackPath is the relay route the provider redirects the browser to with ?code=&state=.
// PublicBaseURL()+CallbackPath is the OAuth redirect_uri registered with the FHIR vendor.
const CallbackPath = "/callback"

// Config keys (viper; env is the same key upper-cased with the YOURPHR_ prefix and '.'->'_', so
// relay.public_url -> YOURPHR_RELAY_PUBLIC_URL). See backend/pkg/config.
const (
	ConfigKeyURL       = "relay.url"        // where the backend POLLS /pending — may be cluster-internal
	ConfigKeyPublicURL = "relay.public_url" // public origin the PROVIDER redirects to — must be reachable from the user's browser
	ConfigKeySecret    = "relay.secret"     // shared secret gating /pending
)

// Getter is the subset of config.Interface this package needs. Declared locally so the relay
// client stays dependency-free (and trivially fakeable in tests).
type Getter interface {
	GetString(key string) string
}

// ResolvePublicBaseURL returns the public origin the OAuth provider redirects to, given the
// configured public URL and the (possibly internal) poll URL.
//
// These are two different things and a self-hosted deployment usually needs both (issue #399):
// the backend may poll the relay over cluster-internal DNS (http://yourphr-relay.<ns>.svc:8080)
// while the provider must redirect the user's browser to a public https origin. So publicURL
// wins; pollURL is only inherited when it is itself public https (the common single-URL setup);
// otherwise fall back to the project relay.
func ResolvePublicBaseURL(publicURL, pollURL string) string {
	if u := strings.TrimRight(strings.TrimSpace(publicURL), "/"); u != "" {
		return u
	}
	if u := strings.TrimRight(strings.TrimSpace(pollURL), "/"); u != "" && strings.HasPrefix(strings.ToLower(u), "https://") {
		return u
	}
	return DefaultBaseURL
}

// PublicBaseURL resolves the public relay origin from config (relay.public_url, else relay.url).
func PublicBaseURL(cfg Getter) string {
	return ResolvePublicBaseURL(cfg.GetString(ConfigKeyPublicURL), cfg.GetString(ConfigKeyURL))
}

// CallbackURL is the effective OAuth redirect_uri for this deployment — the value the operator
// must register with each FHIR vendor. Derived server-side; never supplied by the browser.
func CallbackURL(cfg Getter) string {
	return PublicBaseURL(cfg) + CallbackPath
}

// FromConfig builds a polling Client from config, so the relay honors config.yaml / .env /
// .env_custom / YOURPHR_* env identically to every other setting. It returns an error if the
// shared secret is unset, so callers can fall back to a directly-supplied code.
func FromConfig(cfg Getter) (Client, error) {
	secret := cfg.GetString(ConfigKeySecret)
	if secret == "" {
		return Client{}, errors.New("relay: YOURPHR_RELAY_SECRET (relay.secret) is not set")
	}
	baseURL := strings.TrimSpace(cfg.GetString(ConfigKeyURL))
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return Client{BaseURL: baseURL, Secret: secret}, nil
}

// ErrNotReady means the relay has no code for this state yet (HTTP 404) — poll again.
var ErrNotReady = errors.New("relay: code not yet available")

// Client polls a YourPHR relay's /pending endpoint.
type Client struct {
	BaseURL string // e.g. https://relay.nerdsbythehour.com
	Secret  string // shared secret presented as X-Yourphr-Token; gates /pending

	// HTTPClient is optional; defaults to http.DefaultClient. Override in tests.
	HTTPClient *http.Client
}

// FromEnv builds a Client from YOURPHR_RELAY_URL (default DefaultBaseURL) and the required
// YOURPHR_RELAY_SECRET (the same shared secret configured on the relay). It returns an error
// if the secret is unset, so callers can fall back to a directly-supplied code.
//
// Prefer FromConfig where a config.Interface is available: raw env reads see .env/.env_custom
// (those are loaded into the process environment at startup) but NOT config.yaml.
func FromEnv() (Client, error) {
	secret := os.Getenv("YOURPHR_RELAY_SECRET")
	if secret == "" {
		return Client{}, errors.New("relay: YOURPHR_RELAY_SECRET is not set")
	}
	baseURL := os.Getenv("YOURPHR_RELAY_URL")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return Client{BaseURL: baseURL, Secret: secret}, nil
}

func (c Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

// Poll does a single GET /pending?state=. It returns the authorization code on success,
// ErrNotReady if the code has not arrived (or already expired/consumed), or another error.
func (c Client) Poll(ctx context.Context, state string) (string, error) {
	if c.BaseURL == "" || c.Secret == "" {
		return "", errors.New("relay: BaseURL and Secret are required")
	}
	if state == "" {
		return "", errors.New("relay: state is required")
	}

	endpoint := strings.TrimRight(c.BaseURL, "/") + "/pending?state=" + url.QueryEscape(state)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-Yourphr-Token", c.Secret)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("relay: request failed: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			return "", fmt.Errorf("relay: decoding response: %w", err)
		}
		if body.Code == "" {
			return "", errors.New("relay: response contained an empty code")
		}
		return body.Code, nil
	case http.StatusNotFound:
		return "", ErrNotReady
	case http.StatusUnauthorized:
		return "", errors.New("relay: unauthorized — the shared secret does not match the relay's")
	default:
		return "", fmt.Errorf("relay: unexpected status %d", resp.StatusCode)
	}
}

// PollUntil polls every interval until the code arrives, the context is cancelled, or timeout
// elapses. It tries immediately, then on each tick. The relay holds codes for only ~60s, so a
// timeout beyond that is pointless.
func (c Client) PollUntil(ctx context.Context, state string, interval, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	for {
		code, err := c.Poll(ctx, state)
		if err == nil {
			return code, nil
		}
		if !errors.Is(err, ErrNotReady) {
			return "", err
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("relay: timed out waiting for authorization code: %w", ctx.Err())
		case <-time.After(interval):
		}
	}
}
