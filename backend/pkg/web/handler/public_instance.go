package handler

import (
	"net/http"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
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
		data[key] = coercePublicValue(appConfig, key, value)
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

// coercePublicValue serves a value with the TYPE its shipped default declares, rather than whatever
// the layer it came from happened to store.
//
// Environment variables are strings, so an operator setting YOURPHR_DEMO_ENABLED=true made this
// endpoint emit "demo.enabled": "true" — a string. The backend was unaffected (GetBool coerces), but
// clients compare against real booleans, and both directions of that mismatch are silent and wrong:
// a demo instance would never render its one-click sign-in ("true" is not true), and worse, an
// instance with signup CLOSED still advertised the sign-up link, because "false" is not false.
//
// Found by configuring a real instance entirely through the environment; no unit test would have,
// because they set values through a typed config object.
func coercePublicValue(appConfig config.Interface, key string, value interface{}) interface{} {
	if _, alreadyBool := value.(bool); alreadyBool {
		return value
	}

	defaults, err := config.DefaultConfigValues()
	if err != nil {
		// Serve the raw value rather than failing the request: this endpoint is on the first-paint
		// path, and a theme or an operator name is worth more than strict typing.
		return value
	}
	if _, isBool := defaults[key].(bool); isBool {
		return appConfig.GetBool(key)
	}
	return value
}

// GetInstanceInfoForUser serves instance identity to a signed-in user: everything public, plus
// the operator contact block (#459).
//
// The split exists because operator.contact_email is not shipped in the public array — an
// address on an unauthenticated endpoint gets harvested — while someone with an account has a
// direct interest in reaching whoever holds their records. Anonymous callers still get the
// operator name and support URL from /api/instance/public, so /contact is useful either way.
func GetInstanceInfoForUser(c *gin.Context) {
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	data := gin.H{}
	for _, key := range config.AuthenticatedInstanceKeys(appConfig) {
		value := appConfig.Get(key)
		if value == nil {
			value = ""
		}
		data[key] = value
	}

	// Whether THIS session is the read-only demo admin (#516), so the UI can say so on every screen
	// rather than letting a visitor discover it by clicking Save and getting a 403.
	//
	// Computed here rather than published as a username: demo.admin.username is not on the public
	// list, and answering "is this session restricted" is the only question a client needs. It is
	// presentation only — the restriction itself is middleware.RestrictDemoAdmin, and it does not
	// care what the UI believes.
	data["demo.admin.session"] = isDemoAdminSession(c, appConfig)

	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

func isDemoAdminSession(c *gin.Context, appConfig config.Interface) bool {
	if !appConfig.GetBool("demo.enabled") || !appConfig.GetBool("demo.admin.enabled") {
		return false
	}
	demoAdmin := strings.TrimSpace(appConfig.GetString("demo.admin.username"))
	if demoAdmin == "" {
		return false
	}
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	currentUser, err := databaseRepo.GetCurrentUser(c)
	if err != nil || currentUser == nil {
		return false
	}
	return strings.EqualFold(currentUser.Username, demoAdmin)
}
