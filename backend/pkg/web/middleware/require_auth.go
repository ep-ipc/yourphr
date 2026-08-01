package middleware

import (
	"net/http"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
)

func RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

		// Token transport: Authorization: Bearer is primary (RFC 6750 / SMART App Launch);
		// fall back to the HttpOnly session cookie for browser clients. The header wins if
		// both are present, so non-browser/desktop/CLI clients are unaffected (#103 / H2).
		tokenString := ""
		fromCookie := false
		if authHeader := c.GetHeader("Authorization"); authHeader != "" {
			parts := strings.Split(authHeader, " ")
			if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
				tokenString = parts[1]
			}
		}
		if tokenString == "" {
			if cookieVal, err := c.Cookie(pkg.SessionCookieName); err == nil {
				tokenString = cookieVal
				fromCookie = true
			}
		}

		if tokenString == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "request does not contain a valid token"})
			c.Abort()
			return
		}

		signingKey := appConfig.GetString("jwt.issuer.key")
		claims, err := auth.JwtValidateFastenToken(signingKey, tokenString)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": err.Error()})
			c.Abort()
			return
		}

		if claims.TokenType == "access" {
			databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
			token, err := databaseRepo.GetAccessTokenByTokenIDAndUsername(c, claims.ID, claims.Subject)
			if err != nil || token == nil {
				c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "Invalid access token"})
				c.Abort()
				return
			}
		} else {
			// Browser session JWT: sliding renew when near expiry (#445 Option A).
			// Absolute max from session_start is enforced inside JwtMaybeRenewSession.
			policy := auth.SessionPolicyFromConfig(appConfig)
			user := models.User{
				Username: claims.Subject,
				FullName: claims.FullName,
				Email:    claims.Email,
				Role:     claims.Role,
			}
			if newTok, renewed, rerr := auth.JwtMaybeRenewSession(claims, user, signingKey, policy); rerr == nil && renewed {
				tokenString = newTok
				// Always refresh cookie when we renew so browser clients keep HttpOnly session.
				// Max-Age matches sliding TTL (not absolute max).
				c.SetSameSite(http.SameSiteStrictMode)
				c.SetCookie(pkg.SessionCookieName, newTok, policy.CookieMaxAgeSeconds(), "/", "",
					appConfig.GetBool("web.listen.https.enabled"), true)
				// Optional hint for non-cookie clients that presented Bearer (rare for SPA after #118).
				if !fromCookie {
					c.Header("X-Yourphr-Session-Token", newTok)
				}
			}
		}

		// Set context for both regular and access tokens
		c.Set(pkg.ContextKeyTypeAuthToken, tokenString)
		c.Set(pkg.ContextKeyTypeAuthUsername, claims.Subject)
		c.Next()
	}
}
