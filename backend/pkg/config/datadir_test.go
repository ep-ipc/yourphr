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

// --- ResolveStoragePaths: the data root is primary, paths derive under it -------------------

func TestResolveStoragePaths_DerivesDbAndCacheUnderDataRoot(t *testing.T) {
	c := newTestConfig(t)
	c.Set("storage.data_dir", "/srv/yourphr")

	config.ResolveStoragePaths(c)

	require.Equal(t, "/srv/yourphr/db/fasten.db", c.GetString("database.location"))
	require.Equal(t, "/srv/yourphr/cache", c.GetString("cache.location"))
	require.Equal(t, "/srv/yourphr", config.DataDir(c))
}

// Setting a data root AND an explicit DB path is a legitimate split (DB on fast local disk,
// the rest elsewhere). An operator's stated choice must never be overridden.
func TestResolveStoragePaths_ExplicitPathsAreNotOverridden(t *testing.T) {
	c := newTestConfig(t)
	c.Set("storage.data_dir", "/srv/yourphr")
	c.Set("database.location", "/mnt/fast/fasten.db")
	c.Set("cache.location", "/mnt/fast/cache")

	config.ResolveStoragePaths(c)

	require.Equal(t, "/mnt/fast/fasten.db", c.GetString("database.location"))
	require.Equal(t, "/mnt/fast/cache", c.GetString("cache.location"))
	// The data root stays what the operator set — it is not re-derived from the DB path.
	require.Equal(t, "/srv/yourphr", config.DataDir(c))
}

// The pre-#451 layout must be byte-identical when no data root is configured, otherwise
// upgrading installs would silently look for their DB somewhere new.
func TestResolveStoragePaths_NoOpWithoutDataRoot(t *testing.T) {
	c := newTestConfig(t)

	config.ResolveStoragePaths(c)

	require.Equal(t, config.DefaultDatabaseLocation, c.GetString("database.location"))
	require.Equal(t, config.DefaultCacheLocation, c.GetString("cache.location"))
	require.Equal(t, "/opt/fasten/db", config.DataDir(c))
}

func TestResolveStoragePaths_IsIdempotent(t *testing.T) {
	c := newTestConfig(t)
	c.Set("storage.data_dir", "/srv/yourphr")

	config.ResolveStoragePaths(c)
	config.ResolveStoragePaths(c)

	require.Equal(t, "/srv/yourphr/db/fasten.db", c.GetString("database.location"))
	require.Equal(t, "/srv/yourphr/cache", c.GetString("cache.location"))
}
