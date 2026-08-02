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

// --- ResolveStoragePaths: must never move a configured path ---------------------------------

// REGRESSION, v1.21.0 outage. Prod and demo set database.location to /opt/fasten/db/fasten.db
// in their ConfigMaps — a real configuration whose value happens to equal the built-in default.
// The old implementation compared against the default constant, concluded "unset", and
// relocated the DB to <data_dir>/db/fasten.db. Both instances crash-looped on
// "unable to open database file: no such file or directory".
func TestResolveStoragePaths_NeverMovesTheDatabase(t *testing.T) {
	c := newTestConfig(t)
	c.Set("storage.data_dir", "/opt/fasten/db")
	c.Set("database.location", "/opt/fasten/db/fasten.db") // == DefaultDatabaseLocation, and deliberate
	c.Set("cache.location", "/opt/fasten/db/fasten.cache.db")

	config.ResolveStoragePaths(c)

	require.Equal(t, "/opt/fasten/db/fasten.db", c.GetString("database.location"),
		"a configured database path must survive, even when it equals the default")
	require.Equal(t, "/opt/fasten/db/fasten.cache.db", c.GetString("cache.location"))
}

// The data root is still honored for what it actually governs: the config store, the JWT key
// and backups all resolve under it, independently of where the database lives.
func TestResolveStoragePaths_DataRootStillGovernsInstanceState(t *testing.T) {
	c := newTestConfig(t)
	c.Set("storage.data_dir", "/srv/yourphr")
	c.Set("database.location", "/mnt/fast/fasten.db")

	config.ResolveStoragePaths(c)

	require.Equal(t, "/srv/yourphr", config.DataDir(c))
	require.Equal(t, "/mnt/fast/fasten.db", c.GetString("database.location"),
		"the data root must not drag the database along with it")
}

func TestResolveStoragePaths_LeavesDefaultsAlone(t *testing.T) {
	c := newTestConfig(t)
	c.Set("storage.data_dir", "/srv/yourphr")

	config.ResolveStoragePaths(c)

	require.Equal(t, config.DefaultDatabaseLocation, c.GetString("database.location"))
	require.Equal(t, config.DefaultCacheLocation, c.GetString("cache.location"))
}
