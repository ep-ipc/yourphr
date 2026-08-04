package database

import (
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// Database restore (#362). Restoring overwrites the ENTIRE single-file DB — every user's records — so it
// is admin-gated and DANGEROUS. We never swap a live, open DB: a restore is STAGED (validated, with an
// auto-backup of the current DB taken first), then APPLIED at the next startup before the DB is opened.

const restorePendingName = ".restore_pending.db"

func restorePendingPath(appConfig config.Interface) string {
	return filepath.Join(dbDirFromConfig(appConfig), restorePendingName)
}

// StageRestore validates a backup file and stages it for the next startup. It takes an auto-backup of
// the current DB first (so the restore is reversible), decompresses the candidate (if .gz), validates
// it is an intact SQLite database, then writes it to the pending path. The swap happens at startup.
func (gr *GormRepository) StageRestore(appConfig config.Interface, srcPath string) error {
	if BackupRestoreGated(appConfig) {
		return ErrEncryptionEnabled
	}
	// Accepts BOTH the whole-data-root archive and the legacy database-only *.db.gz (yourphr#467).
	// Legacy support is not optional: existing backups are the ones people actually have, and a
	// restore path that only understands the new format makes an upgrade destroy the ability to
	// recover. Format is detected by content, not by filename.
	candidate, err := OpenBackupCandidate(srcPath)
	if err != nil {
		return err
	}
	defer candidate.Close()
	tmp := candidate.DBPath

	if err := validateSqliteFile(tmp); err != nil {
		return fmt.Errorf("not a valid/intact backup: %w", err)
	}
	// Reversibility (best-effort): take a durable timestamped backup of the current DB and prune to the
	// retention limit. A read-only/unavailable destination must NOT block the restore — ApplyPendingRestore
	// also writes <db>.pre-restore at apply time, which is the guaranteed safety copy (#368 #7).
	if _, _, err := gr.PerformBackup(appConfig, ""); err == nil {
		settings := LoadBackupSettings(appConfig)
		_, _ = PruneBackups(ResolveDestination(appConfig, settings), settings.MaxBackups)
	}
	if err := copyFile(tmp, restorePendingPath(appConfig)); err != nil {
		return fmt.Errorf("could not stage restore: %w", err)
	}

	// Stage the config store beside the database, so both are applied by the same startup swap.
	//
	// RESTORED, deliberately. The failure this whole change exists to fix is an instance coming
	// back as "records without identity" — the operator contact, the theme and the schedule are
	// precisely what was missing. A restore means "make this instance be that instance again", and
	// an operator restoring onto a fresh container wants their instance back, not a blank one
	// wearing their records.
	//
	// The environment still wins afterwards: any YOURPHR_* variable overrides the restored file, so
	// a deployment cannot be hijacked by a restored config (see docs/configuration-system.md).
	if err := stagePendingConfig(appConfig, candidate.ConfigDir); err != nil {
		return fmt.Errorf("could not stage the restored configuration: %w", err)
	}
	return nil
}

// restorePendingConfigName is the staged config store, applied at the same startup as the database.
const restorePendingConfigName = ".restore_pending_config"

func restorePendingConfigPath(appConfig config.Interface) string {
	return filepath.Join(dbDirFromConfig(appConfig), restorePendingConfigName)
}

// stagePendingConfig copies the archive's config directory into the pending location, and clears any
// previously staged one so an abandoned restore cannot leak into the next.
func stagePendingConfig(appConfig config.Interface, srcDir string) error {
	pending := restorePendingConfigPath(appConfig)
	_ = os.RemoveAll(pending)
	if srcDir == "" {
		return nil // legacy backup, or an instance that never customised anything
	}
	return copyDir(srcDir, pending)
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		return copyFile(path, target)
	})
}

