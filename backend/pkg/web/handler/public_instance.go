package handler

import (
	"net/http"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/gin-gonic/gin"
)

// PublicInstanceInfo is the unauthenticated view of an instance: who runs it and how the UI
// should look. Nothing here is user- or PHI-derived, and nothing here varies by session.
//
// SECURITY — this struct IS the allowlist (#453). It is populated field by field from named
// config keys and is never built by ranging over config state. That is deliberate: the merged
// configuration carries jwt.issuer.key, relay.secret and the Blue Button client secrets, so
// anything that serialized config wholesale — or filtered by prefix, or by a deny-list — would
// leak credentials the first time somebody added a key that did not match the pattern.
//
// Adding a field here publishes it to anonymous callers. Treat that as the review question.
type PublicInstanceInfo struct {
	Name         string `json:"name"`          // operator/instance display name, e.g. "Nerds by the Hour"
	ContactEmail string `json:"contact_email"` // operator support address, empty when unset
	ContactURL   string `json:"contact_url"`   // operator help/privacy page, empty when unset
	Theme        string `json:"theme"`         // UI theme id; must render before login (#436)
}

// GetPublicInstanceInfo serves the instance's public identity: operator contact plus theme.
//
// Unauthenticated on purpose. The theme has to apply on first paint for a visitor who has not
// logged in, and operator contact is useless if only admins can see it — before this endpoint
// existed the values were write-only, set in the Admin Dashboard and rendered nowhere (#454).
//
// Absent values are returned as empty strings rather than omitted or defaulted, so the frontend
// renders nothing instead of inventing a fallback.
func GetPublicInstanceInfo(c *gin.Context) {
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	operator := database.LoadOperatorSettings(appConfig)

	c.JSON(http.StatusOK, gin.H{"success": true, "data": PublicInstanceInfo{
		Name:         operator.Name,
		ContactEmail: operator.ContactEmail,
		ContactURL:   operator.ContactURL,
		Theme:        appConfig.GetString("theme.name"),
	}})
}
