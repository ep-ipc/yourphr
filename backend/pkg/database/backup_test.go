package database

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/version"
)

func TestBackupRestore_GatedWhenEncrypted(t *testing.T) {
	appConfig, err := config.Create()
	if err != nil {
		t.Fatal(err)
	}
	appConfig.Set("database.location", filepath.Join(t.TempDir(), "fasten.db"))
	appConfig.Set("database.encryption.enabled", true)
	gr := &GormRepository{} // gate returns before touching the DB client

	if _, _, err := gr.PerformBackup(appConfig, ""); !errors.Is(err, ErrEncryptionEnabled) {
		t.Errorf("PerformBackup should be gated when encryption is enabled, got: %v", err)
	}
	if err := gr.StageRestore(appConfig, "anything"); !errors.Is(err, ErrEncryptionEnabled) {
		t.Errorf("StageRestore should be gated when encryption is enabled, got: %v", err)
	}
}

func TestValidateBackupDestination(t *testing.T) {
	dataDir := t.TempDir()
	nas := t.TempDir()
	appConfig, err := config.Create()
	if err != nil {
		t.Fatal(err)
	}
	appConfig.Set("database.location", filepath.Join(dataDir, "fasten.db"))
	appConfig.Set("backup.destination", nas)

	for _, d := range []string{
		dataDir,                           // == data root
		filepath.Join(dataDir, "backups"), // under data root (DefaultBackupDir)
		nas,                               // == configured destination
		filepath.Join(nas, "yourphr"),     // under configured destination
	} {
		got, err := ValidateBackupDestination(appConfig, d)
		if err != nil {
			t.Errorf("expected %q allowed, got error: %v", d, err)
		} else if got != filepath.Clean(d) {
			t.Errorf("expected cleaned %q, got %q", filepath.Clean(d), got)
		}
	}

	for _, d := range []string{
		"",              // empty
		"relative/path", // not absolute
		"/etc",          // outside the allowlist
		filepath.Join(dataDir, "..", "elsewhere"), // ".." escapes the data root
	} {
		if _, err := ValidateBackupDestination(appConfig, d); err == nil {
			t.Errorf("expected %q rejected, got nil error", d)
		}
	}
}

