package handler

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/utils"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/middleware"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

type UserWizard struct {
	*models.User    `json:",inline"`
	JoinMailingList bool `json:"join_mailing_list"`
}

func IsAdmin(c *gin.Context) bool {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	currentUser, err := databaseRepo.GetCurrentUser(c)
	if err != nil {
		logger.Errorf("Error getting current user: %v", err)
		return false
	}
	return currentUser.Role == pkg.UserRoleAdmin
}

func AuthSignup(c *gin.Context) {
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	var userWizard UserWizard
	if err := c.ShouldBindJSON(&userWizard); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Check if this is the first user in the database
	userCount, err := databaseRepo.GetUserCount(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "Failed to check user count"})
		return
	}

	// THE FIRST USER IS THE OWNER OF THIS INSTANCE, AND THE ONLY WAY AN ADMIN COMES INTO
	// EXISTENCE. There is no seeded admin, no CLI user-create, and no password-reset flow, so an
	// empty user table means nobody can administer this install yet — and signing up is the fix.
	//
	// That is why the first run ignores signup.enabled (#498): a flag able to block it would turn
	// a fresh deployment into an instance nobody can get into, recoverable only by editing the
	// database. Ordering matters here — the count is read BEFORE the gate, not after.
	if userCount > 0 && !appConfig.GetBool("signup.enabled") {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "self-service account creation is closed on this instance"})
		return
	}

	// The policy is enforced HERE, on the server, not only in the browser (#506). Before this the
	// only backend check was "not blank", so a one-character password was accepted through the API
	// while three different forms enforced three different rules — and the demo seed was built with
	// a password our own sign-in form then refused (#505).
	policy := auth.PasswordPolicyFromConfig(appConfig)
	if err := policy.ValidateUsername(userWizard.User.Username); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if err := policy.ValidatePassword(userWizard.User.Username, userWizard.User.Password); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	if userCount == 0 {
		userWizard.User.Role = pkg.UserRoleAdmin
	} else {
		userWizard.User.Role = pkg.UserRoleUser
	}
	err = databaseRepo.CreateUser(c, userWizard.User)
	if err != nil {
		// A reserved name is the caller's input being wrong, not the server failing. It answered 500
		// before, which the sign-up page renders as "an unknown error occurred during sign-up" — so
		// someone typing the obvious first choice, `admin`, got a dead end instead of the one
		// sentence that explains it. The name is already in their address bar; echoing it back
		// discloses nothing.
		if errors.Is(err, database.ErrReservedUsername) {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	//TODO: we can derive the encryption key and the hash'ed user from the responseData sub. For now the Sub will be the user id prepended with hello.
	userFastenToken, err := auth.JwtGenerateFastenTokenFromUser(*userWizard.User, appConfig.GetString("jwt.issuer.key"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	//check if the user wants to join the mailing list
	if userWizard.JoinMailingList {
		//ignore error messages, we don't want to block the user from signing up
		utils.JoinNewsletter(userWizard.FullName, userWizard.Email, "", "")
	}

	setSessionCookie(c, appConfig, userFastenToken)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": userFastenToken})
}

// signinAccountLimiter throttles FAILED sign-ins per username (#509).
//
// Package-level so the counter survives across requests. It is created once, lazily, from the
// instance's configuration — a limiter rebuilt per request would count to one and forget.
//
// WHY NOT MIDDLEWARE, where the per-IP limit lives: the username is in the JSON body, so a
// middleware would have to read and restore the body before the handler parses it. AuthSignin
// already has it.
var (
	signinAccountLimiter     *middleware.FixedWindowLimiter
	signinAccountLimiterOnce sync.Once
)

func accountLimiter(appConfig config.Interface) *middleware.FixedWindowLimiter {
	signinAccountLimiterOnce.Do(func() {
		perAccount := appConfig.GetInt("web.rate_limit.auth_per_account_per_minute")
		windowSeconds := appConfig.GetInt("web.rate_limit.auth_window_seconds")
		signinAccountLimiter = middleware.NewFixedWindowLimiter(perAccount, time.Duration(windowSeconds)*time.Second)
	})
	return signinAccountLimiter
}

func AuthSignin(c *gin.Context) {
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	var user models.User
	if err := c.ShouldBindJSON(&user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Per-ACCOUNT throttle, on top of the per-IP one in middleware (#509). The per-IP limit alone
	// never sees a slow distributed attempt — a few tries from each of many addresses stays under
	// every bucket while hammering one username indefinitely.
	//
	// Keyed on the lowercased username so `Demo` and `demo` share a budget; an attacker changing the
	// case of a name is not making a different guess.
	limiter := accountLimiter(appConfig)
	accountKey := strings.ToLower(strings.TrimSpace(user.Username))
	if allowed, retryAfter := limiter.Allow(accountKey); !allowed {
		// Deliberately identical to the per-IP refusal, and identical whether or not the account
		// exists: "this account is being throttled" is itself enumeration (#104).
		c.Header("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
		c.JSON(http.StatusTooManyRequests, gin.H{"success": false, "error": "too many requests, please try again later"})
		return
	}

	// Return an identical generic response for "unknown user" and "wrong password",
	// and never echo the attempted username, to prevent username enumeration (#104 / H3).
	foundUser, err := databaseRepo.GetUserByUsername(c, user.Username)
	if err != nil || foundUser == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "invalid username or password"})
		return
	}

	if err = foundUser.CheckPassword(user.Password); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "invalid username or password"})
		return
	}

	// Only FAILURES consume the budget. Clearing on success means somebody who fumbled their password
	// twice and then got it right does not carry those attempts for the rest of the window — and a
	// legitimately busy account is never throttled for being busy. A success-COUNTING limiter is what
	// made the E2E suite look like a login regression in #481.
	limiter.Reset(accountKey)

	//TODO: we can derive the encryption key and the hash'ed user from the responseData sub. For now the Sub will be the user id prepended with hello.
	userFastenToken, err := auth.JwtGenerateFastenTokenFromUser(*foundUser, appConfig.GetString("jwt.issuer.key"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	// A bootstrap-provisioned admin has its generated password sitting in a 0600 file in the data
	// root (#504). Once that admin has actually signed in, the credential is in their hands and the
	// file is only exposure — the data root is by definition what a backup contains (#466), so
	// every archive taken afterwards would carry a working admin password. Delete it on the first
	// successful sign-in by that account.
	//
	// Failure to delete is logged, never fatal: the operator is holding a valid session and
	// refusing it would be a worse outcome than a file that outlives its purpose.
	if foundUser.Role == pkg.UserRoleAdmin && foundUser.Username == appConfig.GetString("bootstrap.admin.username") {
		if err := clearBootstrapPassword(appConfig); err != nil {
			logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
			logger.Warnf("could not remove the bootstrap admin password file after first sign-in: %v", err)
		}
	}

	setSessionCookie(c, appConfig, userFastenToken)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": userFastenToken})
}

// clearBootstrapPassword removes the generated-password file. Declared here rather than calling
// into pkg/web to avoid an import cycle (pkg/web already imports this package); the path is derived
// from the same two constants, and a test pins that they agree.
func clearBootstrapPassword(appConfig config.Interface) error {
	err := os.Remove(filepath.Join(config.DataDir(appConfig), BootstrapAdminPasswordFile))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// BootstrapAdminPasswordFile is the data-root-relative name of the generated-password file (#504).
// Duplicated from pkg/web for the import-cycle reason above; TestBootstrapPasswordFileNamesAgree
// fails if the two ever drift.
const BootstrapAdminPasswordFile = ".admin_bootstrap_password"

// AuthDemoSignin signs a visitor in to the shared demo account with no credential entry, for a
// public demo instance (#495). Gated on `demo.enabled`, which ships false — on any instance
// holding real records this endpoint does not exist as far as a caller can tell.
//
// The credential is configuration, not something the browser holds: `demo.password` is on the
// `secret` list and is never served by /api/instance/public, so it cannot be read out of the JS
// bundle. Since #515 nobody knows it either — it is generated per instance at startup and rotated
// whenever it drifts from the stored hash (pkg/demo.ProvisionCredential).
//
// What happens here is an ORDINARY signin — the configured password is verified against the stored
// hash — deliberately, rather than minting a token for a named user outright. A "log this user in
// without a password" path would turn one mis-set flag into a full auth bypass; this way, a flag
// flipped on an instance with no matching demo account and password does nothing at all. That is
// also why provisioning is a separate step: the flag alone must never be enough.
//
// An enabled flag with an empty `demo.password` is refused rather than treated as "no password
// required", because the empty string is what an operator gets by accident.
//
// This is only half of a safe public demo. The demo account is SHARED, so it must also be barred
// from connecting real providers (#496) — otherwise a visitor authorizes their own Medicare or
// Epic account and the next visitor reads their records.
func AuthDemoSignin(c *gin.Context) {
	demoSignin(c, "demo.username", "demo.password")
}

// AuthDemoAdminSignin is the second one-click entrance: the READ-ONLY demo admin (#516), so a
// reviewer can see Configuration, Users, Database and Logs without an operator handing out a real
// admin credential.
//
// Identical mechanics to AuthDemoSignin — generated credential, verified server-side — and gated on
// demo.admin.enabled ON TOP of demo.enabled, because an admin account a stranger can enter is not
// something a single flag should be able to open.
//
// Nothing here makes the session read-only. That is middleware.RestrictDemoAdmin, on the API,
// default-deny: a hidden button is not a control, and these routes answer curl.
func AuthDemoAdminSignin(c *gin.Context) {
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	if !appConfig.GetBool("demo.admin.enabled") {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "the demo admin is not enabled on this instance"})
		return
	}
	demoSignin(c, "demo.admin.username", "demo.admin.password")
}

// demoSignin is the shared body of both entrances: look up the configured account, verify the
// configured password against its stored hash, mint a token. Parameterised by config key rather than
// duplicated, so the two entrances cannot drift on the check that matters.
func demoSignin(c *gin.Context, usernameKey, passwordKey string) {
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)

	if !appConfig.GetBool("demo.enabled") {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "demo mode is not enabled on this instance"})
		return
	}

	demoUsername := appConfig.GetString(usernameKey)
	demoPassword := config.GetSecret(appConfig, passwordKey)
	if demoUsername == "" || !demoPassword.IsSet() {
		// Loud on the server, generic to the caller: this is an operator mistake, and the fix is not
		// the visitor's to make. Since #515 the fix is no longer "type a password" — provisioning
		// generates one at startup, so an empty value here means the demo account did not exist when
		// this instance last started.
		logger.Warnf("demo mode is enabled but %s or %s is empty; refusing demo sign-in "+
			"(the credential is provisioned at startup — create the account and restart, or toggle demo.enabled to provision now)",
			usernameKey, passwordKey)
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "demo mode is not configured on this instance"})
		return
	}

	foundUser, err := databaseRepo.GetUserByUsername(c, demoUsername)
	if err != nil || foundUser == nil {
		logger.Warnf("demo mode is enabled but no account named %q exists; refusing demo sign-in", demoUsername)
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "demo mode is not configured on this instance"})
		return
	}

	if err = foundUser.CheckPassword(demoPassword.Expose()); err != nil {
		logger.Warnf("demo mode is enabled but %s does not match the %q account; refusing demo sign-in", passwordKey, demoUsername)
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "demo mode is not configured on this instance"})
		return
	}

	userFastenToken, err := auth.JwtGenerateFastenTokenFromUser(*foundUser, appConfig.GetString("jwt.issuer.key"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	setSessionCookie(c, appConfig, userFastenToken)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": userFastenToken})
}

// setSessionCookie stores the session JWT as an HttpOnly/Secure/SameSite=Strict cookie for
// browser clients (#103 / H2). The Authorization: Bearer header remains the primary transport
// (RFC 6750 / SMART); this cookie is an optional fallback that keeps the token out of JS to
// shrink the XSS-theft surface. Secure is gated on HTTPS so local http dev still works;
// SameSite=Strict mitigates CSRF. Max-age matches jwt.session_ttl_minutes (#445 sliding TTL).
func setSessionCookie(c *gin.Context, appConfig config.Interface, token string) {
	policy := auth.SessionPolicyFromConfig(appConfig)
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(pkg.SessionCookieName, token, policy.CookieMaxAgeSeconds(), "/", "", appConfig.GetBool("web.listen.https.enabled"), true)
}

// AuthLogout clears the session cookie. The session JWT is otherwise stateless, and an
// HttpOnly cookie can't be cleared from JavaScript, so this endpoint is what lets a browser
// fully sign out (the SPA calls it in addition to dropping its localStorage token) (#103).
func AuthLogout(c *gin.Context) {
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(pkg.SessionCookieName, "", -1, "/", "", appConfig.GetBool("web.listen.https.enabled"), true)
	c.JSON(http.StatusOK, gin.H{"success": true})
}
