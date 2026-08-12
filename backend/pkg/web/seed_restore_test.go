package web

import (
	"os"
	"path/filepath"
	"testing"

	mock_config "github.com/fastenhealth/fasten-onprem/backend/pkg/config/mock"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

// seedEngine wires an AppEngine for restore tests and returns the seed path and db path it is
// configured with.
func seedEngine(t *testing.T, restore bool, bootstrapAdmin bool, seedPath, dbPath string) *AppEngine {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)

	cfg := mock_config.NewMockInterface(ctrl)
	cfg.EXPECT().GetBool("bootstrap.seed.restore").Return(restore).AnyTimes()
	cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(bootstrapAdmin).AnyTimes()
	cfg.EXPECT().GetString("bootstrap.seed.path").Return(seedPath).AnyTimes()
	cfg.EXPECT().GetString("database.location").Return(dbPath).AnyTimes()
	// Restore and reset (#518) share this entry point; these tests are about restore.
	cfg.EXPECT().GetBool("demo.reset_on_restart").Return(false).AnyTimes()

	return &AppEngine{Config: cfg, Logger: logrus.WithField("test", t.Name())}
}

func writeSeed(t *testing.T, dir, contents string) string {
	t.Helper()
	path := filepath.Join(dir, "fasten.seed.db")
	require.NoError(t, os.WriteFile(path, []byte(contents), 0o644))
	return path
}

func TestRestoreSeedDatabaseIfMissing(t *testing.T) {
	t.Run("does nothing when the feature is off", func(t *testing.T) {
		dir := t.TempDir()
		seed := writeSeed(t, dir, "seed-bytes")
		db := filepath.Join(dir, "fasten.db")

		ae := seedEngine(t, false, true, seed, db)
		require.NoError(t, ae.RestoreSeedDatabaseIfMissing())

		_, err := os.Stat(db)
		require.True(t, os.IsNotExist(err), "a stock install must not acquire a database it did not have")
	})

	t.Run("installs the seed when there is no database", func(t *testing.T) {
		dir := t.TempDir()
		seed := writeSeed(t, dir, "seed-bytes")
		db := filepath.Join(dir, "sub", "fasten.db") // also covers creating the parent directory

		ae := seedEngine(t, true, true, seed, db)
		require.NoError(t, ae.RestoreSeedDatabaseIfMissing())

		got, err := os.ReadFile(db)
		require.NoError(t, err)
		require.Equal(t, "seed-bytes", string(got))

		info, err := os.Stat(db)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "a database holding records should not be world-readable")
	})

	// The case that would silently destroy a demo's state — or a real instance's, if someone set the
	// flag on the wrong deployment.
	t.Run("never overwrites an existing database", func(t *testing.T) {
		dir := t.TempDir()
		seed := writeSeed(t, dir, "seed-bytes")
		db := filepath.Join(dir, "fasten.db")
		require.NoError(t, os.WriteFile(db, []byte("live-data"), 0o600))

		ae := seedEngine(t, true, true, seed, db)
		require.NoError(t, ae.RestoreSeedDatabaseIfMissing())

		got, err := os.ReadFile(db)
		require.NoError(t, err)
		require.Equal(t, "live-data", string(got), "an existing database must survive untouched")
	})

	// THE precondition. A seed carries no admin, so restoring without bootstrap admin produces an
	// instance that is populated, reachable, and administrable by nobody — with the first-run wizard
	// suppressed because users exist. Refusing to start is the better outcome.
	t.Run("refuses when bootstrap admin is not configured", func(t *testing.T) {
		dir := t.TempDir()
		seed := writeSeed(t, dir, "seed-bytes")
		db := filepath.Join(dir, "fasten.db")

		ae := seedEngine(t, true, false, seed, db)
		err := ae.RestoreSeedDatabaseIfMissing()

		require.Error(t, err)
		require.Contains(t, err.Error(), "bootstrap.admin.enabled")
		require.Contains(t, err.Error(), "administrable by nobody")
		_, statErr := os.Stat(db)
		require.True(t, os.IsNotExist(statErr), "nothing should be installed when the combination is refused")
	})

	// The usual cause is an image built without the seed baked in, so the error has to name the path.
	t.Run("fails with the path when the seed is absent", func(t *testing.T) {
		dir := t.TempDir()
		db := filepath.Join(dir, "fasten.db")

		ae := seedEngine(t, true, true, filepath.Join(dir, "not-there.db"), db)
		err := ae.RestoreSeedDatabaseIfMissing()

		require.Error(t, err)
		require.Contains(t, err.Error(), "not-there.db")
	})

	t.Run("fails when the seed path is empty", func(t *testing.T) {
		dir := t.TempDir()
		ae := seedEngine(t, true, true, "", filepath.Join(dir, "fasten.db"))
		require.Error(t, ae.RestoreSeedDatabaseIfMissing())
	})
}

// A partially-copied database is worse than none: the app would open it, run migrations against it,
// and fail in ways that look like corruption rather than like an interrupted copy. The rename makes
// the install all-or-nothing, and this checks no stray temporary file is left behind either.
func TestCopyFileAtomicLeavesNoDebris(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dst := filepath.Join(dir, "dst")
	require.NoError(t, os.WriteFile(src, []byte("payload"), 0o644))

	require.NoError(t, copyFileAtomic(src, dst))

	got, err := os.ReadFile(dst)
	require.NoError(t, err)
	require.Equal(t, "payload", string(got))

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 2, "only src and dst should remain; a leftover .seed-* temp file means the rename path is wrong")
}
