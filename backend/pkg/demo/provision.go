// Package demo provisions the credentials a public demo instance signs visitors in with (#515).
//
// It lives outside pkg/web so both the startup path (AppEngine) and the admin configuration handler
// can call it. Turning demo mode on from Admin -> Configuration has to provision the credential
// there and then; requiring a restart would make "flip the switch" a two-step operation whose second
// step is easy to forget and whose symptom is a demo button that refuses every visitor.
package demo

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/sirupsen/logrus"
)

// credentialBytes is the entropy of a generated demo password. 24 random bytes is 192 bits, base64
// to 32 printable characters. Nobody types it, so there is no reason for it to be shorter.
const credentialBytes = 24

// ProvisionCredential makes sure the demo account has a password this process generated and nobody
// knows, and that `demo.password` holds it (#515).
//
// WHY GENERATED. POST /api/auth/demo-signin posts no credentials — the server verifies
// `demo.password` against the stored hash and mints the token — so a visitor never needs to know
// one. The only thing a human-chosen value bought was the ability to type it at the login form,
// which nobody needs to do, and it cost: `demo123` was seven characters against a form that enforces
// eight, so the seed built cleanly and then rejected our own published credential; `demo1234`
// collides with the password policy in #506 because it contains the username; and because the seed
// ships inside a public image, whatever it holds is a published credential identical on every
// deployment. Generated per instance, none of that applies.
//
// WHY THE HASH CHECK SURVIVES. It would be simpler to drop `demo.password` and mint a token for
// whoever `demo.username` names. That turns one mis-set flag into an auth bypass: `demo.enabled` on
// an instance that happens to hold a user called `demo` — the shipped default — would sign anybody
// in as them. Keeping the verify means a flag flipped without provisioning does nothing at all.
//
// IDEMPOTENT. The normal path on every restart is "the configured password already verifies", and
// this returns having touched nothing. It regenerates only when the two have drifted apart, which is
// what a freshly restored seed (#505) looks like: a new database whose demo account carries the
// throwaway hash the seed builder used.
//
// NOT FATAL. A demo that cannot provision its credential is a demo with no way in, which is worth a
// loud log line — but not worth refusing to start an instance over. Contrast bootstrap admin (#504),
// where failing to provision leaves an instance that is reachable and unowned.
func ProvisionCredential(ctx context.Context, appConfig config.Interface, repo database.DatabaseRepository, logger *logrus.Entry) error {
	if !appConfig.GetBool("demo.enabled") {
		return nil
	}

	username := appConfig.GetString("demo.username")
	if username == "" {
		logger.Warnf("demo mode is enabled but demo.username is empty; no demo credential was provisioned")
		return nil
	}

	user, err := repo.GetUserByUsername(ctx, username)
	if err != nil || user == nil {
		// Reachable and expected on an instance where demo mode was turned on before the demo
		// account exists. Not an error to fail startup over: create the account and restart, or
		// toggle the setting again, and this provisions.
		logger.Warnf("demo mode is enabled but no account named %q exists; no demo credential was provisioned", username)
		return nil
	}

	if existing := config.GetSecret(appConfig, "demo.password"); existing.IsSet() {
		if user.CheckPassword(existing.Expose()) == nil {
			logger.Debugf("demo credential: %q already matches demo.password; nothing to provision", username)
			return nil
		}
	}

	return rotate(ctx, appConfig, repo, logger, user, "demo.password", "demo credential")
}

