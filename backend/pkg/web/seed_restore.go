package web

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// RestoreSeedDatabaseIfMissing installs a pre-built demo database when this instance has none
// (#505), so a demo host comes up already populated and resetting it is "delete the file, restart".
//
// WHY IN THE APP rather than an initContainer. The runtime image is distroless — no shell, nothing
// to copy with — so a Kubernetes initContainer would need a second image mounting the same volume.
// Doing it here also works for docker-compose self-hosters, and it is the only place that can
// enforce the bootstrap-admin precondition below.
//
// MUST RUN BEFORE THE DATABASE IS OPENED. Same rule as ApplyPendingRestore: never swap a file that
// something already holds open.
//
// THE PRECONDITION THAT MATTERS. A seed contains the demo account and NO admin — deliberately,
// because the image is public and a baked admin credential would be a published one, identical on
// every deployment. So an instance that restores a seed without bootstrap admin configured (#504)
// would start with users but no administrator, and with the first-run wizard suppressed because
// users exist: reachable, populated, and administrable by nobody. This refuses that combination
// outright rather than producing it.
func (ae *AppEngine) RestoreSeedDatabaseIfMissing() error {
	if !ae.Config.GetBool("bootstrap.seed.restore") {
		return nil
	}

	dbPath := ae.Config.GetString("database.location")
	if _, err := os.Stat(dbPath); err == nil {
		// The normal path on every restart. Restoring over a live database would destroy whatever a
		// visitor or an operator has done since — unless this instance is a demo that has explicitly
		// asked for exactly that (#518).
		if reset, resetErr := ae.demoResetArmed(dbPath); resetErr != nil {
			// Refused, not failed: an instance that cannot prove it is a demo keeps its database and
			// starts normally. Fatal here would mean a misconfigured flag takes the instance down.
			ae.Logger.Errorf("demo reset: refusing to reset %s: %v", dbPath, resetErr)
			return nil
		} else if !reset {
			ae.Logger.Debugf("seed restore: %s already exists; nothing to restore", dbPath)
			return nil
		}

		ae.Logger.Warnf("demo reset: replacing %s with the bundled demo database — every account and "+
			"record in it is being discarded (demo.reset_on_restart)", dbPath)
		if err := ae.discardDerivedState(); err != nil {
			return fmt.Errorf("demo reset: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("seed restore: could not check %s: %w", dbPath, err)
	}

	if !ae.Config.GetBool("bootstrap.admin.enabled") {
		return fmt.Errorf("seed restore: refusing to restore a seed database while " +
			"bootstrap.admin.enabled is false — the seed contains no admin account, so this instance " +
			"would start populated and administrable by nobody (set YOURPHR_BOOTSTRAP_ADMIN_ENABLED=true " +
			"and YOURPHR_BOOTSTRAP_ADMIN_USERNAME, or turn off YOURPHR_BOOTSTRAP_SEED_RESTORE)")
	}

	seedPath := ae.Config.GetString("bootstrap.seed.path")
	if seedPath == "" {
		return fmt.Errorf("seed restore: bootstrap.seed.restore is on but bootstrap.seed.path is empty")
	}
	if _, err := os.Stat(seedPath); err != nil {
		// Naming the path matters: the usual cause is an image built without the seed baked in, and
		// "no such file" alone sends someone looking in the wrong place.
		return fmt.Errorf("seed restore: no seed database at %s: %w", seedPath, err)
	}

	if err := copyFileAtomic(seedPath, dbPath); err != nil {
		return fmt.Errorf("seed restore: could not install %s at %s: %w", seedPath, dbPath, err)
	}

	ae.Logger.Warnf("seed restore: installed the bundled demo database from %s at %s — this instance "+
		"now holds SYNTHETIC records and a shared demo account, not real data", seedPath, dbPath)
	return nil
}

// copyFileAtomic writes to a temporary file beside the destination and renames it into place, so an
// interrupted copy cannot leave a truncated database that the app would then open and migrate.
func copyFileAtomic(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp, err := os.CreateTemp(filepath.Dir(dst), filepath.Base(dst)+".seed-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds

	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return err
	}
	// fsync before rename: a crash between the two would otherwise leave a correctly-named file with
	// unflushed contents, which is the one failure this function exists to avoid.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, dst)
}
