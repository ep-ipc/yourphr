package database

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

// The happy path must leave nothing behind. A test that litters the destination is one an operator
// finds later and cannot explain.
func TestBackupDestination_WritableDirectoryLeavesNoTrace(t *testing.T) {
	dir := t.TempDir()

	require.NoError(t, TestBackupDestination(dir))

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Empty(t, entries, "the marker file must be removed on success")
}

// The whole point of yourphr#468: a schedule pointing at a directory that does not exist used to
// save happily and fail at 02:00 every night.
func TestBackupDestination_MissingDirectoryReportsTheRealError(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "not", "created")

	err := TestBackupDestination(missing)

	require.Error(t, err)
	require.ErrorIs(t, err, os.ErrNotExist,
		"the caller shows this to an operator, so it must be the real OS error, not a generic message")
}

// Deliberate: creating the directory would turn a typo into a stray folder somewhere unexpected.
func TestBackupDestination_DoesNotCreateTheDirectory(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "should-not-appear")

	require.Error(t, TestBackupDestination(missing))

	_, err := os.Stat(missing)
	require.ErrorIs(t, err, os.ErrNotExist, "the test must not create what it is testing")
}

func TestBackupDestination_ReadOnlyDirectoryFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := t.TempDir()
	require.NoError(t, os.Chmod(dir, 0o500)) // r-x: listable, not writable
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	err := TestBackupDestination(dir)

	require.Error(t, err)
	require.ErrorIs(t, err, os.ErrPermission)
}

// A file is not a folder. Without this, the marker write fails with a confusing "not a directory"
// deep in the syscall rather than a statement about what was passed.
func TestBackupDestination_RejectsAFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a-file")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))

	err := TestBackupDestination(file)

	require.Error(t, err)
	require.Contains(t, err.Error(), "not a directory")
}

// Path hygiene retained from AllowedBackupRoots (yourphr#469): a relative path is meaningless
// against a server whose working directory the operator cannot see.
func TestBackupDestination_RejectsRelativeAndEmpty(t *testing.T) {
	require.ErrorContains(t, TestBackupDestination(""), "empty")
	require.ErrorContains(t, TestBackupDestination("  "), "empty")
	require.ErrorContains(t, TestBackupDestination("relative/path"), "absolute")
	require.ErrorContains(t, TestBackupDestination("./also-relative"), "absolute")
}

// An interrupted earlier test leaves a marker behind. O_EXCL would then fail on our own litter and
// report a perfectly healthy destination as broken.
func TestBackupDestination_RecoversFromAStaleMarker(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, TestedDestinationMarker)
	require.NoError(t, os.WriteFile(stale, []byte("left over from an interrupted run"), 0o600))

	require.NoError(t, TestBackupDestination(dir), "a stale marker must not make a good path look bad")

	_, err := os.Stat(stale)
	require.ErrorIs(t, err, os.ErrNotExist)
}

// Symlinked destinations are ordinary on a NAS mount; following one must work.
func TestBackupDestination_FollowsASymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privilege on Windows")
	}
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link-to-backups")
	require.NoError(t, os.Symlink(real, link))

	require.NoError(t, TestBackupDestination(link))
}
