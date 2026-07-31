package database

import (
	"encoding/json"
	"net/mail"
	"os"
	"path/filepath"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
)

// OperatorSettings is the instance operator contact shown to users (privacy/help/wipe)
// and editable from the Admin Dashboard. Persisted as JSON in the data dir (same pattern
// as BackupSettings) so it survives restarts and can change without redeploy.
//
// Config / env (operator.* / YOURPHR_OPERATOR_*) seed defaults when no file exists yet.
// Once saved from the UI, the file is the source of truth for those fields.
type OperatorSettings struct {
	Name         string `json:"name"`          // e.g. "Nerds by the Hour"
	ContactEmail string `json:"contact_email"` // support address for this instance
	ContactURL   string `json:"contact_url"`   // optional help / privacy page
}

func operatorSettingsPath(appConfig config.Interface) string {
	return filepath.Join(dbDirFromConfig(appConfig), ".operator_settings.json")
}

// LoadOperatorSettings reads persisted settings, falling back to config defaults.
func LoadOperatorSettings(appConfig config.Interface) OperatorSettings {
	s := OperatorSettings{
		Name:         appConfig.GetString("operator.name"),
		ContactEmail: appConfig.GetString("operator.contact_email"),
		ContactURL:   appConfig.GetString("operator.contact_url"),
	}
	if b, err := os.ReadFile(operatorSettingsPath(appConfig)); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	s.normalize()
	return s
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

// SaveOperatorSettings persists the settings (0600, next to the DB).
func SaveOperatorSettings(appConfig config.Interface, s OperatorSettings) error {
	s.normalize()
	if err := ValidateOperatorSettings(s); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(operatorSettingsPath(appConfig), b, 0o600)
}
