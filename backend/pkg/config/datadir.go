package config

import (
	"path/filepath"
	"strings"
)

// Built-in path defaults. Kept as constants because ResolveStoragePaths has to distinguish
// "the operator chose this path" from "nobody set it, this is just the default" — viper's
// IsSet reports true for a value that came from SetDefault, so comparing against the default
// is the only way to tell the two apart.
const (
	DefaultDatabaseLocation = "/opt/fasten/db/fasten.db"
	DefaultCacheLocation    = "/opt/fasten/cache/"
)

// DataDir returns the instance data root — the one directory holding everything an instance
// owns and must not lose: the database, the generated JWT signing key, backups, the cache,
// and the settings files. Back it up, mount it as a volume, and an instance survives being
// replaced.
//
// Resolution order:
//
//  1. an explicit storage.data_dir (YOURPHR_STORAGE_DATA_DIR) is honored as-is;
//  2. otherwise it is derived from database.location's parent directory.
//
// The fallback is for upgrades. Before this key existed, every consumer independently called
// filepath.Dir on the database path, so "where does this instance keep its state" was an
// emergent property of where the operator happened to put the DB file. Deriving the same way
// when storage.data_dir is unset means an existing install keeps its exact layout.
func DataDir(c Interface) string {
	if dir := strings.TrimSpace(c.GetString("storage.data_dir")); dir != "" {
		return dir
	}
	return filepath.Dir(c.GetString("database.location"))
}

// ResolveStoragePaths makes the data root primary: when storage.data_dir is set and a path
// key is still at its built-in default, that path is relocated under the data root. Call it
// once at startup, after every config layer has been merged (defaults, env, config file, CLI)
// and before anything reads a path.
//
// Resulting layout under a configured data root:
//
//	<data_dir>/db/fasten.db     database.location
//	<data_dir>/cache/           cache.location
//	<data_dir>/backups/         backups
//	<data_dir>/.jwt_issuer_key  generated signing key
//	<data_dir>/...              settings files
//
// An explicitly configured database.location or cache.location always wins — setting both a
// data root and an absolute DB path is a legitimate split (DB on fast local disk, everything
// else elsewhere), so this never overrides an operator's stated choice.
//
// No-op when storage.data_dir is unset, which keeps the pre-#451 layout byte-identical.
func ResolveStoragePaths(c Interface) {
	root := strings.TrimSpace(c.GetString("storage.data_dir"))
	if root == "" {
		return
	}

	if c.GetString("database.location") == DefaultDatabaseLocation {
		c.Set("database.location", filepath.Join(root, "db", "fasten.db"))
	}
	if c.GetString("cache.location") == DefaultCacheLocation {
		c.Set("cache.location", filepath.Join(root, "cache"))
	}
}
