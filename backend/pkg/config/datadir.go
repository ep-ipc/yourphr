package config

import (
	"path/filepath"
	"strings"
)

// DataDir returns the instance data root — the single directory that holds everything an
// instance owns and that must survive a container replacement: the SQLite database, the
// generated JWT signing key, backups, and the per-concern settings files.
//
// Resolution order:
//
//  1. an explicit storage.data_dir (YOURPHR_STORAGE_DATA_DIR) is honored as-is;
//  2. otherwise it is derived from database.location's parent directory.
//
// The fallback exists so upgrading installs keep the exact layout they already have —
// before this key existed, every consumer independently computed filepath.Dir on the
// database path, which made "where does this instance keep its state" an emergent
// property of where the operator happened to put the DB file rather than a decision.
// New installs should set storage.data_dir and let database.location default under it.
func DataDir(c Interface) string {
	if dir := strings.TrimSpace(c.GetString("storage.data_dir")); dir != "" {
		return dir
	}
	return filepath.Dir(c.GetString("database.location"))
}
