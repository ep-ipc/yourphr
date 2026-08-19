package middleware

import (
	"net/http"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// accessLogCategories maps a route (as gin reports it in FullPath) to the legible category shown in
// the patient's access log (#563). Only routes that read RECORD DATA are listed — account settings,
// provider-catalog administration, job listings and the like are not accesses of the patient's
// record. An unlisted route is simply not logged, so adding a new record-reading route means adding
// it here; the middleware test enumerates the secure routes and fails when a /resource or classified
// route is missing, which keeps this map honest.
var accessLogCategories = map[string]string{
	"/api/secure/summary":                            "Summary",
	"/api/secure/summary/ips":                        "Summary (IPS)",
	"/api/secure/summary/ips/email":                  "Summary shared by email",
	"/api/secure/medications/reconciled":             "Medications",
	"/api/secure/conditions/classified":              "Conditions",
	"/api/secure/conditions/reconciled":              "Conditions",
	"/api/secure/allergies/classified":               "Allergies",
	"/api/secure/immunizations/classified":           "Immunizations",
	"/api/secure/procedures/classified":              "Procedures",
	"/api/secure/diagnostic-reports/classified":      "Diagnostic reports",
	"/api/secure/encounters/classified":              "Encounters",
	"/api/secure/care-plans/classified":              "Care plans",
	"/api/secure/coverages/classified":               "Insurance",
	"/api/secure/claims/classified":                  "Insurance",
	"/api/secure/patient/insurance-claims":           "Insurance",
	"/api/secure/vitals/recognized":                  "Vitals",
	"/api/secure/documents/classified":               "Documents",
	"/api/secure/resources/recent":                   "Record search",
	"/api/secure/resources/search":                   "Record search",
	"/api/secure/resource/fhir":                      "Records (FHIR)",
	"/api/secure/resource/fhir/:sourceId/:resourceId": "Records (FHIR)",
	"/api/secure/resource/graph/:graphType":          "Records (FHIR)",
	"/api/secure/source/:sourceId/export":            "Full export",
}

// AccessLog writes the patient-visible access log (#563). It runs AFTER RequireAuth, reads the
// route's category, and increments the (user, category, day) bucket. Reads only — a POST/PATCH is
// the user's own act, already visible as the data it changed; the one deliberate exception is the
// IPS email share, which sends the summary OUT and therefore is an access worth recording.
//
// A logging failure must never break the read it is logging: the error is logged and the request
// continues. The write happens before the handler so a slow response cannot lose it, and it costs
// one UPSERT. Dependencies come from the gin context, matching the other middleware in this package.
func AccessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		category, listed := accessLogCategories[c.FullPath()]
		if !listed || (c.Request.Method != http.MethodGet && c.FullPath() != "/api/secure/summary/ips/email") {
			c.Next()
			return
		}
		// Skip when auth did not resolve a user (RequireAuth aborts before us, but stay defensive).
		if _, exists := c.Get(pkg.ContextKeyTypeAuthUsername); !exists {
			c.Next()
			return
		}
		repoValue, ok := c.Get(pkg.ContextKeyTypeDatabase)
		databaseRepo, repoOk := repoValue.(database.DatabaseRepository)
		if !ok || !repoOk {
			// A wiring mistake must not take patient reads down with it.
			c.Next()
			return
		}
		if err := databaseRepo.RecordAccessEvent(c, category); err != nil {
			if loggerValue, exists := c.Get(pkg.ContextKeyTypeLogger); exists {
				if logger, loggerOk := loggerValue.(*logrus.Entry); loggerOk {
					logger.Warnf("access log: could not record %q: %v", category, err)
				}
			}
		}
		c.Next()
	}
}
