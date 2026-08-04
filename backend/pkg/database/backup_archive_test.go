package database

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// tarNames lists the regular-file members of an archive.
func tarNames(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	require.NoError(t, err)
	defer f.Close()
	gr, err := gzip.NewReader(f)
	require.NoError(t, err)
	defer gr.Close()

	var names []string
	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		if hdr.Typeflag == tar.TypeReg {
			names = append(names, hdr.Name)
		}
	}
	return names
}

// The headline behaviour of yourphr#467: an archive carries identity, not just records.
func TestBackupArchive_ContainsTheDataRoot(t *testing.T) {
	repo, cfg, dataRoot := newArchiveRepo(t)

	require.NoError(t, os.MkdirAll(filepath.Join(dataRoot, "config"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dataRoot, "config", "app-custom-config.json"),
		[]byte(`{"operator.name":"Jim Willeke"}`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dataRoot, ".jwt_issuer_key"), []byte("a-signing-key"), 0o600))

	archive := filepath.Join(t.TempDir(), "out.tar.gz")
	require.NoError(t, repo.WriteBackupArchive(cfg, archive))

	names := tarNames(t, archive)
	require.Contains(t, names, ArchiveDBName)
	require.Contains(t, names, "config/app-custom-config.json",
		"the operator contact is exactly what a database-only backup was losing")
	require.Contains(t, names, ".jwt_issuer_key",
		"the rule is the whole data root with no exclusions")
}

// A backup must never contain previous backups, or each archive grows by the size of every archive
// before it. Checked against a NON-DEFAULT destination name, because the rule is computed from the
// resolved destination rather than a hardcoded "backups".
func TestBackupArchive_ExcludesTheBackupDestination(t *testing.T) {
	repo, cfg, dataRoot := newArchiveRepo(t)

	// A destination inside the data root, deliberately not called "backups".
	dest := filepath.Join(dataRoot, "my-archive-folder")
	require.NoError(t, os.MkdirAll(dest, 0o700))
	require.NoError(t, SaveBackupSettings(cfg, BackupSettings{Destination: dest, Time: "02:00", Days: "daily", MaxBackups: 7}))
	require.NoError(t, os.WriteFile(filepath.Join(dest, "an-older-yourphr-backup.tar.gz"), []byte("previous archive"), 0o600))

	archive := filepath.Join(t.TempDir(), "out.tar.gz")
	require.NoError(t, repo.WriteBackupArchive(cfg, archive))

	for _, n := range tarNames(t, archive) {
		require.NotContains(t, n, "my-archive-folder",
			"a backup must not contain the backup destination, whatever it is called")
	}
}

// The live database is captured with VACUUM INTO. Including the raw file as well would put a torn,
// inconsistent second copy in the same archive.
func TestBackupArchive_ExcludesTheRawLiveDatabase(t *testing.T) {
	repo, cfg, _ := newArchiveRepo(t)

	archive := filepath.Join(t.TempDir(), "out.tar.gz")
	require.NoError(t, repo.WriteBackupArchive(cfg, archive))

	// The archive legitimately contains one fasten.db — the VACUUM INTO snapshot. What must never
	// happen is a SECOND copy from walking the data root, which would be a torn read of a live file.
	names := tarNames(t, archive)
	dbCount := 0
	for _, n := range names {
		if n == ArchiveDBName {
			dbCount++
		}
		require.False(t, strings.HasSuffix(n, "-wal"), "WAL must not be archived: %s", n)
		require.False(t, strings.HasSuffix(n, "-shm"), "SHM must not be archived: %s", n)
	}
	require.Equal(t, 1, dbCount, "exactly one database: the snapshot, never the raw live file as well")
}

// Format is detected by content. A renamed archive — "(1)" appended by a browser, extension stripped
// by a NAS — must still restore, because refusing it turns a restore into data loss.
func TestOpenBackupCandidate_DetectsByContentNotName(t *testing.T) {
	repo, cfg, _ := newArchiveRepo(t)

	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	require.NoError(t, repo.WriteBackupArchive(cfg, archive))

	renamed := filepath.Join(filepath.Dir(archive), "totally unrelated name (1)")
	require.NoError(t, os.Rename(archive, renamed))

	got, err := OpenBackupCandidate(renamed)
	require.NoError(t, err)
	defer got.Close()
	require.False(t, got.Legacy)
	require.NotEmpty(t, got.DBPath)
}

