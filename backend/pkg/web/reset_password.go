package web

import (
	"context"
	"fmt"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/sirupsen/logrus"
)

// policyAttempts bounds the retry loop below. A generated password can fail the instance's own
// policy — most plausibly because a short username happens to appear inside random base64 — and a
// handful of attempts makes that vanishingly unlikely without risking an unbounded loop if an
// operator has configured a policy nothing random can satisfy.
const policyAttempts = 8

// ResetUserPassword sets a generated password for one account, for the case where nobody can sign in
// at all (#510).
//
// WHY THIS EXISTS. There is no password reset of any kind in the product: no reset route, no SMTP
// client, and "Forgot password?" on the sign-in page is a link with no target. The only way to
// change a password is POST /api/secure/account/password, which requires already being signed in AND
// knowing the current one. So recovery meant hand-editing the database — generating a bcrypt cost-14
// hash externally and running an UPDATE. That has actually been done twice, and it is why
// demo.yourphr.org's admin account was unreachable for a whole release cycle.
//
// The admin-initiated reset (#511) does not cover this. It needs an admin session, and the case that
// keeps happening is that the ONLY admin is locked out.
//
// GENERATED, NOT SUPPLIED, for the same reason as #504: a password typed on a command line lands in
// shell history and gets reused. The value is written 0600 to the same file bootstrap admin uses,
// including its self-delete on first sign-in, rather than inventing a second mechanism — and the
// caller is told the PATH, never the value, so it stays out of history, CI logs and screen shares.
//
// Returns the path the password was written to.
func ResetUserPassword(appConfig config.Interface, repo database.DatabaseRepository, logger *logrus.Entry, username string) (string, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return "", fmt.Errorf("a username is required")
	}

	ctx := context.Background()

	// Confirm the account first, so a typo produces "no such user" rather than a password file for an
	// account that does not exist — which would send an operator to a credential that cannot work.
	user, err := repo.GetUserByUsername(ctx, username)
	if err != nil || user == nil || user.Username == "" {
		return "", fmt.Errorf("no user named %q on this instance", username)
	}

	// The generated value must satisfy the instance's OWN policy (#506). Otherwise this command could
	// hand out a password that the change-password screen would then refuse, which is the same class
	// of mistake as the demo seed built with a password our sign-in form rejected (#505).
	policy := auth.PasswordPolicyFromConfig(appConfig)
	var password string
	for attempt := 0; attempt < policyAttempts; attempt++ {
		candidate, genErr := generateBootstrapPassword()
		if genErr != nil {
			return "", fmt.Errorf("could not generate a password: %w", genErr)
		}
		if policy.ValidatePassword(username, candidate) == nil {
			password = candidate
			break
		}
	}
	if password == "" {
		return "", fmt.Errorf("could not generate a password satisfying this instance's password policy after %d attempts — check password.min_length and password.max_length", policyAttempts)
	}

	// HashPassword writes into the model, so hash on a throwaway: UpdateUserPassword takes an
	// ALREADY-HASHED value. Handing it plaintext would store a password in the clear; handing
	// CreateUser a hash would store a hash of a hash. The two take opposite things, which is how #504
	// shipped broken the first time.
	hashed := &models.User{}
	if err := hashed.HashPassword(password); err != nil {
		return "", fmt.Errorf("could not hash the generated password: %w", err)
	}

	// Write the file BEFORE changing the password. If the write fails afterwards, the account has a
	// password nobody knows — which is the exact state this command exists to get out of.
	bootstrapFile := BootstrapAdminPasswordPath(appConfig)
	if err := writeBootstrapPassword(bootstrapFile, password); err != nil {
		return "", fmt.Errorf("could not write %s: %w", bootstrapFile, err)
	}

	// UpdateUserPassword resolves the account from the context, the same way a request does.
	userCtx := context.WithValue(ctx, pkg.ContextKeyTypeAuthUsername, user.Username)
	if err := repo.UpdateUserPassword(userCtx, hashed.Password); err != nil {
		return "", fmt.Errorf("could not set the password for %q: %w", username, err)
	}

	// End every session that account already had (#508). A reset is usually a response to losing
	// control of an account, so leaving the previous sessions alive would defeat the point — and this
	// is the command reached for precisely when something has gone wrong.
	if err := repo.BumpUserTokenGeneration(ctx, user.Username); err != nil {
		// The password IS changed by this point, so this is not a failure of the reset — but the old
		// sessions are still alive, which the operator needs to know.
		logger.Warnf("password for %q was reset, but existing sessions could not be revoked: %v", username, err)
	}

	// The path, never the value.
	logger.Infof("reset the password for %q; the new password is in %s", username, bootstrapFile)
	return bootstrapFile, nil
}
