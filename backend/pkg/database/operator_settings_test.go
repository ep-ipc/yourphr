package database

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

func TestLoadOperatorSettings_FromConfigWhenNoFile(t *testing.T) {
	appConfig, err := config.Create()
	require.NoError(t, err)
	dir := t.TempDir()
	appConfig.Set("database.location", filepath.Join(dir, "fasten.db"))
	appConfig.Set("operator.name", "From Config")
	appConfig.Set("operator.contact_email", "config@example.com")
	appConfig.Set("operator.contact_url", "https://example.com/help")

	s := LoadOperatorSettings(appConfig)
	require.Equal(t, "From Config", s.Name)
	require.Equal(t, "config@example.com", s.ContactEmail)
	require.Equal(t, "https://example.com/help", s.ContactURL)
}

func TestSaveAndLoadOperatorSettings(t *testing.T) {
	appConfig, err := config.Create()
	require.NoError(t, err)
	dir := t.TempDir()
	appConfig.Set("database.location", filepath.Join(dir, "fasten.db"))
	appConfig.Set("operator.name", "From Config")
	appConfig.Set("operator.contact_email", "config@example.com")

	want := OperatorSettings{
		Name:         "Hosted Ops",
		ContactEmail: "ops@example.org",
		ContactURL:   "https://example.org/support",
	}
	require.NoError(t, SaveOperatorSettings(appConfig, want))

	// Config still has old values; file must win.
	got := LoadOperatorSettings(appConfig)
	require.Equal(t, want, got)

	path := filepath.Join(dir, ".operator_settings.json")
	info, err := os.Stat(path)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}

func TestValidateOperatorSettings(t *testing.T) {
	require.NoError(t, ValidateOperatorSettings(OperatorSettings{}))
	require.NoError(t, ValidateOperatorSettings(OperatorSettings{
		ContactEmail: "a@b.co",
		ContactURL:   "https://x.example",
	}))
	require.Error(t, ValidateOperatorSettings(OperatorSettings{ContactEmail: "not-an-email"}))
	require.Error(t, ValidateOperatorSettings(OperatorSettings{ContactURL: "ftp://nope"}))
	require.Error(t, ValidateOperatorSettings(OperatorSettings{ContactURL: "example.com"}))
}
