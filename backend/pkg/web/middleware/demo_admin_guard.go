package middleware

import (
	"net/http"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// readOnlyPostRoutes are the POST endpoints the UI needs in order to READ. Fasten queries records
// over POST (a FHIR-ish query body does not fit in a URL), so a plain "GET only" rule would leave a
// demo admin looking at empty screens.
//
// Matched by path prefix on the route AFTER /api/secure. Deliberately tiny: every entry here is a
// hole in default-deny, and each one had to earn its place by being read-only in the handler.
var readOnlyPostRoutes = []string{
	"/query",
	"/resource/graph/",
}

// deniedReadRoutes are GETs a read-only admin still must not have. Read-only is not the same as
// harmless: the first hands out configured secrets on request, and the second enumerates directories
// on the machine the instance runs on. Neither belongs to a stranger clicking around a public demo.
var deniedReadRoutes = []string{
	"/admin/config/reveal/",
	"/admin/database/browse",
}

// RestrictDemoAdmin makes the demo admin account read-only, server-side (#516).
//
// WHY DEFAULT-DENY. #496 guarded the demo account by naming the dangerous routes, and #514 was the
// bill for it: two routes nobody thought of — change password, delete account — let any visitor lock
// everyone out permanently. An admin session has far more of those routes, and the list grows every
// release. So this inverts the direction: everything is refused unless it is a read, and a route
// added next year is blocked by inheritance rather than by somebody remembering.
//
// SCOPE. Only the account named by demo.admin.username, and only while demo.enabled. Every other
// user on the instance — including the operator's own bootstrap admin, which shares this API — is
// untouched, so the operator can still administer the demo host normally.
//
// FAILS CLOSED. If the current user cannot be identified while demo mode is on, the request is
// refused. The alternative is letting an unidentified caller through to admin routes on a public
// host, and being wrong in that direction is unrecoverable.
func RestrictDemoAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

		if !appConfig.GetBool("demo.enabled") || !appConfig.GetBool("demo.admin.enabled") {
			c.Next()
			return
		}

		demoAdmin := strings.TrimSpace(appConfig.GetString("demo.admin.username"))
		if demoAdmin == "" {
			c.Next()
			return
		}

		databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
		currentUser, err := databaseRepo.GetCurrentUser(c)
		if err != nil || currentUser == nil {
			if logger, ok := c.Get(pkg.ContextKeyTypeLogger); ok {
				logger.(*logrus.Entry).Warnf("demo admin guard: could not identify the current user (%v); refusing", err)
			}
			refuseDemoAdmin(c, "this action is disabled in the public demo")
			return
		}

		if !strings.EqualFold(currentUser.Username, demoAdmin) {
			c.Next()
			return
		}

		path := strings.TrimPrefix(c.FullPath(), "/api/secure")

		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			for _, denied := range deniedReadRoutes {
				if strings.HasPrefix(path, denied) {
					refuseDemoAdmin(c, "this is disabled in the public demo — the demo admin can see how the instance is configured, but not read its secrets or browse the server")
					return
				}
			}
			c.Next()
			return
		case http.MethodPost:
			for _, allowed := range readOnlyPostRoutes {
				if strings.HasPrefix(path, allowed) {
					c.Next()
					return
				}
			}
		}

		refuseDemoAdmin(c, "the public demo's admin account is read-only — it can see how the instance is configured, but not change anything")
	}
}

// refuseDemoAdmin answers with the same machine-readable code the demo account guard uses, so the
// frontend has one refusal to recognise rather than two.
func refuseDemoAdmin(c *gin.Context, message string) {
	c.JSON(http.StatusForbidden, gin.H{
		"success": false,
		"code":    DemoErrorCode,
		"error":   message,
	})
	c.Abort()
}
