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

	// A save applies to the running config immediately — no restart, no reload.
	got := LoadOperatorSettings(appConfig)
	require.Equal(t, want, got)

	// Persisted into the instance custom config store, not a per-concern file (#452).
	path := filepath.Join(dir, "config", config.CustomConfigFileName)
	info, err := os.Stat(path)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	require.NoFileExists(t, filepath.Join(dir, ".operator_settings.json"),
		"the legacy per-concern file must no longer be written")
}

// A pre-#452 .operator_settings.json is folded into the custom config store on startup, and the
// legacy file is renamed rather than deleted so a bad migration is recoverable.
func TestMigrateLegacyOperatorSettings(t *testing.T) {
	appConfig, err := config.Create()
	require.NoError(t, err)
	dir := t.TempDir()
	appConfig.Set("database.location", filepath.Join(dir, "fasten.db"))

	legacy := filepath.Join(dir, ".operator_settings.json")
	require.NoError(t, os.WriteFile(legacy,
		[]byte(`{"name":"Legacy Ops","contact_email":"legacy@example.org","contact_url":"https://example.org/x"}`),
		0o600))

	require.NoError(t, MigrateLegacyOperatorSettings(appConfig))

	got := LoadOperatorSettings(appConfig)
	require.Equal(t, "Legacy Ops", got.Name)
	require.Equal(t, "legacy@example.org", got.ContactEmail)
	require.Equal(t, "https://example.org/x", got.ContactURL)

	require.NoFileExists(t, legacy)
	require.FileExists(t, legacy+".migrated")
}

// Nothing to migrate is the common case and must not error or leave a stray file.
func TestMigrateLegacyOperatorSettings_NoLegacyFile(t *testing.T) {
	appConfig, err := config.Create()
	require.NoError(t, err)
	dir := t.TempDir()
	appConfig.Set("database.location", filepath.Join(dir, "fasten.db"))

	require.NoError(t, MigrateLegacyOperatorSettings(appConfig))
	require.NoFileExists(t, filepath.Join(dir, ".operator_settings.json")+".migrated")
}

// A stale legacy file must never revert a newer edit made through the Admin Dashboard.
func TestMigrateLegacyOperatorSettings_DoesNotOverwriteExistingValues(t *testing.T) {
	appConfig, err := config.Create()
	require.NoError(t, err)
	dir := t.TempDir()
	appConfig.Set("database.location", filepath.Join(dir, "fasten.db"))

	require.NoError(t, SaveOperatorSettings(appConfig, OperatorSettings{Name: "Current Ops"}))

	legacy := filepath.Join(dir, ".operator_settings.json")
	require.NoError(t, os.WriteFile(legacy, []byte(`{"name":"Stale Ops"}`), 0o600))

	require.NoError(t, MigrateLegacyOperatorSettings(appConfig))

	require.Equal(t, "Current Ops", LoadOperatorSettings(appConfig).Name)
	require.FileExists(t, legacy+".migrated")
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