// ProvisionAdmin creates and maintains the read-only demo admin (#516) — the account behind the
// second one-click entrance, which exists so a reviewer can look at Configuration, Users, Database
// and Logs without an operator handing out a real admin credential.
//
// Same credential story as ProvisionCredential: generated, never published, rotated when it drifts.
// Read-only is NOT enforced here — the account carries the ordinary admin role, and every restriction
// on it lives in middleware.RestrictDemoAdmin, server-side, because these routes answer curl whatever
// the UI renders.
//
// Requires BOTH demo.enabled and demo.admin.enabled. An admin account that a stranger can enter is
// not something a flag should be able to create by itself.
func ProvisionAdmin(ctx context.Context, appConfig config.Interface, repo database.DatabaseRepository, logger *logrus.Entry) error {
	if !appConfig.GetBool("demo.enabled") || !appConfig.GetBool("demo.admin.enabled") {
		return nil
	}

	username := appConfig.GetString("demo.admin.username")
	if username == "" {
		logger.Warnf("demo admin is enabled but demo.admin.username is empty; no demo admin was provisioned")
		return nil
	}

	existing, err := repo.GetUserByUsername(ctx, username)
	if err == nil && existing != nil && existing.Username != "" {
		if configured := config.GetSecret(appConfig, "demo.admin.password"); configured.IsSet() {
			if existing.CheckPassword(configured.Expose()) == nil {
				logger.Debugf("demo admin: %q already matches demo.admin.password; nothing to provision", username)
				return nil
			}
		}
		return rotate(ctx, appConfig, repo, logger, existing, "demo.admin.password", "demo admin")
	}

	password, err := generatePassword()
	if err != nil {
		return fmt.Errorf("demo admin: could not generate a password: %w", err)
	}

	// PLAINTEXT: CreateUser hashes what it is given (gorm_common.go:47). Pre-hashing here would
	// store a hash of a hash and produce an account nobody can sign into — the way #504 shipped
	// broken the first time.
	if err := repo.CreateUser(ctx, &models.User{
		Username: username,
		Password: password,
		Role:     pkg.UserRoleAdmin,
	}); err != nil {
		return fmt.Errorf("demo admin: could not create the %q account: %w", username, err)
	}

	// Record it AFTER the account exists. The reverse order would leave a configured password for
	// an account that does not exist, which reads as configured and refuses every visitor.
	if err := config.SetCustomValues(appConfig, map[string]interface{}{"demo.admin.password": password}); err != nil {
		return fmt.Errorf("demo admin: created %q but could not record its password in demo.admin.password: %w", username, err)
	}

	logger.Infof("demo admin: created the read-only demo admin %q with a generated password", username)
	return nil
}

// rotate generates a password, sets it on the account, and records it in the config store under
// configKey. Shared by the demo patient account and the read-only demo admin (#516).
//
// ORDER MATTERS, and both orders are survivable. The account is updated first: if the config write
// then fails, `demo.password` holds a value that no longer verifies, so the NEXT call regenerates
// and the drift heals itself. Writing config first and failing on the account would leave the same
// self-healing mismatch. What must never happen is treating a mismatch as "no password required",
// which is why the sign-in handler refuses rather than falls back.
func rotate(
	ctx context.Context,
	appConfig config.Interface,
	repo database.DatabaseRepository,
	logger *logrus.Entry,
	user *models.User,
	configKey string,
	what string,
) error {
	password, err := generatePassword()
	if err != nil {
		return fmt.Errorf("%s: could not generate a password: %w", what, err)
	}

	// HashPassword writes into the model, so hash on a throwaway rather than on the user we read —
	// UpdateUserPassword takes an ALREADY-HASHED value, and CreateUser hashes what it is given.
	// Getting this backwards produces a hash of a hash and an account nobody can sign into, which is
	// how #504 shipped broken the first time.
	hashed := &models.User{}
	if err := hashed.HashPassword(password); err != nil {
		return fmt.Errorf("%s: could not hash the generated password: %w", what, err)
	}

	// UpdateUserPassword resolves the account from the context, the same way a request does. This is
	// startup code with no request, so name the user explicitly rather than adding a by-username
	// repository method that only this path would use.
	userCtx := context.WithValue(ctx, pkg.ContextKeyTypeAuthUsername, user.Username)
	if err := repo.UpdateUserPassword(userCtx, hashed.Password); err != nil {
		return fmt.Errorf("%s: could not set the password on %q: %w", what, user.Username, err)
	}

	// The value is a Secret in config (`secret` list in app-default-config.json), so it is masked in
	// Admin -> Configuration and never served by /api/instance/public.
	if err := config.SetCustomValues(appConfig, map[string]interface{}{configKey: password}); err != nil {
		return fmt.Errorf("%s: set the password on %q but could not record it in %s: %w", what, user.Username, configKey, err)
	}

	// Says that it happened, never what was generated.
	logger.Infof("%s: generated a new password for %q and stored it in %s", what, user.Username, configKey)
	return nil
}

// generatePassword returns a URL-safe random string. crypto/rand, not math/rand: this is a
// credential, even on a throwaway instance.
func generatePassword() (string, error) {
	buf := make([]byte, credentialBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
