package handler

import (
	"net/http"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/gin-gonic/gin"
)

// GetPublicInstanceInfo serves this instance's public identity — who runs it and how the UI
// should look — to callers with no login.
//
// Unauthenticated on purpose. The theme has to apply on first paint for a visitor who has not
// signed in, and operator contact is useless if only admins can see it: before this endpoint
// existed the values were write-only, set in the Admin Dashboard and rendered nowhere (#454).
//
// WHAT IT SERVES is the `public` array in the configuration (#457), not a list in this file.
// Adding a setting to the public surface is a line of JSON. The array is an allow-list, so a
// key added anywhere else in the configuration is private until named — the configuration also
// carries jwt.issuer.key, relay.secret and the Blue Button client secrets, and the failure mode
// that matters is what happens to a key nobody thought about.
//
// Response keys are the config keys themselves ("operator.contact_email"), so the payload says
// exactly which setting each value came from and needs no per-key mapping to stay general.
//
// Absent values are served as empty strings rather than omitted, so a client renders nothing
// instead of inventing a fallback.
func GetPublicInstanceInfo(c *gin.Context) {
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	data := gin.H{}
	for _, key := range config.PublicKeys(appConfig) {
		value := appConfig.Get(key)
		if value == nil {
			value = ""
		}
		data[key] = value
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}
