package database

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/version"
)

// The archive layout (yourphr#467). A backup is the whole data root, not just the database.
//
// Restoring the database alone returned the records and lost the operator contact, the theme, the
// backup schedule and any legal-document override — the instance came back as records without
// identity. See docs/recovery/backup-model.md.
const (
	// ArchiveDBName is the database inside the archive. A fixed name, not the live filename, so an
	// instance whose database.location differs can still restore someone else's archive.
	ArchiveDBName = "fasten.db"

	// ArchiveConfigDir is the instance config store: operator contact, theme, overrides.
	ArchiveConfigDir = "config"

	// ArchiveJWTKeyName is the generated session signing key. Included because the rule is that the
	// data root is backed up with no exclusions — but deliberately NOT applied on restore. See
	// RestoreJWTKeyPolicy.
	ArchiveJWTKeyName = ".jwt_issuer_key"
)

// RestoreJWTKeyPolicy documents a decision that must not be silently reversed.
//
// The signing key is BACKED UP but NEVER APPLIED on restore.
//
// Restoring it would resurrect an old key, making every session token ever signed with it valid
// again — including any an attacker captured from the backup itself, which is a file explicitly
// intended to be copied to a NAS. Regenerating costs one thing: everyone signs in again, which a
// restore forces anyway.
//
// It is still in the archive because the rule is "the data root, with no exclusions", and because
// an operator who genuinely needs the old key (to keep issued API tokens working) can extract it
// from the archive by hand. That is a deliberate, visible act rather than a silent default.
const RestoreJWTKeyPolicy = "backed up, never applied on restore — a restored key revives every token ever signed with it"

// BackupArchiveName builds the canonical filename for a whole-data-root archive.
func BackupArchiveName(t time.Time, label string) string {
	seg := "yourphr-"
	if l := sanitizeLabel(label); l != "" {
		seg += l + "-"
	}
	return t.UTC().Format("2006-01-02T15-04-05") + "Z-" + seg + version.VERSION + "-backup.tar.gz"
}

// archiveExclusions are the absolute paths a backup must not contain, computed rather than listed.
//
// Deliberately NOT a hardcoded list of names. Two paths must be skipped, and both are configurable:
//
//   - the backup destination, or every archive contains every previous archive. This is a
//     self-reference rule, not an exclusion — "a backup does not contain the backup folder".
//   - the cache, which is disposable, regenerable and potentially large. By default it already
//     sits outside the data root, so this normally excludes nothing; it matters only for an
//     instance that pointed cache.location inside.
//
// Computing them keeps the model honest. A hardcoded "skip anything called backups/" would silently
// miss an operator who chose a different folder name, and would wrongly skip a legitimately-named
// directory that was not the destination.
func archiveExclusions(appConfig config.Interface) map[string]struct{} {
	out := map[string]struct{}{}
	add := func(p string) {
		if p = strings.TrimSpace(p); p != "" {
			out[filepath.Clean(p)] = struct{}{}
		}
	}
	add(CurrentBackupDestination(appConfig))
	add(DefaultBackupDir(appConfig))
	add(appConfig.GetString("cache.location"))
	return out
}

