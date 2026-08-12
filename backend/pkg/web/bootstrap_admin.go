package web

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
)

// BootstrapAdminPasswordFile is the name, inside the data root, of the file holding the generated
// password. Exported so the delete-after-first-login path and the tests name the same thing.
const BootstrapAdminPasswordFile = ".admin_bootstrap_password"

// bootstrapAdminPasswordBytes is the entropy of the generated password. 24 random bytes is 192
// bits; base64 makes it 32 printable characters, which is short enough to paste out of a terminal
// and long enough that the bcrypt cost is the least of an attacker's problems.
const bootstrapAdminPasswordBytes = 24

// ProvisionBootstrapAdmin creates the instance's admin account at startup, with a password this
// process generates and nobody chose (#504).
//
// WHY. The first account created on an empty database becomes the owner and admin
// (handler.AuthSignup), and it is the only way an admin comes into existence — no seeded admin, no
// CLI user-create, no password reset. On a LAN that is fine. On a public host it is a race: the
// first-run wizard is offered to whoever arrives first, so an anonymous visitor can claim
// ownership of the instance in the window between "reachable" and "the operator signed up". The
// demo host has exactly that shape, and its runbook could only say "register immediately", which
// is advice rather than a mechanism.
//
// WHY GENERATED RATHER THAN SUPPLIED. A supplied password lives in a cluster secret, a .env, or a
// CI log, and gets reused across instances; baked into a release image it would be a published
// credential, identical on every deployment of that image. Generated here it is unique per
// instance, rotates whenever the database is rebuilt, and exists in exactly one place: a 0600 file
// in the data root, which the operator reads once.
//
// OFF BY DEFAULT, deliberately. A stock install must still show the first-run wizard and let the
// human become owner — replacing that with "read a password out of a file" is worse for someone
// running docker-compose at home. This is for deployments that are provisioned rather than
// clicked through.
//
// Provisioning is ONE-WAY and only ever acts on an instance with NO admin: it never re-provisions,
// never overwrites an account, and never changes an existing password. Same rule as the sandbox
// credential seeding, which stops as soon as a client_id exists. That matters because the flag
// stays set for the life of the deployment — every restart re-runs this, and every restart after
// the first must do nothing.
func (ae *AppEngine) ProvisionBootstrapAdmin() error {
	if !ae.Config.GetBool("bootstrap.admin.enabled") {
		return nil
	}

	username := ae.Config.GetString("bootstrap.admin.username")
	if username == "" {
		// Enabled but unnamed is an operator mistake, and guessing a username would create an
		// account they do not know about. Loud, and not fatal: the instance still starts and still
		// offers the first-run wizard.
		ae.Logger.Warnf("bootstrap.admin.enabled is set but bootstrap.admin.username is empty; no admin was provisioned")
		return nil
	}

	// A reserved name is ALLOWED here (#519). The deny-list protects self-service registration from
	// someone choosing `admin` and messaging other users as if they were staff; this name comes from
	// the operator's own configuration, so that threat does not apply — and "admin" is the first
	// thing every operator tries. Logged rather than silent, because it is worth seeing in the
	// record that this instance's administrator holds a name the deny-list would otherwise refuse.
	if isReservedBootstrapUsername(username) {
		ae.Logger.Infof("bootstrap admin: provisioning %q, a name reserved against self-service signup — "+
			"allowed because it was configured by the operator", username)
	}

	// Trigger on "this instance has no ADMIN", not "this instance has no users".
	//
	// The first version keyed on GetUserCount() == 0, which cannot support a pre-seeded database
	// (#505): a seed contains the demo user, so userCount is already 1, provisioning would never
	// fire, and the instance would come up with users and NO admin — administrable by nobody, and
	// with the first-run wizard suppressed because userCount > 0. The same state is reachable today
	// if the only admin deletes their own account.
	//
	// Keying on the absence of an admin makes provisioning the answer to that state rather than a
	// bystander to it. It stays a no-op on every ordinary restart, because an admin exists.
	users, err := ae.deviceRepo.GetUsers(context.Background())
	if err != nil {
		return fmt.Errorf("bootstrap admin: could not list users: %w", err)
	}
	// The read-only demo admin (#516) does not count. It is a public entrance that cannot change
	// anything, so an instance holding only that account still has no administrator — and counting it
	// would suppress provisioning and leave the operator with no way in at all.
	demoAdmin := strings.TrimSpace(ae.Config.GetString("demo.admin.username"))
	for _, user := range users {
		if user.Role != pkg.UserRoleAdmin {
			continue
		}
		if demoAdmin != "" && strings.EqualFold(user.Username, demoAdmin) {
			continue
		}
		// The normal path on every restart after the first. Not worth a log line above debug.
		ae.Logger.Debugf("bootstrap admin: %q is already an admin; nothing to provision", user.Username)
		return nil
	}

	// Never collide with an existing account. Creating would fail on the unique index anyway, but a
	// clear warning beats a database error — and silently "adopting" someone else's account by
	// resetting its password is exactly what this must not do.
	for _, user := range users {
		if strings.EqualFold(user.Username, username) {
			return fmt.Errorf("bootstrap admin: %q already exists but is not an admin; "+
				"refusing to touch it — set YOURPHR_BOOTSTRAP_ADMIN_USERNAME to a different name", username)
		}
	}

	if len(users) > 0 {
		// Worth INFO: an instance with users but no admin is unusual, and this is the line that
		// explains where the new account came from.
		ae.Logger.Infof("bootstrap admin: %d user(s) exist but none is an admin; provisioning %q", len(users), username)
	}

	password, err := generateBootstrapPassword()
	if err != nil {
		return fmt.Errorf("bootstrap admin: could not generate a password: %w", err)
	}

	// PLAINTEXT here, deliberately: the repository calls HashPassword on the value it is
	// given (gorm_common.go:47). Pre-hashing produces a hash OF a hash, and the account then cannot
	// be signed into at all — verified the hard way against a running instance, after unit tests that
	// checked the hash this function produced rather than what the repository stored.
	user := &models.User{Username: username, Password: password, Role: pkg.UserRoleAdmin}

	// Write the password BEFORE creating the account. If the write fails, an account exists whose
	// password nobody knows and which suppresses the first-run wizard — an instance
	// nobody can administer. Failing before the account is created leaves the wizard available.
	//
	// Named bootstrapFile, not passwordPath: it holds a filesystem path, and CodeQL's
	// go/clear-text-logging rule flags any identifier containing "password" that reaches a log
	// sink — two high-severity false positives, on the one code path whose whole promise is that
	// it logs the path and never the value. The accurate name costs nothing and keeps the scanner
	// signal meaningful instead of teaching us to dismiss it.
	bootstrapFile := BootstrapAdminPasswordPath(ae.Config)
	if err := writeBootstrapPassword(bootstrapFile, password); err != nil {
		return fmt.Errorf("bootstrap admin: could not write %s: %w", bootstrapFile, err)
	}

	// CreateProvisionedUser, not CreateUser: this name came from the operator's configuration, so it
	// may be one the reserved list refuses for self-service signup (#519).
	if err := ae.deviceRepo.CreateProvisionedUser(context.Background(), user); err != nil {
		// Best-effort cleanup: leaving a password file for an account that does not exist would
		// send the operator to a credential that cannot work.
		_ = os.Remove(bootstrapFile)
		return fmt.Errorf("bootstrap admin: could not create the %q account: %w", username, err)
	}

	// The path, never the value. This line is the whole discovery mechanism, so it is INFO.
	ae.Logger.Infof("bootstrap admin: created %q; its generated password is in %s (delete that file once you have stored the password)", username, bootstrapFile)
	return nil
}

