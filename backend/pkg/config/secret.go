package config

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"sync/atomic"
)

// Secret is a string that refuses to print itself.
//
// Every secret in this codebase — signing keys, relay secrets, provider client secrets, OAuth
// access and refresh tokens — is a plain string today, protected by remembering to write
// `json:"-"` on the field and not to pass it to a log call. That works until someone logs a
// struct, adds a debug line, or returns a model that used to be internal.
//
// A Secret cannot be printed by accident:
//
//	logger.Infof("relay config: %+v", cfg)   // relay.secret prints as [REDACTED]
//	json.Marshal(entry)                      // serialises as "[REDACTED]"
//
// Reading the real value requires saying so:
//
//	client.Secret = cfg.RelaySecret.Expose()
//
// Expose is deliberately verbose and greppable — `grep -rn '\.Expose()'` lists every place a
// secret leaves its wrapper, which is a short and reviewable list.
//
// LIMITS, stated because a wrapper invites over-trust. This is leak prevention, not encryption:
// the value sits in memory as plain bytes, is visible to a debugger or a core dump, and anything
// calling Expose can do what it likes with the result. It removes a class of accident; it does
// not defend against an attacker with the process.
type Secret string

// exposeSecrets disables redaction when true.
//
// Deliberately phrased so the ZERO VALUE REDACTS. A boolean called "redact" defaulting to false
// would mean any path that forgot to initialise it leaked, which is the wrong way round for the
// mistake this type exists to prevent.
var exposeSecrets atomic.Bool

// SetSecretRedaction turns redaction on or off. Called once at startup from log.redact_secrets.
//
// Off is a debugging aid: sometimes the only way to find out why a provider rejects a token is
// to see the token. It is not a setting to leave off — see the startup warning in the caller.
func SetSecretRedaction(redact bool) { exposeSecrets.Store(!redact) }

// SecretsAreRedacted reports the current setting, for the startup warning and for tests.
func SecretsAreRedacted() bool { return !exposeSecrets.Load() }

// RedactedPlaceholder is what a Secret prints instead of its value.
const RedactedPlaceholder = "[REDACTED]"

// String satisfies fmt.Stringer, so %s and %v redact.
func (s Secret) String() string {
	if exposeSecrets.Load() {
		return string(s)
	}
	return RedactedPlaceholder
}

// GoString satisfies fmt.GoStringer, so %#v redacts too — otherwise the "print the struct for
// debugging" reflex bypasses String entirely.
func (s Secret) GoString() string {
	if exposeSecrets.Load() {
		return fmt.Sprintf("%q", string(s))
	}
	return RedactedPlaceholder
}

// MarshalJSON redacts, so a Secret cannot reach an API response even on a field somebody forgot
// to tag `json:"-"`.
func (s Secret) MarshalJSON() ([]byte, error) {
	if exposeSecrets.Load() {
		return []byte(fmt.Sprintf("%q", string(s))), nil
	}
	return []byte(fmt.Sprintf("%q", RedactedPlaceholder)), nil
}

// UnmarshalJSON accepts a plain string, so a Secret can be read from a config file or a request
// body. Asymmetric with MarshalJSON on purpose: reading in is normal, writing out is the risk.
func (s *Secret) UnmarshalJSON(data []byte) error {
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*s = Secret(raw)
	return nil
}

// Expose returns the real value. The only way to get it, and named so a reviewer can find every
// one of them.
func (s Secret) Expose() string { return string(s) }

// IsSet reports whether there is a value, without revealing it — for "is a secret configured?"
// checks that would otherwise tempt someone into comparing against the string.
func (s Secret) IsSet() bool { return string(s) != "" }

// Value implements driver.Valuer so a Secret can back a database column, storing the real value.
// Persisting [REDACTED] would be a spectacular own goal, so this deliberately ignores redaction.
func (s Secret) Value() (driver.Value, error) { return string(s), nil }

// Scan implements sql.Scanner for the same reason.
func (s *Secret) Scan(value interface{}) error {
	switch v := value.(type) {
	case nil:
		*s = ""
	case string:
		*s = Secret(v)
	case []byte:
		*s = Secret(v)
	default:
		return fmt.Errorf("cannot scan %T into a Secret", value)
	}
	return nil
}

// GetSecret reads a configuration value as a Secret.
func GetSecret(c Interface, key string) Secret { return Secret(c.GetString(key)) }
