package config

import (
	"path/filepath"
	"strings"
)

// Built-in path defaults, referenced by config.Init so the literals live in one place.
//
// Do NOT use these to infer whether an operator configured a path: a configured value that
// equals the default is indistinguishable from an unset one, which is exactly the mistake that
// broke v1.21.0. See ResolveStoragePaths.
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

// ResolveStoragePaths is retained as an explicit no-op so callers and future readers find this
// note rather than reinventing the bug.
//
// It used to relocate database.location and cache.location under storage.data_dir whenever
// those keys were "still at their built-in defaults", detected by comparing against the default
// constants. That took down prod and demo on v1.21.0.
//
// The reason is worth keeping: an operator setting a key to a value that HAPPENS TO EQUAL the
// default is indistinguishable, by value comparison, from nobody setting it. Both instances'
// ConfigMaps set database.location to /opt/fasten/db/fasten.db — exactly the default string —
// so the check read a deliberate configuration as unset and relocated the DB to
// /opt/fasten/db/db/fasten.db. The database was not there, and the backend crash-looped on
// "unable to open database file".
//
// Viper cannot answer "did anyone actually set this?" — IsSet reports true for a defaulted key,
// and reconstructing the answer from InConfig plus env plus overrides is a pile of guesswork
// guarding a feature worth very little: every real deployment configures database.location
// explicitly, and a fresh install already lands at /opt/fasten/db/fasten.db by default. The
// derivation only ever mattered for a case that resolves correctly without it.
//
// So storage.data_dir now does exactly one thing: name the directory that holds what the
// instance owns and must not lose — the custom config store, the generated JWT signing key,
// backups. It never moves the database or the cache. See DataDir and #451.
//
// Deprecated: does nothing. Kept so the startup call site stays greppable to this explanation.
func ResolveStoragePaths(_ Interface) {}
