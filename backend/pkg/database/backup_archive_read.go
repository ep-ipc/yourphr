package database

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ExtractedBackup is what a restore candidate yielded on disk.
type ExtractedBackup struct {
	// DBPath is the uncompressed SQLite database. Always set on success.
	DBPath string
	// ConfigDir is the extracted instance config store, or "" when the archive had none (every
	// legacy *.db.gz backup, and any archive from an instance that never customised anything).
	ConfigDir string
	// HadJWTKey reports whether the archive carried a signing key. It is never extracted for use —
	// see RestoreJWTKeyPolicy — but the operator is told it was there.
	HadJWTKey bool
	// Legacy reports that this was a database-only *.db.gz backup rather than a data-root archive.
	Legacy bool

	cleanup func()
}

// Close removes the temporary extraction directory.
func (e *ExtractedBackup) Close() {
	if e != nil && e.cleanup != nil {
		e.cleanup()
	}
}

// tarMagicOffset/tarMagic locate the POSIX ustar signature inside a tar header block.
const (
	tarMagicOffset = 257
	tarMagic       = "ustar"
)

// OpenBackupCandidate decompresses a restore candidate and reports what it contains.
//
// Format is detected by CONTENT, not by filename. Users rename backups — filenames arrive with
// " (1)" appended by a browser, or with the extension stripped by a NAS — and refusing a valid
// archive because of its name turns a restore into data loss at the worst possible moment.
//
// Accepts both:
//   - the whole-data-root archive (gzip -> tar), yourphr#467
//   - the legacy database-only backup (gzip -> SQLite, or a bare uncompressed SQLite file)
//
// Legacy support is not optional. Existing backups are the ones people actually have; a restore
// path that only understands the new format makes an upgrade destroy the ability to recover.
func OpenBackupCandidate(srcPath string) (*ExtractedBackup, error) {
	raw, cleanup, err := decompressIfNeeded(srcPath)
	if err != nil {
		return nil, err
	}

	isTar, err := looksLikeTar(raw)
	if err != nil {
		cleanup()
		return nil, err
	}

	if !isTar {
		// Legacy: the decompressed file IS the database.
		return &ExtractedBackup{DBPath: raw, Legacy: true, cleanup: cleanup}, nil
	}

	dir, err := os.MkdirTemp("", "yourphr-restore-")
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("could not create extraction directory: %w", err)
	}
	combined := func() {
		os.RemoveAll(dir)
		cleanup()
	}

	extracted, err := extractArchive(raw, dir)
	if err != nil {
		combined()
		return nil, err
	}
	extracted.cleanup = combined

	if extracted.DBPath == "" {
		combined()
		return nil, fmt.Errorf("the archive contains no %s — it is not a YourPHR backup", ArchiveDBName)
	}
	return extracted, nil
}

// looksLikeTar checks for the POSIX ustar magic rather than trusting the filename.
func looksLikeTar(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()

	buf := make([]byte, tarMagicOffset+len(tarMagic))
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return false, err
	}
	if n < tarMagicOffset+len(tarMagic) {
		return false, nil // too small to be a tar; a SQLite database this small is also not valid
	}
	return string(buf[tarMagicOffset:tarMagicOffset+len(tarMagic)]) == tarMagic, nil
}

// extractArchive unpacks the members a restore cares about into dir.
func extractArchive(tarPath, dir string) (*ExtractedBackup, error) {
	f, err := os.Open(tarPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	out := &ExtractedBackup{}
	tr := tar.NewReader(f)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("could not read the archive: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue // directories are implied; links and devices are never written by us
		}

		name, err := safeArchivePath(hdr.Name)
		if err != nil {
			// A crafted archive, or a corrupt one. Either way this must not write outside dir.
			return nil, err
		}

		switch {
		case name == ArchiveDBName:
			dst := filepath.Join(dir, ArchiveDBName)
			if err := writeExtracted(tr, dst, 0o600); err != nil {
				return nil, err
			}
			out.DBPath = dst

		case name == ArchiveJWTKeyName:
			// Recorded, never extracted. See RestoreJWTKeyPolicy.
			out.HadJWTKey = true

		case strings.HasPrefix(name, ArchiveConfigDir+"/"):
			dst := filepath.Join(dir, name)
			if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
				return nil, err
			}
			if err := writeExtracted(tr, dst, 0o600); err != nil {
				return nil, err
			}
			out.ConfigDir = filepath.Join(dir, ArchiveConfigDir)
		}
		// Anything else in the archive is ignored rather than rejected: a future version may add
		// members, and an older instance must still be able to restore what it does understand.
	}
	return out, nil
}

// safeArchivePath rejects absolute paths and any ".." escape (the "zip slip" class), so a crafted
// archive cannot write outside the extraction directory. A backup is a file an operator copies from
// a NAS, so it is not automatically trustworthy input.
func safeArchivePath(name string) (string, error) {
	slashed := filepath.ToSlash(name)

	// Checked BEFORE cleaning, and rejected rather than neutralised. filepath.Clean("/../outside")
	// silently yields "outside", which is safe but quietly changes what the archive asked for — and
	// a member that asked to escape is evidence about the archive, not a path to tidy up.
	for _, seg := range strings.Split(slashed, "/") {
		if seg == ".." {
			return "", fmt.Errorf("archive contains an unsafe path: %q", name)
		}
	}

	cleaned := strings.TrimPrefix(filepath.ToSlash(filepath.Clean("/"+strings.TrimPrefix(slashed, "/"))), "/")
	if cleaned == "" || cleaned == "." {
		return "", fmt.Errorf("archive contains an empty path")
	}
	return cleaned, nil
}

func writeExtracted(r io.Reader, dst string, mode os.FileMode) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
