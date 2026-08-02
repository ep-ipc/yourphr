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

// ValueSource says WHY a resolved relay value is what it is (#402).
//
// The operator-facing question is rarely "is this URL right" — it is "is my configuration being
// read at all". A value that silently fell back to a default is indistinguishable from one that was
// set on purpose, and that ambiguity is what made #399 and #397 hard to diagnose.
type ValueSource string

const (
	// SourceConfigured — the key itself carries a value.
	SourceConfigured ValueSource = "configured"
	// SourceInherited — public_url was not set, so the (public https) poll URL was reused.
	SourceInherited ValueSource = "inherited"
	// SourceDefault — nothing was set; this is the built-in project relay.
	SourceDefault ValueSource = "default"
	// SourceUnset — no value and no default (only meaningful for the secret).
	SourceUnset ValueSource = "unset"
)

// ResolvedValue is one effective setting plus where it came from.
//
// ConfigKey/EnvVar name WHERE the value would be set, not which mechanism supplied it. Viper cannot
// reliably distinguish config.yaml from an environment variable once a default is registered
// (IsSet returns true for a defaulted key), so claiming a specific mechanism would be a guess.
// Naming both forms is honest and is what an operator needs in order to go change it.
type ResolvedValue struct {
	Value     string      `json:"value"`
	Source    ValueSource `json:"source"`
	ConfigKey string      `json:"config_key,omitempty"`
	EnvVar    string      `json:"env_var,omitempty"`
}

// Description is the whole effective relay configuration, for the admin UI (#402).
// It deliberately carries no secret value — only whether one is present.
type Description struct {
	// CallbackURL is the OAuth redirect_uri this deployment sends to providers — the value the
	// operator must register with each FHIR vendor.
	CallbackURL string        `json:"callback_url"`
	PublicURL   ResolvedValue `json:"public_url"`
	PollURL     ResolvedValue `json:"poll_url"`
	SecretSet   bool          `json:"secret_set"`
	SecretHint  ResolvedValue `json:"secret"`
	// Ready is true when a relay-poll connect can actually complete: a secret is configured.
	Ready bool `json:"ready"`
}

// EnvVarFor maps a viper config key to the environment variable that overrides it, mirroring the
// prefix + separator rules in backend/pkg/config (relay.public_url -> YOURPHR_RELAY_PUBLIC_URL).
func EnvVarFor(configKey string) string {
	return "YOURPHR_" + strings.ToUpper(strings.NewReplacer(".", "_", "-", "_").Replace(configKey))
}

// Describe reports the effective relay configuration and the provenance of each value, so an
// operator can see BEFORE starting a connection whether their settings are actually in effect.
func Describe(cfg Getter) Description {
	rawPublic := strings.TrimRight(strings.TrimSpace(cfg.GetString(ConfigKeyPublicURL)), "/")
	rawPoll := strings.TrimRight(strings.TrimSpace(cfg.GetString(ConfigKeyURL)), "/")
	secret := cfg.GetString(ConfigKeySecret)

	// Mirror ResolvePublicBaseURL's branches so the reported source can never disagree with the
	// value actually used. (A test pins them together.)
	public := ResolvedValue{ConfigKey: ConfigKeyPublicURL, EnvVar: EnvVarFor(ConfigKeyPublicURL)}
	switch {
	case rawPublic != "":
		public.Value, public.Source = rawPublic, SourceConfigured
	case rawPoll != "" && strings.HasPrefix(strings.ToLower(rawPoll), "https://"):
		// Inherited from the poll URL — so point the operator at THAT key, not at public_url.
		public.Value, public.Source = rawPoll, SourceInherited
		public.ConfigKey, public.EnvVar = ConfigKeyURL, EnvVarFor(ConfigKeyURL)
	default:
		public.Value, public.Source = DefaultBaseURL, SourceDefault
		public.ConfigKey, public.EnvVar = "", ""
	}

	poll := ResolvedValue{ConfigKey: ConfigKeyURL, EnvVar: EnvVarFor(ConfigKeyURL)}
	if rawPoll != "" {
		poll.Value, poll.Source = rawPoll, SourceConfigured
	} else {
		poll.Value, poll.Source = DefaultBaseURL, SourceDefault
		poll.ConfigKey, poll.EnvVar = "", ""
	}

	secretHint := ResolvedValue{ConfigKey: ConfigKeySecret, EnvVar: EnvVarFor(ConfigKeySecret)}
	if secret != "" {
		secretHint.Source = SourceConfigured // NOTE: Value stays empty — never echo the secret.
	} else {
		secretHint.Source = SourceUnset
	}

	return Description{
		CallbackURL: public.Value + CallbackPath,
		PublicURL:   public,
		PollURL:     poll,
		SecretSet:   secret != "",
		SecretHint:  secretHint,
		Ready:       secret != "",
	}
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

// FromEnv was removed in #455. It read YOURPHR_RELAY_* straight from the process environment,
// which saw .env/.env_custom but NOT config.yaml — so a relay configured in the config file was
// invisible to it. FromConfig above is the replacement and had already superseded it; FromEnv
// had no remaining callers.

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
