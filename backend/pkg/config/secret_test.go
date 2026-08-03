package config_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

// redaction is process-global, so every test that changes it restores it.
func withRedaction(t *testing.T, redact bool) {
	t.Helper()
	previous := config.SecretsAreRedacted()
	config.SetSecretRedaction(redact)
	t.Cleanup(func() { config.SetSecretRedaction(previous) })
}

// The zero value must redact. A flag that leaked unless something remembered to initialise it
// would be the wrong way round for the mistake this type exists to prevent.
func TestSecret_RedactsByDefault(t *testing.T) {
	require.True(t, config.SecretsAreRedacted(),
		"redaction must be the default state of the package, with no setup")

	s := config.Secret("super-secret-signing-key")
	require.Equal(t, config.RedactedPlaceholder, s.String())
}

// The point of the type: it survives careless formatting.
func TestSecret_RedactsUnderEveryFormatVerb(t *testing.T) {
	withRedaction(t, true)
	s := config.Secret("super-secret-signing-key")

	for _, format := range []string{"%s", "%v", "%+v", "%#v", "%q"} {
		out := fmt.Sprintf(format, s)
		require.NotContainsf(t, out, "super-secret-signing-key",
			"%s leaked the value: %s", format, out)
	}
}

// The realistic accident: logging a whole struct while debugging.
func TestSecret_RedactsInsideAStruct(t *testing.T) {
	withRedaction(t, true)

	cfg := struct {
		URL    string
		Secret config.Secret
	}{URL: "https://relay.example", Secret: "super-secret-relay-secret"}

	for _, format := range []string{"%v", "%+v", "%#v"} {
		out := fmt.Sprintf(format, cfg)
		require.NotContainsf(t, out, "super-secret-relay-secret", "%s leaked: %s", format, out)
		require.Containsf(t, out, "https://relay.example", "%s should still show ordinary fields", format)
	}
}

// A Secret must not reach an API response even on a field nobody tagged json:"-".
func TestSecret_RedactsInJSON(t *testing.T) {
	withRedaction(t, true)

	payload := struct {
		Name   string        `json:"name"`
		Secret config.Secret `json:"secret"`
	}{Name: "relay", Secret: "super-secret-relay-secret"}

	encoded, err := json.Marshal(payload)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "super-secret-relay-secret")
	require.Contains(t, string(encoded), config.RedactedPlaceholder)
}

// Reading in is normal; writing out is the risk. Asymmetric on purpose.
func TestSecret_UnmarshalsFromAPlainString(t *testing.T) {
	var payload struct {
		Secret config.Secret `json:"secret"`
	}
	require.NoError(t, json.Unmarshal([]byte(`{"secret":"from-config"}`), &payload))
	require.Equal(t, "from-config", payload.Secret.Expose())
}

func TestSecret_ExposeReturnsTheRealValue(t *testing.T) {
	withRedaction(t, true)
	require.Equal(t, "super-secret-signing-key", config.Secret("super-secret-signing-key").Expose())
}

// "Is a secret configured?" must be answerable without revealing it, or callers compare strings.
func TestSecret_IsSet(t *testing.T) {
	require.True(t, config.Secret("x").IsSet())
	require.False(t, config.Secret("").IsSet())
}

// Persisting [REDACTED] would be a spectacular own goal.
func TestSecret_DatabaseValueIsNeverRedacted(t *testing.T) {
	withRedaction(t, true)

	value, err := config.Secret("super-secret-relay-secret").Value()
	require.NoError(t, err)
	require.Equal(t, "super-secret-relay-secret", value)
}

func TestSecret_ScanAcceptsWhatDriversReturn(t *testing.T) {
	var s config.Secret

	require.NoError(t, s.Scan("from-string"))
	require.Equal(t, "from-string", s.Expose())

	require.NoError(t, s.Scan([]byte("from-bytes")))
	require.Equal(t, "from-bytes", s.Expose())

	require.NoError(t, s.Scan(nil))
	require.False(t, s.IsSet())

	require.Error(t, s.Scan(42), "an unexpected driver type must not silently become a secret")
}

// The debugging escape hatch, which is why log.redact_secrets exists.
func TestSecret_RedactionCanBeTurnedOffForDebugging(t *testing.T) {
	withRedaction(t, false)

	s := config.Secret("super-secret-signing-key")
	require.Equal(t, "super-secret-signing-key", s.String())
	require.False(t, config.SecretsAreRedacted())

	encoded, err := json.Marshal(s)
	require.NoError(t, err)
	require.Contains(t, string(encoded), "super-secret-signing-key")
}

func TestGetSecret_ReadsFromConfig(t *testing.T) {
	withRedaction(t, true)
	c := newTestConfig(t)
	c.Set("relay.secret", "from-config")

	s := config.GetSecret(c, "relay.secret")
	require.Equal(t, "from-config", s.Expose())
	require.Equal(t, config.RedactedPlaceholder, s.String())
}

// The setting must exist in the catalogue and default to redacting.
func TestRedactSecretsSettingDefaultsOn(t *testing.T) {
	c := newTestConfig(t)
	require.True(t, c.GetBool("log.redact_secrets"))
}
