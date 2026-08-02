package config_test

import (
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

func newTestConfig(t *testing.T) config.Interface {
	t.Helper()
	c, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, c.Init())
	return c
}

// Upgrading installs must not move: before storage.data_dir existed, every consumer
// computed filepath.Dir on the database path, so that has to stay the fallback.
func TestDataDir_DerivesFromDatabaseLocationByDefault(t *testing.T) {
	c := newTestConfig(t)
	c.Set("database.location", "/opt/fasten/db/fasten.db")

	require.Equal(t, "/opt/fasten/db", config.DataDir(c))
}

func TestDataDir_ExplicitOverrideWins(t *testing.T) {
	c := newTestConfig(t)
	c.Set("database.location", "/opt/fasten/db/fasten.db")
	c.Set("storage.data_dir", "/srv/yourphr")

	require.Equal(t, "/srv/yourphr", config.DataDir(c))
}

// A whitespace-only value is an operator typo (or an env var set to ""), not a request to
// root the instance at " ". Treat it as unset rather than writing state to a bogus path.
func TestDataDir_BlankOverrideFallsBack(t *testing.T) {
	c := newTestConfig(t)
	c.Set("database.location", "/opt/fasten/db/fasten.db")
	c.Set("storage.data_dir", "   ")

	require.Equal(t, "/opt/fasten/db", config.DataDir(c))
}

func TestDataDir_TrimsSurroundingWhitespace(t *testing.T) {
	c := newTestConfig(t)
	c.Set("storage.data_dir", "  /srv/yourphr  ")

	require.Equal(t, "/srv/yourphr", config.DataDir(c))
}