// BootstrapAdminPasswordPath is where the generated password is written. Inside the data root
// because that is the one directory an operator can always reach — and note it is therefore inside
// the backup boundary (#466), which is why the file is meant to be short-lived.
func BootstrapAdminPasswordPath(appConfig config.Interface) string {
	return filepath.Join(config.DataDir(appConfig), BootstrapAdminPasswordFile)
}

// reservedBootstrapUsernames mirrors the repository's own deny-list (gorm_common.go). Since #519 a
// reserved name here is allowed rather than refused, so this exists only to LOG that it happened.
// Duplicated rather than exported from there so the check needs no database call;
// TestReservedBootstrapUsernamesMatchRepository fails if the two drift.
var reservedBootstrapUsernames = map[string]bool{
	"admin": true, "administrator": true, "api": true, "contact": true, "fasten": true,
	"help": true, "info": true, "login": true, "mail": true, "noreply": true,
	"postmaster": true, "root": true, "security": true, "support": true, "system": true,
	"webmaster": true, "www": true,
}

func isReservedBootstrapUsername(username string) bool {
	return reservedBootstrapUsernames[strings.ToLower(strings.TrimSpace(username))]
}

// generateBootstrapPassword returns a URL-safe random string. crypto/rand, not math/rand: this is
// the instance's administrative credential.
func generateBootstrapPassword() (string, error) {
	buf := make([]byte, bootstrapAdminPasswordBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// writeBootstrapPassword writes the password 0600, creating it exclusively so an existing file is
// never silently overwritten (that file could be the credential for the account we are about to
// decline to replace). No trailing newline: the operator pipes this value around, and a stray
// newline in a password is a support ticket.
func writeBootstrapPassword(path, password string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(password); err != nil {
		return err
	}
	return f.Chmod(0o600)
}

// ClearBootstrapAdminPassword removes the password file once it has served its purpose — the admin
// has signed in, so the credential is in their hands and no longer needs to sit on disk. Called
// from the signin path.
//
// The data root is by definition what a backup contains (#466), so a file left here would ride
// inside every backup archive taken afterwards. Deleting it on first use bounds that exposure to
// the window before the operator ever logs in.
//
// Silent about a missing file: not finding it is the expected case on every login after the first.
func ClearBootstrapAdminPassword(appConfig config.Interface) error {
	err := os.Remove(BootstrapAdminPasswordPath(appConfig))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Compile-time check that the repository we are handed still exposes what provisioning needs.
var _ interface {
	GetUsers(context.Context) ([]models.User, error)
	CreateProvisionedUser(context.Context, *models.User) error
} = (database.DatabaseRepository)(nil)
