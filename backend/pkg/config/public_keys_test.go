package config_test

import (
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

func TestPublicKeys_ShippedDefault(t *testing.T) {
	c := newTestConfig(t)

	require.Equal(t, []string{
		"operator.contact_email",
		"operator.contact_url",
		"operator.name",
		"theme.name",
	}, config.PublicKeys(c))
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
		"operator.contact_email",
		"operator.contact_url",
		"operator.name",
		"theme.name",
	}, shipped)
}
