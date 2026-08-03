package config

import (
	"os"
	"sort"
	"strings"
)

// PublicKeysConfigKey names the array of settings served without authentication.
const PublicKeysConfigKey = "public"

// PublicKeys returns the config keys this instance serves to callers with no login (#457).
//
// The direction of the list is the security property. It is an ALLOW-list: a key added anywhere
// else in the configuration is private until it is named here. A deny-list would invert the
// failure mode — a key nobody remembered to list would be published immediately, with nothing
// failing and nothing warning. The configuration holds jwt.issuer.key, relay.secret,
// database.encryption.key and the Blue Button client secrets, so "what happens to a key nobody
// thought about" is the question worth optimising.
//
// An instance may change the array in its custom config, INCLUDING adding keys. That is a
// deliberate operator decision: an instance is free to publish what it likes about itself, and
// forbidding it was judged too restrictive. PublicKeysPromotedBeyondDefault reports anything
// added so a warning can name it.
func PublicKeys(c Interface) []string {
	keys := c.GetStringSlice(PublicKeysConfigKey)

	seen := make(map[string]struct{}, len(keys))
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			continue
		}
		// Serving the list itself says nothing useful and reads as a mistake.
		if key == PublicKeysConfigKey {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// DefaultPublicKeys returns the shipped public set — the reviewed baseline in
// app-default-config.json, which lives in git and cannot change without a commit.
func DefaultPublicKeys() ([]string, error) {
	values, err := DefaultConfigValues()
	if err != nil {
		return nil, err
	}

	raw, ok := values[PublicKeysConfigKey].([]interface{})
	if !ok {
		return nil, nil
	}

	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if key, ok := item.(string); ok {
			out = append(out, strings.ToLower(strings.TrimSpace(key)))
		}
	}
	sort.Strings(out)
	return out, nil
}

// PublicKeysPromotedBeyondDefault lists keys this instance publishes that the shipped defaults
// do not. Feeds the startup warning and the Admin configuration screen (#458).
//
// Widening is allowed, so this is not an error path — but it is worth naming loudly, because the
// difference between "the server cannot serve that key" and "the server warns that it did" is
// the whole of the remaining protection.
func PublicKeysPromotedBeyondDefault(c Interface) ([]string, error) {
	shipped, err := DefaultPublicKeys()
	if err != nil {
		return nil, err
	}

	baseline := make(map[string]struct{}, len(shipped))
	for _, key := range shipped {
		baseline[key] = struct{}{}
	}

	var promoted []string
	for _, key := range PublicKeys(c) {
		if _, ok := baseline[key]; !ok {
			promoted = append(promoted, key)
		}
	}
	return promoted, nil
}

// operatorContactKeys are the "who runs this instance" settings a signed-in user is entitled to
// see regardless of the public array.
//
// The operator holds the records, so a patient with an account has a direct interest in reaching
// them — that is not a preference the public array should be able to withhold. Anonymous callers
// are a different matter, which is why operator.contact_email is not shipped as public (#459):
// an address on an unauthenticated endpoint gets harvested.
//
// Deliberately a short fixed list in code rather than a second config array. One array was the
// decision; this is not a second visibility surface an operator tunes, it is the floor below it.
var operatorContactKeys = []string{
	"operator.name",
	"operator.contact_email",
	"operator.contact_url",
}

// AuthenticatedInstanceKeys returns the keys served to a signed-in user: everything public, plus
// the operator contact block.
func AuthenticatedInstanceKeys(c Interface) []string {
	seen := map[string]struct{}{}
	var out []string

	for _, key := range PublicKeys(c) {
		seen[key] = struct{}{}
		out = append(out, key)
	}
	for _, key := range operatorContactKeys {
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}

	sort.Strings(out)
	return out
}

// SecretKeysConfigKey names the array of settings masked on the Admin Configuration screen.
const SecretKeysConfigKey = "secret"

// SecretKeys returns the config keys hidden on the Admin screen until explicitly revealed (#458).
//
// This is a DENY-list, the opposite shape to PublicKeys, and the asymmetry is deliberate. A key
// missing from `public` stays private, because a mistake there exposes a value to anonymous
// callers on the internet. A key missing from here is merely shown to an admin who is already
// authenticated, looking at their own screen — so the safe default is to show, and the list names
// the handful of values worth hiding.
//
// Getting this backwards is not hypothetical: masking everything outside `public` hid 47 of 51
// settings, including the listen port and the log level. That does not protect anything; it
// teaches an operator to click reveal without reading, which is worse than showing the value.
func SecretKeys(c Interface) []string {
	keys := c.GetStringSlice(SecretKeysConfigKey)

	seen := make(map[string]struct{}, len(keys))
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// IsSecretKey reports whether a key is masked on the Admin screen.
func IsSecretKey(c Interface, key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	for _, secret := range SecretKeys(c) {
		if secret == key {
			return true
		}
	}
	return false
}

// EnvVarFor maps a config key to the environment variable that overrides it, mirroring the
// prefix and separator rules in Init: operator.contact_email -> YOURPHR_OPERATOR_CONTACT_EMAIL.
func EnvVarFor(key string) string {
	return "YOURPHR_" + strings.ToUpper(strings.NewReplacer(".", "_", "-", "_").Replace(strings.TrimSpace(key)))
}

// IsSetByEnvironment reports whether this key's value comes from the process environment.
//
// Matters because env OUTRANKS the custom config store on startup. A value written to
// app-custom-config.json while the corresponding variable is set takes effect immediately —
// viper's Set() is the top layer — and then silently reverts on the next restart, when the store
// is merged into the config layer beneath env.
//
// An edit that appears to work and quietly undoes itself is worse than one that is refused, so
// callers use this to refuse it and say which variable is in charge.
//
// Reading the environment directly is correct here: this package is the config accessor, and the
// question is literally "is this variable present" rather than "what is the effective value".
func IsSetByEnvironment(key string) bool {
	_, present := os.LookupEnv(EnvVarFor(key))
	return present
}
