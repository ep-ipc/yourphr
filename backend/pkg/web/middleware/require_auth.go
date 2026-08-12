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
			// Browser session JWT. Stateless by design, which is why a stolen one used to survive a
			// password change (#508): nothing could evict it. The user's token_generation is the
			// revocation point — a token minted before a bump is refused here.
			//
			// One database read per authenticated request, the same cost the access-token path above
			// has always paid. The alternative (a jti denylist) needs storage proportional to
			// revocations plus a sweeper, to answer a question one integer answers.
			// c.Get, not MustGet: a missing repository is a wiring mistake, and panicking inside auth
			// middleware turns that into a 500 on every request with a stack trace in the log. Fail
			// closed instead — refusing is the safe direction when we cannot check revocation.
			repo, ok := c.Get(pkg.ContextKeyTypeDatabase)
			databaseRepo, repoOk := repo.(database.DatabaseRepository)
			if !ok || !repoOk {
				c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "request does not contain a valid token"})
				c.Abort()
				return
			}
			currentUser, err := databaseRepo.GetUserByUsername(c, claims.Subject)
			if err != nil || currentUser == nil {
				// The account is gone, or unreadable. Either way this session no longer refers to
				// anybody — which is exactly the state a demo reset leaves old tokens in (#518).
				c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "request does not contain a valid token"})
				c.Abort()
				return
			}
			if claims.TokenGeneration < currentUser.TokenGeneration {
				// Deliberately the same generic message as any other invalid token: "your session was
				// revoked" tells someone holding a stolen token that the owner noticed.
				c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "request does not contain a valid token"})
				c.Abort()
				return
			}

			// Sliding renew when near expiry (#445 Option A). Absolute max from session_start is
			// enforced inside JwtMaybeRenewSession. Renewal carries the CURRENT generation forward,
			// so a renewed session cannot outlive a revocation.
			policy := auth.SessionPolicyFromConfig(appConfig)
			user := models.User{
				Username:        claims.Subject,
				FullName:        claims.FullName,
				Email:           claims.Email,
				Role:            claims.Role,
				TokenGeneration: currentUser.TokenGeneration,
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
