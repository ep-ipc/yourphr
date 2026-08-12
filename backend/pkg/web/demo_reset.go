package web

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// demoResetArmed reports whether this start should discard the existing database and reinstall the
// one baked into the image (#518).
//
// WHY THE APP AND NOT KUBECTL. Resetting the public demo used to be `kubectl exec … rm` plus a
// rollout restart — the definition of "what a reset is" living outside the product, unusable by a
// self-hoster, and automatable only by giving a CronJob pods/exec on the namespace. Everything else
// a reset needs is already here: the clean database ships in the image, CI rebuilds it every release
// (#505), and RestoreSeedDatabaseIfMissing installs it atomically before anything opens the file.
// The only thing missing was permission to overwrite.
//
// THIS IS THE ONLY CODE PATH THAT DELIBERATELY DESTROYS A LIVE DATABASE, so arming it takes three
// switches — demo.enabled, bootstrap.seed.restore (env-only, #472) and demo.reset_on_restart — and
// then still has to prove the database it is about to delete belongs to a demo. Flags are what an
// operator gets wrong; evidence is not.
//
// An error return means REFUSED, and the caller keeps the database and starts normally. Refusing
// loudly beats both alternatives: deleting records because three booleans said so, or refusing to
// start at all because one of them was set on the wrong host.
func (ae *AppEngine) demoResetArmed(dbPath string) (bool, error) {
	if !ae.Config.GetBool("demo.reset_on_restart") {
		return false, nil
	}

	// The flag alone is not the intent. An instance that is not running as a demo has no business
	// discarding its database on a restart, whatever this key says.
	if !ae.Config.GetBool("demo.enabled") {
		return false, fmt.Errorf("demo.reset_on_restart is set but demo.enabled is not — " +
			"only a demo instance resets itself")
	}

	// The subset check below cannot open an encrypted database, so there would be no evidence left
	// to refuse on. Not a supported combination, and silently skipping the check is exactly the kind
	// of "it seemed safe" that this function exists to avoid.
	if ae.Config.GetBool("database.encryption.enabled") {
		return false, fmt.Errorf("demo.reset_on_restart is not supported with database encryption enabled — " +
			"the existing database cannot be inspected, so this cannot prove it is a demo before deleting it")
	}

	demoUsers := map[string]bool{}
	for _, key := range []string{"demo.username", "demo.admin.username", "bootstrap.admin.username"} {
		if name := strings.ToLower(strings.TrimSpace(ae.Config.GetString(key))); name != "" {
			demoUsers[name] = true
		}
	}

	usernames, err := readUsernames(dbPath)
	if err != nil {
		return false, fmt.Errorf("could not read the existing database to confirm it is a demo: %w", err)
	}

	// An empty user table is a database that predates any account — nothing to protect, and the
	// seed is what should be there.
	unexpected := 0
	for _, username := range usernames {
		if !demoUsers[strings.ToLower(strings.TrimSpace(username))] {
			unexpected++
		}
	}
	if unexpected > 0 {
		// The COUNT, never the names: this line is written on a host that turned out to hold real
		// accounts, and the log is the wrong place to enumerate them.
		return false, fmt.Errorf("the existing database holds %d account(s) that are not the demo, "+
			"the demo admin, or the bootstrap admin — this does not look like a demo instance", unexpected)
	}

	return true, nil
}

// readUsernames opens the database READ-ONLY and lists its accounts. Read-only because this runs
// before the repository exists and must not migrate, create, or touch anything: its whole job is to
// answer one question about a file that is about to be deleted.
func readUsernames(dbPath string) ([]string, error) {
	dsn := fmt.Sprintf("file:%s?mode=ro&_busy_timeout=5000", url.PathEscape(dbPath))
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: gormlogger.Discard,
	})
	if err != nil {
		return nil, err
	}
	// Close before the caller overwrites the file — deleting a database with an open handle is the
	// failure copyFileAtomic already goes out of its way to avoid.
	defer func() {
		if sqlDB, sqlErr := db.DB(); sqlErr == nil {
			_ = sqlDB.Close()
		}
	}()

	var usernames []string
	if err := db.Raw("SELECT username FROM users").Scan(&usernames).Error; err != nil {
		return nil, err
	}
	return usernames, nil
}

// discardDerivedState removes what a restored database invalidates but does not itself replace.
//
// The cache is derived data keyed to source IDs that will not exist after the swap. The JWT signing
// key is subtler: it lives beside the database and SURVIVES one being replaced, so tokens minted
// before a reset still verify — against user IDs that are gone. A returning visitor gets errors
// from every request instead of a sign-in page. Rotating it signs everyone out cleanly, which is
// what a reset should mean. config.ResolveJWTIssuerKey regenerates one on the next start.
//
// The custom config file is deliberately NOT removed: it holds demo.enabled and the operator's
// settings, and a reset that unconfigured the instance would need an operator to bring the demo
// back — the exact manual step this feature removes.
func (ae *AppEngine) discardDerivedState() error {
	dataDir := config.DataDir(ae.Config)

	for _, path := range []string{
		ae.Config.GetString("cache.location"),
		config.JWTIssuerKeyPath(dataDir),
	} {
		if strings.TrimSpace(path) == "" {
			continue
		}
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			continue
		} else if err != nil {
			return fmt.Errorf("could not check %s: %w", path, err)
		}
		// Files only. cache.location ships as a DIRECTORY path (/opt/fasten/cache/) even though the
		// demo points it at a file, and recursively deleting a configured directory is how a reset
		// would take something with it that nobody meant to lose. A stale cache directory is
		// harmless by comparison.
		if info.IsDir() {
			ae.Logger.Warnf("demo reset: %s is a directory; leaving it in place", path)
			continue
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("could not remove %s: %w", path, err)
		}
	}
	return nil
}
