package config_test

import (
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

func TestResolveEnvRefs_BareReferenceUsesTheEnvironment(t *testing.T) {
	t.Setenv("YOURPHR_TEST_SECRET", "from-env")

	out, err := config.ResolveEnvRefs(map[string]interface{}{"relay.secret": "$YOURPHR_TEST_SECRET"})
	require.NoError(t, err)
	require.Equal(t, "from-env", out["relay.secret"])
}

// Strict on purpose: a bare $VAR says the value comes from somewhere. Silently becoming empty
// would start the instance in a state nobody chose — a relay with no shared secret, say.
func TestResolveEnvRefs_BareReferenceFailsWhenUnset(t *testing.T) {
	_, err := config.ResolveEnvRefs(map[string]interface{}{"relay.secret": "$YOURPHR_DEFINITELY_UNSET"})

	require.Error(t, err)
	require.Contains(t, err.Error(), "relay.secret", "the error must name the config key")
	require.Contains(t, err.Error(), "YOURPHR_DEFINITELY_UNSET", "and the variable to set")
	require.Contains(t, err.Error(), "${", "and point at the optional form")
}

// Lenient on purpose: ${VAR} means "optional, and here is where it would come from". That is
// what lets the shipped file document a secret without holding one, while a stock install still
// starts and generates its own key.
func TestResolveEnvRefs_EmbeddedReferenceIsEmptyWhenUnset(t *testing.T) {
	out, err := config.ResolveEnvRefs(map[string]interface{}{"jwt.issuer.key": "${YOURPHR_DEFINITELY_UNSET}"})

	require.NoError(t, err)
	require.Equal(t, "", out["jwt.issuer.key"])
}

func TestResolveEnvRefs_EmbeddedReferenceSubstitutesInPlace(t *testing.T) {
	t.Setenv("DATA_ROOT", "/srv/yourphr")

	out, err := config.ResolveEnvRefs(map[string]interface{}{"database.location": "${DATA_ROOT}/fasten.db"})
	require.NoError(t, err)
	require.Equal(t, "/srv/yourphr/fasten.db", out["database.location"])
}

func TestResolveEnvRefs_LeavesOrdinaryValuesAlone(t *testing.T) {
	out, err := config.ResolveEnvRefs(map[string]interface{}{
		"web.listen.port":   "8080",
		"metrics.port":      9091,
		"metrics.enabled":   false,
		"operator.name":     "Costs $5 a month",
		"backup.allowed":    []string{"/nas-backup"},
		"database.location": "/opt/fasten/db/fasten.db",
	})
	require.NoError(t, err)

	require.Equal(t, "8080", out["web.listen.port"])
	require.Equal(t, 9091, out["metrics.port"])
	require.Equal(t, false, out["metrics.enabled"])
	require.Equal(t, "/opt/fasten/db/fasten.db", out["database.location"])
	require.Equal(t, []string{"/nas-backup"}, out["backup.allowed"])
}

// A lone "$" or a dollar mid-string is not a reference. Treating it as one would mangle a
// perfectly good password or a price.
func TestResolveEnvRefs_DoesNotMisreadStrayDollars(t *testing.T) {
	out, err := config.ResolveEnvRefs(map[string]interface{}{
		"operator.name":  "$",
		"operator.title": "Pay $ here",
		"relay.secret":   "abc$def",
	})
	require.NoError(t, err)

	require.Equal(t, "$", out["operator.name"])
	require.Equal(t, "Pay $ here", out["operator.title"])
	require.Equal(t, "abc$def", out["relay.secret"])
}

// An operator who puts a real secret in the custom file must still get exactly that value —
// references are an option, not a requirement.
func TestResolveEnvRefs_LiteralSecretsPassThrough(t *testing.T) {
	out, err := config.ResolveEnvRefs(map[string]interface{}{
		"jwt.issuer.key": "a-real-64-character-looking-key-value",
	})
	require.NoError(t, err)
	require.Equal(t, "a-real-64-character-looking-key-value", out["jwt.issuer.key"])
}
