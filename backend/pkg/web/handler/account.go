package handler

import (
	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"net/http"
)

// GetCurrentUser returns the current user's profile information
func GetCurrentUser(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	currentUser, err := databaseRepo.GetCurrentUser(c)
	if err != nil {
		logger.Errorf("Failed to get current user: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "Failed to get current user"})
		return
	}

	// demo_account tells the UI to render the connect affordances as disabled rather than offering
	// actions the server will refuse (#496). Derived here rather than exposing demo.username on the
	// public instance endpoint: the UI needs to know "am I the demo account", not who that account
	// is, and naming it publicly would hand an attacker half of a shared credential.
	//
	// It is a hint for rendering, never the control — BlockForDemoAccount enforces the same rule on
	// the routes themselves, because a disabled button is not a control.
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	isDemoAccount := appConfig.GetBool("demo.enabled") &&
		appConfig.GetString("demo.username") != "" &&
		appConfig.GetString("demo.username") == currentUser.Username

	// Create a sanitized user object (without password)
	sanitizedUser := gin.H{
		"id":           currentUser.ID,
		"username":     currentUser.Username,
		"full_name":    currentUser.FullName,
		"email":        currentUser.Email,
		"picture":      currentUser.Picture,
		"role":         currentUser.Role,
		"demo_account": isDemoAccount,
		// #512: so a patient can answer "has anyone else been in my record?" without an admin. No IP
		// and no user-agent are recorded anywhere — see the model comment for why that is the point
		// rather than an omission.
		"last_login":  currentUser.LastLogin,
		"login_count": currentUser.LoginCount,
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    sanitizedUser,
	})
}

// ChangePassword updates the current user's password after verifying their current one.
func ChangePassword(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "invalid request"})
		return
	}

	currentUser, err := databaseRepo.GetCurrentUser(c)
	if err != nil {
		logger.Errorf("Failed to get current user: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "Failed to change password"})
		return
	}

	// Verify the current password before allowing a change.
	if err := currentUser.CheckPassword(req.CurrentPassword); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "current password is incorrect"})
		return
	}

	// The new password must satisfy the instance policy (#506). Note this runs AFTER the current
	// password is verified above, so a stranger cannot use this endpoint to probe the policy — and
	// the OLD password is deliberately not validated, because an account created before the policy
	// existed must still be able to change itself into compliance.
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	if err := auth.PasswordPolicyFromConfig(appConfig).ValidatePassword(currentUser.Username, req.NewPassword); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// HashPassword also rejects an empty new password.
	if err := currentUser.HashPassword(req.NewPassword); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	if err := databaseRepo.UpdateUserPassword(c, currentUser.Password); err != nil {
		logger.Errorf("Failed to update password: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "Failed to change password"})
		return
	}

	// End every OTHER session (#508). Session JWTs are stateless, so without this a stolen session
	// survives the password change made to evict it — which turns the one action a user takes after
	// a compromise into false comfort.
	//
	// Bump first, then re-issue for THIS caller, so the person who just changed their password is not
	// signed out by their own action.
	if err := databaseRepo.BumpUserTokenGeneration(c, currentUser.Username); err != nil {
		// The password HAS changed at this point, so this is not a failure of the request — but it
		// leaves other sessions alive, which is precisely what the user was trying to prevent. Loud.
		logger.Errorf("password changed for %q but existing sessions could not be revoked: %v", currentUser.Username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false,
			"error": "your password was changed, but other signed-in sessions could not be ended — sign out everywhere from Account Profile"})
		return
	}

	appConfig = c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	refreshed := *currentUser
	refreshed.TokenGeneration++
	if token, err := auth.JwtGenerateFastenTokenFromUser(refreshed, appConfig.GetString("jwt.issuer.key")); err == nil {
		setSessionCookie(c, appConfig, token)
		c.JSON(http.StatusOK, gin.H{"success": true, "data": token})
		return
	}

	// The token could not be re-issued, so this caller is signed out too. Correct rather than
	// convenient: the alternative is leaving a session alive that the new generation should refuse.
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// SignOutEverywhere ends every session for the current user, including this one (#508).
//
// The deliberate difference from ChangePassword: no token is re-issued. Somebody pressing this has
// decided their sessions are not trustworthy, and the caller's own browser is one of them — signing
// it out too is the honest reading of "everywhere".
func SignOutEverywhere(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	currentUser, err := databaseRepo.GetCurrentUser(c)
	if err != nil {
		logger.Errorf("Failed to get current user: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not sign out other sessions"})
		return
	}

	if err := databaseRepo.BumpUserTokenGeneration(c, currentUser.Username); err != nil {
		logger.Errorf("could not revoke sessions for %q: %v", currentUser.Username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not sign out other sessions"})
		return
	}

	logger.Infof("signed out every session for %q", currentUser.Username)
	// Same clearing AuthLogout does — the cookie is dead to the server either way now, but leaving a
	// stale one in the browser means the next request 401s instead of showing the sign-in page.
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(pkg.SessionCookieName, "", -1, "/", "", appConfig.GetBool("web.listen.https.enabled"), true)
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// UX: this is a secure endpoint, and should only be called after a double confirmation
func DeleteAccount(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	err := databaseRepo.DeleteCurrentUser(c)

	if err != nil {
		logger.Errorln("An error occurred while deleting current user", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}
