package database

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// The case a backup exists for, and the one a same-box round trip does not test (yourphr#467).
//
// A same-box restore can pass while the archive is missing everything except the database, because
// the config store is already sitting there untouched. The failure being fixed only shows up on a
// FRESH instance: records come back, identity does not.
//
// So: back up instance A, restore into an empty instance B, and require that B has A's records AND
// A's operator contact.
func TestRestoreIntoFreshInstance_RecoversRecordsAndIdentity(t *testing.T) {
	// ---- instance A: some records and some identity ----
	repoA, cfgA, rootA := newArchiveRepo(t)

	require.NoError(t, repoA.GormClient.Exec("INSERT INTO notes (id, body) VALUES (2, 'from instance A')").Error)

	require.NoError(t, os.MkdirAll(filepath.Join(rootA, "config"), 0o700))
	require.NoError(t, os.WriteFile(
		filepath.Join(rootA, "config", "app-custom-config.json"),
		[]byte(`{"operator.name":"Instance A Operator","theme.name":"dark"}`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(rootA, ".jwt_issuer_key"), []byte("instance-A-signing-key"), 0o600))

	archive := filepath.Join(t.TempDir(), "a-backup.tar.gz")
	require.NoError(t, repoA.WriteBackupArchive(cfgA, archive))

	// ---- instance B: brand new, nothing in it ----
	rootB := t.TempDir()
	dbB := filepath.Join(rootB, "fasten.db")
	cfgB, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, cfgB.Init())
	cfgB.Set("database.location", dbB)
	cfgB.Set("storage.data_dir", rootB)
	cfgB.Set("database.encryption.enabled", false)
	cfgB.Set("cache.location", filepath.Join(t.TempDir(), "cache"))

	dbHandle, err := gorm.Open(sqlite.Open("file:"+dbB+"?_busy_timeout=5000"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, dbHandle.Exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)").Error)
	repoB := &GormRepository{GormClient: dbHandle}

	require.NoError(t, repoB.StageRestore(cfgB, archive))

	// The swap happens at startup, before the DB is opened — as in production.
	if s, e := dbHandle.DB(); e == nil {
		_ = s.Close()
	}
	applied, err := ApplyPendingRestore(cfgB)
	require.NoError(t, err)
	require.True(t, applied)

	// ---- records came back ----
	reopened, err := gorm.Open(sqlite.Open("file:"+dbB+"?_busy_timeout=5000"), &gorm.Config{})
	require.NoError(t, err)
	t.Cleanup(func() {
		if s, e := reopened.DB(); e == nil {
			_ = s.Close()
		}
	})
	var body string
	require.NoError(t, reopened.Raw("SELECT body FROM notes WHERE id = 2").Scan(&body).Error)
	require.Equal(t, "from instance A", body, "the records must survive the restore")

	// ---- identity came back: the whole point of #467 ----
	restoredConfig, err := os.ReadFile(filepath.Join(rootB, "config", "app-custom-config.json"))
	require.NoError(t, err, "the config store must be restored, or the instance is records without identity")
	require.Contains(t, string(restoredConfig), "Instance A Operator")
	require.Contains(t, string(restoredConfig), "dark")

	// ---- the signing key did NOT come back ----
	_, err = os.Stat(filepath.Join(rootB, ".jwt_issuer_key"))
	require.ErrorIs(t, err, os.ErrNotExist,
		"restoring the signing key would revive every token ever signed with it; "+
			"instance B must generate its own on next start (see RestoreJWTKeyPolicy)")

	// ---- nothing staged is left behind ----
	_, err = os.Stat(restorePendingConfigPath(cfgB))
	require.ErrorIs(t, err, os.ErrNotExist, "the staged config must be consumed, not left to reapply")
}

// A legacy *.db.gz has no config to restore. It must still restore cleanly, and must NOT wipe the
// config the target instance already has — an operator restoring an old backup should not silently
// lose their current operator contact.
func TestRestoreIntoFreshInstance_LegacyBackupLeavesExistingConfigAlone(t *testing.T) {
	repoA, cfgA, _ := newArchiveRepo(t)
	require.NoError(t, repoA.GormClient.Exec("INSERT INTO notes (id, body) VALUES (3, 'legacy era')").Error)

	legacy := filepath.Join(t.TempDir(), "old-yourphr-backup.db.gz")
	require.NoError(t, repoA.BackupToFile(legacy))
	_ = cfgA

	// Target instance with its own existing config.
	rootB := t.TempDir()
	dbB := filepath.Join(rootB, "fasten.db")
	cfgB, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, cfgB.Init())
	cfgB.Set("database.location", dbB)
	cfgB.Set("storage.data_dir", rootB)
	cfgB.Set("database.encryption.enabled", false)
	cfgB.Set("cache.location", filepath.Join(t.TempDir(), "cache"))

	require.NoError(t, os.MkdirAll(filepath.Join(rootB, "config"), 0o700))
	existing := filepath.Join(rootB, "config", "app-custom-config.json")
	require.NoError(t, os.WriteFile(existing, []byte(`{"operator.name":"Existing Operator"}`), 0o600))

	dbHandle, err := gorm.Open(sqlite.Open("file:"+dbB+"?_busy_timeout=5000"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, dbHandle.Exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)").Error)
	repoB := &GormRepository{GormClient: dbHandle}

	require.NoError(t, repoB.StageRestore(cfgB, legacy))
	if s, e := dbHandle.DB(); e == nil {
		_ = s.Close()
	}
	applied, err := ApplyPendingRestore(cfgB)
	require.NoError(t, err)
	require.True(t, applied)

	kept, err := os.ReadFile(existing)
	require.NoError(t, err, "a legacy backup carries no config, so the existing one must be left alone")
	require.Contains(t, string(kept), "Existing Operator")
}
