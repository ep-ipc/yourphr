package middleware

import (
	"net/http"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// DemoErrorCode is returned in the error body so the frontend can recognise a demo refusal without
// string-matching a human sentence.
const DemoErrorCode = "demo_account_restricted"

// BlockForDemoAccount refuses a route for the shared public-demo account (#496).
//
// WHY THIS EXISTS. A public demo signs every visitor in as ONE account (#495). Connecting a
// provider is a normal user action — /source/authorize and /provider-catalog/:id/authorize are not
// admin-gated — so without this guard a visitor can OAuth their own real Medicare, Epic or
// Veradigm account into that shared login, and the NEXT visitor reads their claims and conditions.
// Real PHI, on a public account, on an instance that runs with database encryption off. This is
// the one thing that makes an otherwise harmless demo dangerous.
//
// The guard keys on demo.enabled AND the signed-in username matching demo.username, rather than on
// the flag alone. Narrower, and it deliberately leaves the operator's own admin account able to
// connect a sandbox source on the same instance — which is how the demo's seed data gets refreshed
// without turning demo mode off and on again.
//
// Server-side because a hidden button is not a control: the routes are reachable with curl and a
// session cookie whatever the UI renders.
//
// This is a restriction on ONE account on an instance that opted into demo mode. It is not a
// read-only mode, and it does not fire on any ordinary install: with demo.enabled false — the
// shipped default — this middleware returns immediately.
func BlockForDemoAccount() gin.HandlerFunc {
	return func(c *gin.Context) {
		appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

		if !appConfig.GetBool("demo.enabled") {
			c.Next()
			return
		}

		demoUsername := appConfig.GetString("demo.username")
		if demoUsername == "" {
			c.Next()
			return
		}

		databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
		currentUser, err := databaseRepo.GetCurrentUser(c)
		// Fail CLOSED on a lookup error while demo mode is on: the alternative is letting an
		// unidentified caller reach the connect routes on a public shared instance, and the cost of
		// being wrong in that direction is a stranger's medical records in front of the next visitor.
		if err != nil || currentUser == nil {
			if logger, ok := c.Get(pkg.ContextKeyTypeLogger); ok {
				logger.(*logrus.Entry).Warnf("demo guard: could not identify the current user (%v); refusing", err)
			}
			c.JSON(http.StatusForbidden, gin.H{
				"success": false,
				"code":    DemoErrorCode,
				"error":   "this action is disabled in the public demo",
			})
			c.Abort()
			return
		}

		if currentUser.Username != demoUsername {
			c.Next()
			return
		}

		c.JSON(http.StatusForbidden, gin.H{
			"success": false,
			"code":    DemoErrorCode,
			"error":   "connecting a provider is disabled in the public demo — the demo account is shared, so records imported here would be visible to everyone",
		})
		c.Abort()
	}
}
