package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

func TestCustomConfigValues_EmptyWhenNoFile(t *testing.T) {
	c, _ := newStoreConfig(t)

	values, err := config.CustomConfigValues(c)
	require.NoError(t, err)
	require.Empty(t, values)
}

// The Admin screen needs the custom layer ALONE — the merged view cannot tell you which values
// an operator actually chose, which is the question the screen exists to answer.
func TestCustomConfigValues_ReturnsOnlyOverrides(t *testing.T) {
	c, _ := newStoreConfig(t)
	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{"operator.name": "NBTH"}))

	values, err := config.CustomConfigValues(c)
	require.NoError(t, err)
	require.Equal(t, map[string]interface{}{"operator.name": "NBTH"}, values)
	require.NotContains(t, values, "database.location", "defaults must not appear as overrides")
}

func TestCustomConfigValues_ReadsALegacyNestedFile(t *testing.T) {
	c, root := newStoreConfig(t)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "config"), 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(root, "config", config.CustomConfigFileName),
		[]byte(`{"operator":{"name":"Legacy Ops"}}`), 0o600))

	values, err := config.CustomConfigValues(c)
	require.NoError(t, err)
	require.Equal(t, "Legacy Ops", values["operator.name"])
}

func TestClearCustomValue_RestoresTheShippedDefault(t *testing.T) {
	c, _ := newStoreConfig(t)
	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{"metrics.port": 9999}))
	require.Equal(t, 9999, c.GetInt("metrics.port"))

	cleared, err := config.ClearCustomValue(c, "metrics.port")
	require.NoError(t, err)
	require.True(t, cleared)

	require.Equal(t, 9091, c.GetInt("metrics.port"), "the shipped default must be back in effect")

	values, err := config.CustomConfigValues(c)
	require.NoError(t, err)
	require.NotContains(t, values, "metrics.port", "and gone from the overlay")
}

func TestClearCustomValue_ReportsWhenNothingWasOverridden(t *testing.T) {
	c, _ := newStoreConfig(t)
	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{"operator.name": "NBTH"}))

	cleared, err := config.ClearCustomValue(c, "metrics.port")
	require.NoError(t, err)
	require.False(t, cleared)
}

// Resetting one key must not disturb the others — the same read-modify-write property a save has.
func TestClearCustomValue_LeavesOtherOverridesAlone(t *testing.T) {
	c, _ := newStoreConfig(t)
	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{
		"operator.name": "NBTH",
		"theme.name":    "flatly",
	}))

	_, err := config.ClearCustomValue(c, "operator.name")
	require.NoError(t, err)

	values, err := config.CustomConfigValues(c)
	require.NoError(t, err)
	require.Equal(t, "flatly", values["theme.name"])
	require.NotContains(t, values, "operator.name")
}

// An empty string is a legitimate setting ("this instance publishes no support URL"), and must
// stay distinguishable from "use whatever ships".
func TestClearCustomValue_IsNotTheSameAsSettingEmpty(t *testing.T) {
	c, _ := newStoreConfig(t)
	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{"log.level": ""}))

	values, err := config.CustomConfigValues(c)
	require.NoError(t, err)
	require.Contains(t, values, "log.level", "an empty override is still an override")
	require.Equal(t, "", c.GetString("log.level"))

	_, err = config.ClearCustomValue(c, "log.level")
	require.NoError(t, err)
	require.Equal(t, "INFO", c.GetString("log.level"), "now the shipped default applies")
}
