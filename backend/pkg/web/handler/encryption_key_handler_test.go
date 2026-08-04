package handler

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// The distinction the minimum-length rule hangs on.
//
// A fresh instance is about to create its database, so a weak key can still be refused with no
// cost. An instance whose database already exists has a key that is not negotiable: the UI has
// already confirmed it by opening the database with it, and refusing it at that point would lock
// the operator out of their own records to enforce a rule that can no longer change anything.
func TestDatabaseExists(t *testing.T) {
	dir := t.TempDir()

	present := filepath.Join(dir, "fasten.db")
	require.NoError(t, os.WriteFile(present, []byte("not really sqlite"), 0o600))
	require.True(t, databaseExists(present))

	require.False(t, databaseExists(filepath.Join(dir, "absent.db")))

	// An unset location cannot name an existing database.
	require.False(t, databaseExists(""))
}

// Anything that is not "no such file" must read as "exists", because guessing "fresh" for a
// database that is merely unreadable would apply the rule to an existing instance — the lockout
// this split exists to prevent.
func TestDatabaseExists_UnreadableCountsAsExisting(t *testing.T) {
	dir := t.TempDir()
	locked := filepath.Join(dir, "locked")
	require.NoError(t, os.Mkdir(locked, 0o000))
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions, so the stat would succeed")
	}
	require.True(t, databaseExists(filepath.Join(locked, "fasten.db")),
		"a permission error must not be mistaken for a fresh install")
}