// Legacy support is load-bearing: existing *.db.gz backups are the ones people actually have.
func TestOpenBackupCandidate_AcceptsLegacyDatabaseOnlyBackup(t *testing.T) {
	repo, _, _ := newArchiveRepo(t)

	legacy := filepath.Join(t.TempDir(), "old-yourphr-backup.db.gz")
	require.NoError(t, repo.BackupToFile(legacy))

	got, err := OpenBackupCandidate(legacy)
	require.NoError(t, err)
	defer got.Close()

	require.True(t, got.Legacy)
	require.NoError(t, validateSqliteFile(got.DBPath))
	require.Empty(t, got.ConfigDir, "a database-only backup carries no config")
	require.False(t, got.HadJWTKey)
}

// The signing key is archived but never extracted for use. Restoring it would revive every session
// token ever signed with it, including any lifted from the backup file itself.
func TestOpenBackupCandidate_ReportsButNeverExtractsTheJWTKey(t *testing.T) {
	repo, cfg, dataRoot := newArchiveRepo(t)
	require.NoError(t, os.WriteFile(filepath.Join(dataRoot, ".jwt_issuer_key"), []byte("a-signing-key"), 0o600))

	archive := filepath.Join(t.TempDir(), "out.tar.gz")
	require.NoError(t, repo.WriteBackupArchive(cfg, archive))

	got, err := OpenBackupCandidate(archive)
	require.NoError(t, err)
	defer got.Close()

	require.True(t, got.HadJWTKey, "the operator should be told the archive contained one")

	// It must not have been written anywhere under the extraction directory.
	root := filepath.Dir(got.DBPath)
	err = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			require.NotEqual(t, ArchiveJWTKeyName, filepath.Base(p),
				"the signing key must never be extracted for use")
		}
		return nil
	})
	require.NoError(t, err)
}

// A backup is a file an operator copies from a NAS, so it is not automatically trustworthy input.
// This is the "zip slip" class: an archive member escaping the extraction directory.
func TestSafeArchivePath_RejectsEscapes(t *testing.T) {
	for _, bad := range []string{
		"../outside",
		"config/../../outside",
		"/etc/passwd/../shadow",
		"..",
	} {
		_, err := safeArchivePath(bad)
		require.Errorf(t, err, "must reject %q", bad)
	}

	for _, ok := range []string{"fasten.db", "config/app-custom-config.json", "/fasten.db", "./fasten.db"} {
		got, err := safeArchivePath(ok)
		require.NoErrorf(t, err, "must accept %q", ok)
		require.False(t, filepath.IsAbs(got))
		require.NotContains(t, got, "..")
	}
}

// newArchiveRepo builds a repository over a real SQLite file in a fresh data root.
func newArchiveRepo(t *testing.T) (*GormRepository, config.Interface, string) {
	t.Helper()
	dataRoot := t.TempDir()
	dbPath := filepath.Join(dataRoot, "fasten.db")

	appConfig, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, appConfig.Init())
	appConfig.Set("database.location", dbPath)
	appConfig.Set("storage.data_dir", dataRoot)
	// Encryption defaults ON (#470) and gates backup/restore (#367); these exercise the unencrypted
	// path, so opt out explicitly.
	appConfig.Set("database.encryption.enabled", false)
	// Keep the cache out of the data root, which is where it lives by default anyway.
	appConfig.Set("cache.location", filepath.Join(t.TempDir(), "cache"))

	db, err := gorm.Open(sqlite.Open("file:"+dbPath+"?_busy_timeout=5000"), &gorm.Config{})
	require.NoError(t, err)
	t.Cleanup(func() {
		if s, e := db.DB(); e == nil {
			_ = s.Close()
		}
	})
	require.NoError(t, db.Exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)").Error)
	require.NoError(t, db.Exec("INSERT INTO notes (id, body) VALUES (1, 'original')").Error)

	return &GormRepository{GormClient: db}, appConfig, dataRoot
}