// ApplyPendingRestore runs at startup BEFORE the DB is opened. If a restore is staged, it copies the
// current live DB aside (<db>.pre-restore), replaces it with the staged file, clears WAL/SHM (so SQLite
// rebuilds from the restored main file), and removes the pending marker. Returns whether it applied one.
func ApplyPendingRestore(appConfig config.Interface) (bool, error) {
	pending := restorePendingPath(appConfig)
	if _, err := os.Stat(pending); err != nil {
		return false, nil // nothing staged
	}
	live := appConfig.GetString("database.location")
	// Safety copy of the current DB is REQUIRED — never destroy the live DB if we can't back it up first
	// (#368). Only when a live DB actually exists.
	if _, err := os.Stat(live); err == nil {
		if err := copyFile(live, live+".pre-restore"); err != nil {
			return false, fmt.Errorf("aborting restore: could not write pre-restore safety copy: %w", err)
		}
	}
	// Atomic swap: copy to a sibling temp, then rename over the live path. Rename is atomic on the same
	// filesystem, so a crash/disk-full mid-copy can never leave a half-written live DB (#368 / finding #2).
	staging := live + ".restoring"
	if err := copyFile(pending, staging); err != nil {
		os.Remove(staging)
		return false, fmt.Errorf("apply restore failed (staging copy): %w", err)
	}
	if err := os.Rename(staging, live); err != nil {
		os.Remove(staging)
		return false, fmt.Errorf("apply restore failed (rename): %w", err)
	}
	_ = os.Remove(live + "-wal")
	_ = os.Remove(live + "-shm")
	_ = os.Remove(pending)

	// Apply the staged config store, if the archive carried one (yourphr#467).
	//
	// Best-effort AFTER the database swap, and deliberately non-fatal: the records are the thing a
	// restore exists to recover. Failing the whole restore because a theme file could not be moved
	// would be the wrong trade, and the operator can re-enter their contact details in a form.
	if err := applyPendingConfig(appConfig); err != nil {
		return true, fmt.Errorf("database restored, but the configuration could not be applied: %w", err)
	}
	return true, nil
}

// applyPendingConfig moves a staged config store into place, keeping the outgoing one beside it.
//
// The signing key is NOT part of this. It is in the archive but never applied — restoring it would
// revive every session token ever signed with it, including any lifted from the backup file itself.
// See RestoreJWTKeyPolicy.
func applyPendingConfig(appConfig config.Interface) error {
	pending := restorePendingConfigPath(appConfig)
	if _, err := os.Stat(pending); err != nil {
		return nil // nothing staged: a legacy backup, or an instance with no customisation
	}
	defer os.RemoveAll(pending)

	live := filepath.Join(dbDirFromConfig(appConfig), "config")
	// Keep the outgoing config, for the same reason the database gets a .pre-restore copy: an
	// operator who restores the wrong archive must be able to get back.
	if _, err := os.Stat(live); err == nil {
		aside := live + ".pre-restore"
		_ = os.RemoveAll(aside)
		if err := os.Rename(live, aside); err != nil {
			return fmt.Errorf("could not set the current configuration aside: %w", err)
		}
	}
	if err := os.Rename(pending, live); err != nil {
		return fmt.Errorf("could not move the restored configuration into place: %w", err)
	}
	return nil
}

// validateSqliteFile opens the file read-only and runs integrity_check (the sqlcipher driver opens a
// plaintext DB without a key). Errors if it's not a real, intact SQLite database.
func validateSqliteFile(path string) error {
	db, err := gorm.Open(sqlite.Open("file:"+path+"?mode=ro&_busy_timeout=2000"), &gorm.Config{})
	if err != nil {
		return err
	}
	if sqlDB, e := db.DB(); e == nil {
		defer sqlDB.Close()
	}
	var res string
	if err := db.Raw("PRAGMA integrity_check").Scan(&res).Error; err != nil {
		return err
	}
	if !strings.EqualFold(res, "ok") {
		return fmt.Errorf("integrity_check: %s", res)
	}
	return nil
}

// decompressIfNeeded returns the path to an uncompressed copy of src, plus a cleanup func. For an
// uncompressed src it returns src and a no-op cleanup.
//
// Detection is by CONTENT (the gzip magic number), not by the ".gz" extension. Backups get renamed:
// a browser appends " (1)", a NAS strips the extension, an operator renames the file to something
// they will recognise in six months. Keying off the name meant a perfectly valid backup failed to
// restore because of what it was called — at the one moment when being unable to restore matters.
func decompressIfNeeded(src string) (string, func(), error) {
	gzipped, err := looksLikeGzip(src)
	if err != nil {
		return "", nil, err
	}
	if !gzipped {
		return src, func() {}, nil
	}
	in, err := os.Open(src)
	if err != nil {
		return "", nil, err
	}
	defer in.Close()
	zr, err := gzip.NewReader(in)
	if err != nil {
		return "", nil, fmt.Errorf("not a gzip file: %w", err)
	}
	defer zr.Close()
	tmp, err := os.CreateTemp("", "yourphr-restore-*.db")
	if err != nil {
		return "", nil, err
	}
	if _, err := io.Copy(tmp, zr); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", nil, err
	}
	tmp.Close()
	return tmp.Name(), func() { os.Remove(tmp.Name()) }, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// looksLikeGzip reports whether the file starts with the gzip magic number (RFC 1952).
func looksLikeGzip(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	magic := make([]byte, 2)
	n, err := io.ReadFull(f, magic)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return false, err
	}
	return n == 2 && magic[0] == 0x1f && magic[1] == 0x8b, nil
}
