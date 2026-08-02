package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

// newStoreConfig returns a config rooted at a temp data dir, so each test gets its own
// app-custom-config.json.
func newStoreConfig(t *testing.T) (config.Interface, string) {
	t.Helper()
	root := t.TempDir()
	c := newTestConfig(t)
	c.Set("storage.data_dir", root)
	return c, root
}

func readStoreFile(t *testing.T, root string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, "config", config.CustomConfigFileName))
	require.NoError(t, err)
	var out map[string]interface{}
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

// An instance that has never customized anything is the normal case, not an error.
func TestLoadCustomConfig_MissingFileIsNotAnError(t *testing.T) {
	c, _ := newStoreConfig(t)
	require.NoError(t, config.LoadCustomConfig(c))
}

// Silently ignoring a malformed file would present built-in defaults as though they were the
// operator's settings.
func TestLoadCustomConfig_MalformedFileIsAnError(t *testing.T) {
	c, root := newStoreConfig(t)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "config"), 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(root, "config", config.CustomConfigFileName),
		[]byte("{not json"), 0o600))

	require.Error(t, config.LoadCustomConfig(c))
}

func TestLoadCustomConfig_OverlaysOverDefaults(t *testing.T) {
	c, root := newStoreConfig(t)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "config"), 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(root, "config", config.CustomConfigFileName),
		[]byte(`{"operator":{"name":"Nerds by the Hour","contact_email":"help@example.org"}}`), 0o600))

	require.NoError(t, config.LoadCustomConfig(c))

	require.Equal(t, "Nerds by the Hour", c.GetString("operator.name"))
	require.Equal(t, "help@example.org", c.GetString("operator.contact_email"))
	// Untouched keys still fall through to their defaults.
	require.Equal(t, "", c.GetString("operator.contact_url"))
}

func TestSetCustomValues_WritesNestedJSONAndAppliesLive(t *testing.T) {
	c, root := newStoreConfig(t)

	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{
		"operator.name":          "Nerds by the Hour",
		"operator.contact_email": "help@example.org",
	}))

	// Applied to the running config without a reload.
	require.Equal(t, "Nerds by the Hour", c.GetString("operator.name"))

	stored := readStoreFile(t, root)
	operator, ok := stored["operator"].(map[string]interface{})
	require.True(t, ok, "dotted keys must be written as nested objects, got %#v", stored["operator"])
	require.Equal(t, "Nerds by the Hour", operator["name"])
	require.Equal(t, "help@example.org", operator["contact_email"])
}

// The file is the CUSTOM layer. Writing the merged view would freeze today's defaults into the
// instance, so a later release that changed a default would silently not apply.
func TestSetCustomValues_StoresOnlyWhatWasSet(t *testing.T) {
	c, root := newStoreConfig(t)

	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{
		"operator.name": "Nerds by the Hour",
	}))

	stored := readStoreFile(t, root)
	delete(stored, "_comment")
	require.Len(t, stored, 1, "only the operator branch should be persisted, got %#v", stored)
	require.NotContains(t, stored, "database")
	require.NotContains(t, stored, "jwt")
}

// A second save must not wipe the first: the whole point of read-modify-write.
func TestSetCustomValues_PreservesUnrelatedKeys(t *testing.T) {
	c, root := newStoreConfig(t)

	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{"theme.name": "flatly"}))
	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{"operator.name": "NBTH"}))

	stored := readStoreFile(t, root)
	theme, ok := stored["theme"].(map[string]interface{})
	require.True(t, ok, "earlier key was clobbered: %#v", stored)
	require.Equal(t, "flatly", theme["name"])
	require.Equal(t, "NBTH", stored["operator"].(map[string]interface{})["name"])
}

// Clobbering a file we cannot parse would destroy settings the operator may want back.
func TestSetCustomValues_RefusesToOverwriteMalformedFile(t *testing.T) {
	c, root := newStoreConfig(t)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "config"), 0o755))
	path := filepath.Join(root, "config", config.CustomConfigFileName)
	require.NoError(t, os.WriteFile(path, []byte("{not json"), 0o600))

	require.Error(t, config.SetCustomValues(c, map[string]interface{}{"operator.name": "NBTH"}))

	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, "{not json", string(raw), "the unparseable file must be left untouched")
}

// Underscore-prefixed keys are comments, not settings — they must never reach the config.
func TestLoadCustomConfig_StripsCommentKeys(t *testing.T) {
	c, root := newStoreConfig(t)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "config"), 0o755))
	require.NoError(t, os.WriteFile(
		filepath.Join(root, "config", config.CustomConfigFileName),
		[]byte(`{"_comment":"hi","operator":{"_note":"x","name":"NBTH"}}`), 0o600))

	require.NoError(t, config.LoadCustomConfig(c))

	require.Equal(t, "NBTH", c.GetString("operator.name"))
	require.Nil(t, c.Get("_comment"))
	require.Nil(t, c.Get("operator._note"))
}

func TestSetCustomValues_FileIsNotWorldReadable(t *testing.T) {
	c, root := newStoreConfig(t)
	require.NoError(t, config.SetCustomValues(c, map[string]interface{}{"operator.name": "NBTH"}))

	info, err := os.Stat(filepath.Join(root, "config", config.CustomConfigFileName))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}

func TestCustomConfigPath_LivesUnderTheDataRoot(t *testing.T) {
	c, root := newStoreConfig(t)
	require.Equal(t,
		filepath.Join(root, "config", config.CustomConfigFileName),
		config.CustomConfigPath(c))
}