// WriteBackupArchive writes the whole data root to fullPath as a gzipped tar.
//
// The database is captured with VACUUM INTO, never a raw file copy: copying a live SQLite file
// while the app is writing produces an archive that looks fine and restores to a corrupt database.
// Everything else is copied as-is.
func (gr *GormRepository) WriteBackupArchive(appConfig config.Interface, fullPath string) error {
	dataRoot := dbDirFromConfig(appConfig)
	if dataRoot == "" {
		return fmt.Errorf("cannot back up: the data root is not set")
	}

	// VACUUM INTO a private temp dir next to the target, as the single-file path does: a per-call
	// temp dir stops two concurrent backups colliding, and keeps the uncompressed snapshot off a
	// world-readable location.
	tmpDir, err := os.MkdirTemp(filepath.Dir(fullPath), ".yourphr-backup-")
	if err != nil {
		return fmt.Errorf("backup failed (temp dir): %w", err)
	}
	defer os.RemoveAll(tmpDir)

	snapshot := filepath.Join(tmpDir, ArchiveDBName)
	safe := strings.ReplaceAll(snapshot, "'", "''")
	if err := gr.GormClient.Exec(fmt.Sprintf("VACUUM INTO '%s'", safe)).Error; err != nil {
		return fmt.Errorf("backup failed: %w", err)
	}

	out, err := os.OpenFile(fullPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("backup failed (create archive): %w", err)
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)

	failed := func(err error) error {
		tw.Close()
		gz.Close()
		out.Close()
		os.Remove(fullPath)
		return err
	}

	// The database first, so a truncated archive still has the thing that matters most.
	if err := addFileToTar(tw, snapshot, ArchiveDBName); err != nil {
		return failed(fmt.Errorf("backup failed (database): %w", err))
	}

	excluded := archiveExclusions(appConfig)
	if err := addDataRootToTar(tw, dataRoot, appConfig, excluded); err != nil {
		return failed(fmt.Errorf("backup failed (data root): %w", err))
	}

	if err := tw.Close(); err != nil {
		return failed(fmt.Errorf("backup failed (tar close): %w", err))
	}
	if err := gz.Close(); err != nil {
		return failed(fmt.Errorf("backup failed (gzip close): %w", err))
	}
	// fsync before declaring success: a backup that is only in the page cache is not a backup.
	if err := out.Sync(); err != nil {
		return failed(fmt.Errorf("backup failed (sync): %w", err))
	}
	if err := out.Close(); err != nil {
		os.Remove(fullPath)
		return fmt.Errorf("backup failed (close): %w", err)
	}
	return nil
}

// addDataRootToTar walks the data root, skipping the live database (already captured via VACUUM
// INTO), its WAL/SHM sidecars, the excluded paths, and anything this backup is currently writing.
func addDataRootToTar(tw *tar.Writer, dataRoot string, appConfig config.Interface, excluded map[string]struct{}) error {
	liveDB := filepath.Clean(appConfig.GetString("database.location"))

	return filepath.Walk(dataRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			// A file that vanished mid-walk (a temp file, a rotated log) must not fail the backup.
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		clean := filepath.Clean(path)
		if clean == filepath.Clean(dataRoot) {
			return nil
		}
		if _, skip := excluded[clean]; skip {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		// The live database and its sidecars: captured consistently via VACUUM INTO above. Copying
		// them raw as well would put a torn, inconsistent second copy in the same archive.
		if clean == liveDB || clean == liveDB+"-wal" || clean == liveDB+"-shm" {
			return nil
		}
		// This backup's own temp directory, and any left by an interrupted run.
		if info.IsDir() && strings.HasPrefix(filepath.Base(clean), ".yourphr-backup-") {
			return filepath.SkipDir
		}
		// A staged restore is transient state about a pending operation, not instance data.
		if filepath.Base(clean) == restorePendingName {
			return nil
		}
		// Symlinks are not followed: a link out of the data root would pull in arbitrary files, and
		// a link to a huge tree would silently balloon the archive.
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if info.IsDir() {
			return nil // directories are implied by their entries; empty ones carry nothing
		}
		if !info.Mode().IsRegular() {
			return nil // sockets, devices, fifos
		}

		rel, err := filepath.Rel(dataRoot, clean)
		if err != nil {
			return err
		}
		return addFileToTar(tw, clean, filepath.ToSlash(rel))
	})
}

func addFileToTar(tw *tar.Writer, srcPath, nameInArchive string) error {
	info, err := os.Stat(srcPath)
	if err != nil {
		return err
	}
	hdr, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	hdr.Name = nameInArchive
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(tw, f)
	return err
}
