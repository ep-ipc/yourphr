package config

import (
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
