package handler

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/demo"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// Admin Configuration screen (#458). Admin-only.
//
// Answers the question an operator cannot answer today: what is this instance actually
// configured to do, and which of it did I choose? A value that silently fell back to a default
// is indistinguishable from one set on purpose — the ambiguity behind #397 and #399.
//
// MASKING. Values named in the `secret` array are masked. The list response carries "••••••••",
// never the real value, and revealing one requires a separate request for a single key. That is
// the difference between masked and actually-not-sent: with cosmetic masking the secret is
// already in the page for devtools, view-source, a screenshot of the network tab, or any XSS.
// Screen-sharing this page is safe by default.
//
// `secret` is a short DENY-list, not the inverse of `public`. Masking everything outside `public`
// hid 47 of 51 settings — the listen port, the log level — which protects nothing and teaches an
// operator to click reveal without reading. The two arrays answer different questions and so have
// opposite safe defaults: `public` is an allow-list because a mistake exposes a value to the
// internet; `secret` is a deny-list because a mistake shows a value to an already-authenticated
// admin on their own screen.

// maskedValue is what a non-public value looks like in the list response.
const maskedValue = "••••••••"

// ConfigEntry is one setting as the Admin screen sees it.
type ConfigEntry struct {
	Key   string      `json:"key"`
	Value interface{} `json:"value"`
	// Masked is true when Value is a placeholder rather than the real setting.
	Masked bool `json:"masked"`
	// Source is "custom" when this instance overrode the shipped value, else "default".
	Source string `json:"source"`
	// Public means anonymous callers can read it via /api/instance/public.
	Public bool `json:"public"`
	// Promoted means this instance added the key to `public` beyond the shipped set — worth
	// surfacing inline, because a startup log line is read approximately never and this is the
	// whole of the remaining protection once widening is allowed.
	Promoted bool `json:"promoted"`
	// Default is the shipped value, so the screen can show what "reset" would restore. Masked on
	// the same rule as Value.
	Default interface{} `json:"default"`
	// FromEnv means the value comes from the process environment, which OUTRANKS the custom
	// config store on restart. Such a key cannot be edited here — see SetAdminConfigValue.
	FromEnv bool `json:"from_env"`
	// EnvVar names the variable that governs this key, so an operator knows where to change it.
	EnvVar string `json:"env_var"`
}

// AdminConfigResponse is the payload for GET /api/secure/admin/config.
type AdminConfigResponse struct {
	Entries []ConfigEntry `json:"entries"`
	// CustomConfigPath is where overrides are written, so an operator can find the file.
	CustomConfigPath string `json:"custom_config_path"`
	// Warnings names keys published beyond the shipped public set.
	Warnings []string `json:"warnings"`
}

// GetAdminConfig returns every known setting: effective value, where it came from, and whether
// it is public. Admin-only.
func GetAdminConfig(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "admin role required"})
		return
	}
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	defaults, err := config.DefaultConfigValues()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	custom, err := config.CustomConfigValues(appConfig)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	public := map[string]bool{}
	for _, key := range config.PublicKeys(appConfig) {
		public[key] = true
	}
	secret := map[string]bool{}
	for _, key := range config.SecretKeys(appConfig) {
		secret[key] = true
	}
	promoted := map[string]bool{}
	var warnings []string
	if extras, err := config.PublicKeysPromotedBeyondDefault(appConfig); err == nil {
		for _, key := range extras {
			promoted[key] = true
			warnings = append(warnings, fmt.Sprintf(
				"%q is served to callers with NO login because this instance added it to %q",
				key, config.PublicKeysConfigKey))
		}
	}

	for _, key := range config.SecretKeys(appConfig) {
		if public[key] {
			warnings = append(warnings, fmt.Sprintf(
				"%q is marked secret but is also in %q, so it is served to callers with NO login",
				key, config.PublicKeysConfigKey))
		}
	}

	keys := make([]string, 0, len(defaults))
	for key := range defaults {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	entries := make([]ConfigEntry, 0, len(keys))
	for _, key := range keys {
		_, overridden := custom[key]
		source := "default"
		if overridden {
			source = "custom"
		}

		entry := ConfigEntry{
			Key:      key,
			Value:    appConfig.Get(key),
			Default:  defaults[key],
			Source:   source,
			Public:   public[key],
			Promoted: promoted[key],
			EnvVar:   config.EnvVarFor(key),
			FromEnv:  config.IsSetByEnvironment(key),
		}
		if entry.FromEnv {
			// Env beats the store on restart, so this is where the value really comes from.
			entry.Source = "environment"
		}
		if secret[key] {
			entry.Value = maskedValue
			entry.Default = maskedValue
			entry.Masked = true
		}
		entries = append(entries, entry)
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": AdminConfigResponse{
		Entries:          entries,
		CustomConfigPath: config.CustomConfigPath(appConfig),
		Warnings:         warnings,
	}})
}

