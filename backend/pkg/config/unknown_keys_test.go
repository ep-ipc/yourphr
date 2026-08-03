package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

func TestFindUnknownKeys_QuietWhenEverythingIsKnown(t *testing.T) {
	c, _ := newStoreConfig(t)
	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{"operator.name": "NBTH"}))

	report, err := config.FindUnknownKeys(c)
	require.NoError(t, err)
	require.True(t, report.Empty(), "a valid override must not warn: %+v", report)
}

// The failure this exists for: a typo sits in the file forever, looks configured, does nothing.
func TestFindUnknownKeys_NamesATypoInTheCustomFile(t *testing.T) {
	c, root := newStoreConfig(t)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "config"), 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(root, "config", config.CustomConfigFileName),
		[]byte(`{"operator.nmae":"typo","operator.name":"fine"}`), 0o600))

	report, err := config.FindUnknownKeys(c)
	require.NoError(t, err)
	require.Equal(t, []string{"operator.nmae"}, report.FromCustomConfig)
	require.NotContains(t, report.FromCustomConfig, "operator.name")
}

// REGRESSION for the real incident: the reference deployment set web.listen_port, which is not
// web.listen.port, and ran on the default indefinitely with nothing reporting it.
func TestFindUnknownKeys_NamesAMisspelledEnvironmentVariable(t *testing.T) {
	c, _ := newStoreConfig(t)
	t.Setenv("YOURPHR_WEB_LISTEN_PORT_TYPO", "8080")

	report, err := config.FindUnknownKeys(c)
	require.NoError(t, err)
	require.Contains(t, report.FromEnvironment, "YOURPHR_WEB_LISTEN_PORT_TYPO")
}

func TestFindUnknownKeys_AcceptsAValidEnvironmentVariable(t *testing.T) {
	c, _ := newStoreConfig(t)
	t.Setenv("YOURPHR_OPERATOR_CONTACT_EMAIL", "help@example.org")

	report, err := config.FindUnknownKeys(c)
	require.NoError(t, err)
	require.NotContains(t, report.FromEnvironment, "YOURPHR_OPERATOR_CONTACT_EMAIL")
}

// Provisioning variables are consumed by the provider seeders and are deliberately not settings.
// Flagging them would train an operator to ignore the warning.
func TestFindUnknownKeys_IgnoresProvisioningVariables(t *testing.T) {
	c, _ := newStoreConfig(t)
	t.Setenv("YOURPHR_SANDBOX_EPIC_CLIENT_ID", "abc")
	t.Setenv("YOURPHR_PROD_BLUEBUTTON_CLIENT_SECRET", "def")

	report, err := config.FindUnknownKeys(c)
	require.NoError(t, err)
	require.Empty(t, report.FromEnvironment)
}

// A key whose env spelling collides is compared in the exact direction, not by inverting the
// lossy mapping: backup.allowed-roots and backup.allowed_roots would both be
// YOURPHR_BACKUP_ALLOWED_ROOTS.
func TestFindUnknownKeys_ComparesEnvVarsInTheirOwnSpelling(t *testing.T) {
	c, _ := newStoreConfig(t)
	t.Setenv("YOURPHR_BACKUP_ALLOWED_ROOTS", "/nas-backup")

	report, err := config.FindUnknownKeys(c)
	require.NoError(t, err)
	require.NotContains(t, report.FromEnvironment, "YOURPHR_BACKUP_ALLOWED_ROOTS",
		"backup.allowed-roots is a real key; the dash must not make it look unknown")
}

func TestUnknownKeyReport_MessagesSayWhereTheKeyCameFrom(t *testing.T) {
	report := config.UnknownKeyReport{
		FromCustomConfig: []string{"operator.nmae"},
		FromEnvironment:  []string{"YOURPHR_NOPE"},
	}

	messages := report.Messages("/data/config/app-custom-config.json")
	require.Len(t, messages, 2)
	require.Contains(t, messages[0], "/data/config/app-custom-config.json")
	require.Contains(t, messages[0], "operator.nmae")
	require.Contains(t, messages[1], "YOURPHR_NOPE")
	for _, m := range messages {
		require.Contains(t, m, "no effect", "the message must say why it matters")
	}
}
