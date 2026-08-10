package handler

import (
	"net/http"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/utils"
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

	if userCount == 0 {
		userWizard.User.Role = pkg.UserRoleAdmin
	} else {
		userWizard.User.Role = pkg.UserRoleUser
	}
	err = databaseRepo.CreateUser(c, userWizard.User)
	if err != nil {
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

func AuthSignin(c *gin.Context) {
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	var user models.User
	if err := c.ShouldBindJSON(&user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
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

	//TODO: we can derive the encryption key and the hash'ed user from the responseData sub. For now the Sub will be the user id prepended with hello.
	userFastenToken, err := auth.JwtGenerateFastenTokenFromUser(*foundUser, appConfig.GetString("jwt.issuer.key"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	setSessionCookie(c, appConfig, userFastenToken)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": userFastenToken})
}

// AuthDemoSignin signs a visitor in to the shared demo account with no credential entry, for a
// public demo instance (#495). Gated on `demo.enabled`, which ships false — on any instance
// holding real records this endpoint does not exist as far as a caller can tell.
//
// The credential is configuration, not something the browser holds: `demo.password` is on the
// `secret` list and is never served by /api/instance/public, so the published demo login cannot
// be read out of the JS bundle. What happens here is an ORDINARY signin — the configured password
// is verified against the stored hash — deliberately, rather than minting a token for a named
// user outright. A "log this user in without a password" path would turn one mis-set flag into a
// full auth bypass; this way, a flag flipped on an instance with no matching demo account and
// password does nothing at all.
//
// An enabled flag with an empty `demo.password` is refused rather than treated as "no password
// required", because the empty string is what an operator gets by accident.
//
// This is only half of a safe public demo. The demo account is SHARED, so it must also be barred
// from connecting real providers (#496) — otherwise a visitor authorizes their own Medicare or
// Epic account and the next visitor reads their records.
func AuthDemoSignin(c *gin.Context) {
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)

	if !appConfig.GetBool("demo.enabled") {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "demo mode is not enabled on this instance"})
		return
	}

	demoUsername := appConfig.GetString("demo.username")
	demoPassword := config.GetSecret(appConfig, "demo.password")
	if demoUsername == "" || !demoPassword.IsSet() {
		// Loud on the server, generic to the caller: this is an operator mistake, and the fix
		// (set demo.username / demo.password) is not the visitor's to make.
		logger.Warnf("demo mode is enabled but demo.username or demo.password is empty; refusing demo sign-in")
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
		logger.Warnf("demo mode is enabled but demo.password does not match the %q account; refusing demo sign-in", demoUsername)
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