// #434: destination already saved via Admin UI (.backup_settings.json) is an allowlist root,
// so scheduled backups keep working after #383 without requiring a config.yaml edit.
func TestValidateBackupDestination_PersistedUIDestination(t *testing.T) {
	dataDir := t.TempDir()
	uiDest := t.TempDir() // not in backup.destination / allowed-roots
	appConfig, err := config.Create()
	if err != nil {
		t.Fatal(err)
	}
	appConfig.Set("database.location", filepath.Join(dataDir, "fasten.db"))

	// Without persistence: rejected.
	if _, err := ValidateBackupDestination(appConfig, uiDest); err == nil {
		t.Fatalf("expected %q rejected before UI settings exist", uiDest)
	}

	// Persist as Admin UI would.
	if err := SaveBackupSettings(appConfig, BackupSettings{
		Enabled: true, Time: "02:00", Days: "daily", Destination: uiDest, MaxBackups: 7,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := ValidateBackupDestination(appConfig, uiDest)
	if err != nil {
		t.Fatalf("expected persisted UI dest allowed, got: %v", err)
	}
	if got != filepath.Clean(uiDest) {
		t.Errorf("got %q, want %q", got, filepath.Clean(uiDest))
	}
}

func TestBackupHealth_RecordAndLoad(t *testing.T) {
	dataDir := t.TempDir()
	appConfig, err := config.Create()
	if err != nil {
		t.Fatal(err)
	}
	appConfig.Set("database.location", filepath.Join(dataDir, "fasten.db"))
	_ = SaveBackupSettings(appConfig, BackupSettings{
		Enabled: true, Time: "02:00", Days: "daily", Destination: filepath.Join(dataDir, "backups"), MaxBackups: 7,
	})

	// No history yet, schedule on → not OK.
	st := LoadBackupHealthStatus(appConfig)
	if st.OK {
		t.Errorf("expected not OK before any success, summary=%q", st.HealthySummary)
	}

	n := RecordBackupFailure(appConfig, "destination outside allowed roots")
	if n != 1 {
		t.Errorf("consecutive fails = %d, want 1", n)
	}
	n = RecordBackupFailure(appConfig, "still broken")
	if n != 2 {
		t.Errorf("consecutive fails = %d, want 2", n)
	}
	st = LoadBackupHealthStatus(appConfig)
	if st.OK || st.ConsecutiveFails != 2 || st.LastError != "still broken" {
		t.Errorf("failure state: ok=%v fails=%d err=%q", st.OK, st.ConsecutiveFails, st.LastError)
	}
	if st.HealthySummary != "Scheduled backup failing" {
		t.Errorf("summary = %q", st.HealthySummary)
	}

	RecordBackupSuccess(appConfig, filepath.Join(dataDir, "backups", "good.db.gz"))
	st = LoadBackupHealthStatus(appConfig)
	if !st.OK || st.ConsecutiveFails != 0 || st.LastError != "" {
		t.Errorf("after success: ok=%v fails=%d err=%q", st.OK, st.ConsecutiveFails, st.LastError)
	}
	if st.HealthySummary != "Backup healthy" {
		t.Errorf("summary = %q, want Backup healthy", st.HealthySummary)
	}
	if st.LastSuccessPath == "" {
		t.Error("expected last_success_path set")
	}
}

func TestBackupFileName(t *testing.T) {
	t0 := time.Date(2026, 6, 21, 12, 10, 3, 0, time.UTC)
	if got, want := BackupFileName(t0, ""), "2026-06-21T12-10-03Z-yourphr-"+version.VERSION+"-backup.db.gz"; got != want {
		t.Errorf("BackupFileName(no label) = %q, want %q", got, want)
	}
	if got, want := BackupFileName(t0, "dev"), "2026-06-21T12-10-03Z-yourphr-dev-"+version.VERSION+"-backup.db.gz"; got != want {
		t.Errorf("BackupFileName(dev) = %q, want %q", got, want)
	}
	if got, want := BackupFileName(t0, "weird/label name"), "2026-06-21T12-10-03Z-yourphr-weird-label-name-"+version.VERSION+"-backup.db.gz"; got != want {
		t.Errorf("BackupFileName(sanitize) = %q, want %q", got, want)
	}
}

func TestIsBackupFile(t *testing.T) {
	cases := map[string]bool{
		"2026-06-21T14-09-57Z-yourphr-1.9.0-backup.db.gz":  true, // current version-stamped name
		"2026-06-21T12-10-03Z-yourphr-backup.db.gz":        true,
		"2026-06-21T12-10-03Z-yourphr-backup.db":           true,
		"yourphr-backup-20260101.db":                       true, // legacy name still recognized
		"random.db":                                        false,
		"yourphr-backup.txt":                               false,
		"notes.md":                                         false,
		"2026-06-21T12-10-03Z-yourphr-old-backup-notes.db": false, // foreign file, not a real backup (#368 #3)
		"company-backup.db":                                false, // no yourphr marker
	}
	for name, want := range cases {
		if got := isBackupFile(name); got != want {
			t.Errorf("isBackupFile(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestParseHHMM(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		h, m int
	}{
		{"02:00", true, 2, 0}, {"2:5", true, 2, 5}, {"23:59", true, 23, 59},
		{"24:00", false, 0, 0}, {"12:60", false, 0, 0}, {"abc", false, 0, 0}, {"1230", false, 0, 0}, {"", false, 0, 0},
	}
	for _, c := range cases {
		h, m, ok := ParseHHMM(c.in)
		if ok != c.ok || (ok && (h != c.h || m != c.m)) {
			t.Errorf("ParseHHMM(%q) = %d,%d,%v; want %d,%d,%v", c.in, h, m, ok, c.h, c.m, c.ok)
		}
	}
}

func TestLoadBackupSettings_MigratesLegacyDest(t *testing.T) {
	dir := t.TempDir()
	appConfig, err := config.Create()
	if err != nil {
		t.Fatal(err)
	}
	appConfig.Set("database.location", filepath.Join(dir, "fasten.db"))
	if err := os.WriteFile(filepath.Join(dir, ".backup_dest"), []byte("/some/custom/dir\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LoadBackupSettings(appConfig).Destination; got != "/some/custom/dir" {
		t.Errorf("legacy .backup_dest not migrated: Destination = %q, want /some/custom/dir", got)
	}
}

func TestPruneBackups(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		mt := base.Add(time.Duration(i) * time.Hour)
		p := filepath.Join(dir, BackupFileName(mt, ""))
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		_ = os.Chtimes(p, mt, mt)
	}
	removed, err := PruneBackups(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Errorf("removed = %d, want 2", removed)
	}
	if got := len(ListBackups(dir)); got != 3 {
		t.Errorf("remaining = %d, want 3", got)
	}
}
