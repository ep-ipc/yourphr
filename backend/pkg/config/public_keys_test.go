package config_test

import (
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

func TestPublicKeys_ShippedDefault(t *testing.T) {
	c := newTestConfig(t)

	// contact_email is deliberately NOT here (#459) — an address on an unauthenticated endpoint
	// gets harvested. Signed-in users still get it via AuthenticatedInstanceKeys.
	require.Equal(t, []string{
		"operator.contact_url",
		"operator.name",
		"theme.name",
	}, config.PublicKeys(c))
	require.NotContains(t, config.PublicKeys(c), "operator.contact_email")
}

// The list is an ALLOW-list. Nothing outside it is public, however many other keys exist.
func TestPublicKeys_SecretsAreNotPublicByDefault(t *testing.T) {
	c := newTestConfig(t)

	public := map[string]bool{}
	for _, key := range config.PublicKeys(c) {
		public[key] = true
	}

	for _, secret := range []string{
		"jwt.issuer.key",
		"relay.secret",
		"database.encryption.key",
		"database.location",
	} {
		require.False(t, public[secret], "%s must not be publicly served", secret)
	}
}

func TestPublicKeys_InstanceCanNarrow(t *testing.T) {
	c := newTestConfig(t)
	c.Set("public", []string{"operator.name", "theme.name"})

	require.Equal(t, []string{"operator.name", "theme.name"}, config.PublicKeys(c))
}

// Widening is permitted by operator decision — an instance may publish what it likes about
// itself. The mitigation is the warning below, not a refusal.
func TestPublicKeys_InstanceCanWiden(t *testing.T) {
	c := newTestConfig(t)
	c.Set("public", []string{"operator.name", "web.environment_name"})

	require.Contains(t, config.PublicKeys(c), "web.environment_name")
}

func TestPublicKeysPromotedBeyondDefault_NamesTheExtras(t *testing.T) {
	c := newTestConfig(t)
	c.Set("public", []string{"operator.name", "relay.secret", "web.environment_name"})

	promoted, err := config.PublicKeysPromotedBeyondDefault(c)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{"relay.secret", "web.environment_name"}, promoted)
}

func TestPublicKeysPromotedBeyondDefault_QuietOnTheShippedSet(t *testing.T) {
	c := newTestConfig(t)

	promoted, err := config.PublicKeysPromotedBeyondDefault(c)
	require.NoError(t, err)
	require.Empty(t, promoted)
}

// Narrowing must not warn — an operator hiding their address is the intended use.
func TestPublicKeysPromotedBeyondDefault_QuietWhenNarrowed(t *testing.T) {
	c := newTestConfig(t)
	c.Set("public", []string{"operator.name"})

	promoted, err := config.PublicKeysPromotedBeyondDefault(c)
	require.NoError(t, err)
	require.Empty(t, promoted)
}

func TestPublicKeys_NormalisesEntries(t *testing.T) {
	c := newTestConfig(t)
	c.Set("public", []string{"  Operator.Name  ", "operator.name", "", "public", "theme.name"})

	require.Equal(t, []string{"operator.name", "theme.name"}, config.PublicKeys(c),
		"entries are trimmed and lowercased, duplicates collapse, blanks drop, and the array "+
			"never serves itself")
}

func TestDefaultPublicKeys_ComesFromTheShippedFile(t *testing.T) {
	shipped, err := config.DefaultPublicKeys()
	require.NoError(t, err)

	require.Equal(t, []string{
		"operator.contact_url",
		"operator.name",
		"theme.name",
	}, shipped)
}

// A signed-in user gets the operator contact block on top of whatever is public — the operator
// holds the records, so reaching them is not a preference the public array should withhold.
func TestAuthenticatedInstanceKeys_AddsTheOperatorContactBlock(t *testing.T) {
	c := newTestConfig(t)

	keys := config.AuthenticatedInstanceKeys(c)
	require.Contains(t, keys, "operator.contact_email")
	require.Contains(t, keys, "operator.name")
	require.Contains(t, keys, "operator.contact_url")
	require.Contains(t, keys, "theme.name", "public keys are still included")
}

// The floor holds even when an operator narrows the public array to nothing.
func TestAuthenticatedInstanceKeys_SurviveANarrowedPublicArray(t *testing.T) {
	c := newTestConfig(t)
	c.Set("public", []string{})

	require.Equal(t, []string{
		"operator.contact_email",
		"operator.contact_url",
		"operator.name",
	}, config.AuthenticatedInstanceKeys(c))
}

// Secrets stay out of the authenticated view too — it is public plus a named block, not
// everything-minus-a-few.
func TestAuthenticatedInstanceKeys_ExcludeSecrets(t *testing.T) {
	c := newTestConfig(t)

	keys := config.AuthenticatedInstanceKeys(c)
	require.NotContains(t, keys, "jwt.issuer.key")
	require.NotContains(t, keys, "relay.secret")
	require.NotContains(t, keys, "database.location")
}

// --- secret: masking on the Admin screen, the OPPOSITE shape to public ------------------------

func TestSecretKeys_ShippedDefault(t *testing.T) {
	c := newTestConfig(t)

	require.Contains(t, config.SecretKeys(c), "jwt.issuer.key")
	require.Contains(t, config.SecretKeys(c), "relay.secret")
}

// REGRESSION. The list must stay SHORT. Masking everything outside `public` hid 47 of 51
// settings — the listen port, the log level — which protects nothing and teaches an operator to
// click reveal without reading.
func TestSecretKeys_IsShortNotTheInverseOfPublic(t *testing.T) {
	c := newTestConfig(t)

	values, err := config.DefaultConfigValues()
	require.NoError(t, err)

	secrets := config.SecretKeys(c)
	require.Less(t, len(secrets), len(values)/4,
		"marked %d of %d settings secret; masking is meant to be the exception", len(secrets), len(values))

	for _, ordinary := range []string{"web.listen.port", "log.level", "metrics.port", "database.type"} {
		require.False(t, config.IsSecretKey(c, ordinary), "%s is not a secret", ordinary)
	}
}

func TestIsSecretKey_NormalisesTheKey(t *testing.T) {
	c := newTestConfig(t)

	require.True(t, config.IsSecretKey(c, "JWT.Issuer.Key"))
	require.True(t, config.IsSecretKey(c, "  jwt.issuer.key  "))
	require.False(t, config.IsSecretKey(c, "jwt.session_ttl_minutes"))
}

// An instance may add to it — an operator with a key they consider sensitive should be able to
// hide it, and unlike `public`, over-marking here costs only a click.
func TestSecretKeys_InstanceCanExtend(t *testing.T) {
	c := newTestConfig(t)
	c.Set("secret", []string{"jwt.issuer.key", "operator.contact_email"})

	require.True(t, config.IsSecretKey(c, "operator.contact_email"))
}

// Listing a key that does not exist in the catalogue is harmless — it future-proofs a key that
// is env-only today.
func TestSecretKeys_ToleratesKeysNotInTheCatalogue(t *testing.T) {
	c := newTestConfig(t)

	values, err := config.DefaultConfigValues()
	require.NoError(t, err)
	require.NotContains(t, values, "database.encryption.key",
		"env-only by design, but still worth naming as secret")
	require.True(t, config.IsSecretKey(c, "database.encryption.key"))
}
