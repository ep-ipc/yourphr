package database

import (
	"encoding/json"
	"fmt"
	"net/mail"
	"os"
	"path/filepath"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
)

// OperatorSettings is the instance operator contact shown to users (privacy/help/wipe)
// and editable from the Admin Dashboard.
//
// Persisted in the instance custom config store (<data root>/config/app-custom-config.json)
// under operator.*, alongside every other instance-customizable setting — see #452. It used
// to live in its own .operator_settings.json; that file is migrated on first load and then
// no longer read.
type OperatorSettings struct {
	Name         string `json:"name"`          // e.g. "Nerds by the Hour"
	ContactEmail string `json:"contact_email"` // support address for this instance
	ContactURL   string `json:"contact_url"`   // optional help / privacy page
}

// legacyOperatorSettingsPath is the pre-#452 per-concern file. Read once by
// MigrateLegacyOperatorSettings, never afterwards.
func legacyOperatorSettingsPath(appConfig config.Interface) string {
	return filepath.Join(dbDirFromConfig(appConfig), ".operator_settings.json")
}

// LoadOperatorSettings reads the effective operator contact from the merged configuration —
// built-in defaults, overlaid by the custom config store, overlaid by YOURPHR_OPERATOR_* env.
func LoadOperatorSettings(appConfig config.Interface) OperatorSettings {
	s := OperatorSettings{
		Name:         appConfig.GetString("operator.name"),
		ContactEmail: appConfig.GetString("operator.contact_email"),
		ContactURL:   appConfig.GetString("operator.contact_url"),
	}
	s.normalize()
	return s
}

// MigrateLegacyOperatorSettings folds a pre-#452 .operator_settings.json into the custom
// config store. Call once at startup, after the store is loaded.
//
// Skipped when the store already carries operator values, so a later edit through the Admin
// Dashboard is never reverted by a stale legacy file. The legacy file is renamed rather than
// deleted — if the migration read it wrong, the original is still there.
func MigrateLegacyOperatorSettings(appConfig config.Interface) error {
	path := legacyOperatorSettingsPath(appConfig)

	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading %s: %w", path, err)
	}

	var legacy OperatorSettings
	if err := json.Unmarshal(raw, &legacy); err != nil {
		return fmt.Errorf("parsing %s: %w", path, err)
	}
	legacy.normalize()

	// Empty legacy file, or the store already has values: nothing worth migrating.
	current := LoadOperatorSettings(appConfig)
	alreadySet := current.Name != "" || current.ContactEmail != "" || current.ContactURL != ""
	empty := legacy.Name == "" && legacy.ContactEmail == "" && legacy.ContactURL == ""
	if empty || alreadySet {
		return os.Rename(path, path+".migrated")
	}

	if err := SaveOperatorSettings(appConfig, legacy); err != nil {
		return fmt.Errorf("migrating %s into the custom config store: %w", path, err)
	}
	return os.Rename(path, path+".migrated")
}

func (s *OperatorSettings) normalize() {
	s.Name = strings.TrimSpace(s.Name)
	s.ContactEmail = strings.TrimSpace(s.ContactEmail)
	s.ContactURL = strings.TrimSpace(s.ContactURL)
}

// ValidateOperatorSettings checks field shapes. Empty email/url are allowed (operator
// may clear them). Non-empty email must parse; contact URL if set must look like http(s).
func ValidateOperatorSettings(s OperatorSettings) error {
	s.normalize()
	if s.ContactEmail != "" {
		if _, err := mail.ParseAddress(s.ContactEmail); err != nil {
			return errInvalidOperatorEmail
		}
	}
	if s.ContactURL != "" {
		lower := strings.ToLower(s.ContactURL)
		if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
			return errInvalidOperatorURL
		}
	}
	return nil
}

var (
	errInvalidOperatorEmail = &operatorSettingsError{msg: "contact_email must be a valid email address"}
	errInvalidOperatorURL   = &operatorSettingsError{msg: "contact_url must start with http:// or https://"}
)

type operatorSettingsError struct{ msg string }

func (e *operatorSettingsError) Error() string { return e.msg }

// SaveOperatorSettings persists the settings into the instance custom config store and applies
// them to the running configuration (no restart needed). Only the operator.* keys are written;
// the rest of the custom layer is preserved.
func SaveOperatorSettings(appConfig config.Interface, s OperatorSettings) error {
	s.normalize()
	if err := ValidateOperatorSettings(s); err != nil {
		return err
	}
	return config.SetCustomValues(appConfig, map[string]interface{}{
		"operator.name":          s.Name,
		"operator.contact_email": s.ContactEmail,
		"operator.contact_url":   s.ContactURL,
	})
}