// RevealAdminConfigValue returns the real value of ONE key. Admin-only.
//
// Separate from the list on purpose: masked values are never sent with the list, so a reveal is
// a discrete, auditable act rather than a CSS toggle over data the browser already had. Each
// reveal is logged with the key and the admin who asked.
func RevealAdminConfigValue(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "admin role required"})
		return
	}
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	key := strings.ToLower(strings.TrimSpace(c.Param("key")))
	defaults, err := config.DefaultConfigValues()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	if _, known := defaults[key]; !known {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "unknown configuration key"})
		return
	}

	logger.Infof("admin revealed configuration value for %q", key)

	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"key":     key,
		"value":   appConfig.Get(key),
		"default": defaults[key],
	}})
}

// SetAdminConfigRequest is the PUT body.
type SetAdminConfigRequest struct {
	Key   string      `json:"key"`
	Value interface{} `json:"value"`
}

// SetAdminConfigValue writes one override into the custom config and applies it live. Admin-only.
//
// Only keys present in the shipped catalogue are accepted. A free-form "add any property" form
// would make a typo permanent — the setting would sit in the file forever, look configured, and
// do nothing. Since #456 guarantees the catalogue is complete, rejecting unknown keys costs
// nothing and removes that failure mode.
//
// The new value must match the shipped default's type, so metrics.port cannot become "nine
// thousand" and fail obscurely at use.
func SetAdminConfigValue(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "admin role required"})
		return
	}
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	var req SetAdminConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "invalid request"})
		return
	}
	key := strings.ToLower(strings.TrimSpace(req.Key))

	defaults, err := config.DefaultConfigValues()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	shipped, known := defaults[key]
	if !known {
		c.JSON(http.StatusBadRequest, gin.H{"success": false,
			"error": fmt.Sprintf("unknown configuration key %q — only keys shipped in app-default-config.json can be set", key)})
		return
	}

	// Refuse rather than accept-then-revert. Environment outranks the custom store on startup, so
	// writing this key would take effect now and silently undo itself on the next restart — an
	// edit that appears to work and quietly reverts is worse than one that is refused.
	if config.IsSetByEnvironment(key) {
		c.JSON(http.StatusConflict, gin.H{"success": false,
			"error": fmt.Sprintf("%s is set by the environment variable %s, which takes precedence over this screen — change it in your deployment configuration instead",
				key, config.EnvVarFor(key))})
		return
	}

	value, err := coerceToShippedType(req.Value, shipped)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": fmt.Sprintf("%s: %s", key, err)})
		return
	}

	if err := config.SetCustomValues(appConfig, map[string]interface{}{key: value}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Config changes are security-relevant — an admin can publish a key or repoint the relay.
	logger.Infof("admin set configuration key %q", key)

	// Turning demo mode on from this screen has to provision the demo credential here and now
	// (#515). The alternative is a restart, and the symptom of forgetting it is a demo button that
	// refuses every visitor with "demo mode is not configured" — a setting that looks applied and
	// is not. Failure is logged, not returned: the config change itself succeeded.
	if strings.HasPrefix(key, "demo.") {
		databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
		if err := demo.ProvisionCredential(c, appConfig, databaseRepo, logger); err != nil {
			logger.Warnf("could not provision the demo credential after setting %q: %v", key, err)
		}
		if err := demo.ProvisionAdmin(c, appConfig, databaseRepo, logger); err != nil {
			logger.Warnf("could not provision the demo admin after setting %q: %v", key, err)
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"key": key}})
}

// ResetAdminConfigValue removes an override so the setting returns to its shipped default.
// Admin-only.
//
// Distinct from setting an empty value: "" is a legitimate choice (no support URL), and it must
// stay distinguishable from "use whatever ships".
func ResetAdminConfigValue(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "admin role required"})
		return
	}
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	key := strings.ToLower(strings.TrimSpace(c.Param("key")))
	cleared, err := config.ClearCustomValue(appConfig, key)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	if cleared {
		logger.Infof("admin reset configuration key %q to its shipped default", key)
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"key": key, "cleared": cleared}})
}

// coerceToShippedType keeps a value the same shape as the default it replaces.
//
// JSON numbers arrive as float64, so an int setting needs converting back or it surfaces as
// 9.091e+03. A genuine type change (string where a bool belongs) is rejected rather than
// coerced: silently turning "false" into a truthy string is how a disabled feature turns itself
// on.
func coerceToShippedType(value interface{}, shipped interface{}) (interface{}, error) {
	switch shipped.(type) {
	case string:
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("expected a string")
		}
		return text, nil

	case bool:
		flag, ok := value.(bool)
		if !ok {
			return nil, fmt.Errorf("expected true or false")
		}
		return flag, nil

	case int:
		number, ok := value.(float64)
		if !ok {
			return nil, fmt.Errorf("expected a number")
		}
		if number != float64(int(number)) {
			return nil, fmt.Errorf("expected a whole number")
		}
		return int(number), nil

	case []interface{}:
		list, ok := value.([]interface{})
		if !ok {
			return nil, fmt.Errorf("expected a list")
		}
		return list, nil
	}

	// Unknown shape (a future object-valued setting): accept as given rather than guess.
	return value, nil
}
