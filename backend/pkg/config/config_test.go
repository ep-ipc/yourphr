package config

import (
	"github.com/fastenhealth/fasten-onprem/backend/pkg/errors"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/require"
	"os"
	"path/filepath"
	"testing"
)

func Test_ValidateConfig(t *testing.T) {
	testConfig := configuration{
		Viper: viper.New(),
	}
	testConfig.Set("database.encryption.enabled", true)

	testConfig.Set("database.encryption.key", "tooshort")
	err := testConfig.ValidateConfig()
	require.ErrorIs(t, err, errors.ConfigValidationError("database.encryption.key must be at least 10 characters"))

	testConfig.Set("database.encryption.key", "")
	err = testConfig.ValidateConfig()
	require.Error(t, err)
	require.Contains(t, err.Error(), "database.encryption.key is required")

	testConfig.Set("database.encryption.key", "a-real-key-long-enough")
	require.NoError(t, testConfig.ValidateConfig())
}

// The empty key is the catalogue's DEFAULT, so validation must not treat "present in the
// catalogue" as "supplied by the operator". Gating on IsSet would reject every unencrypted
// install, because viper reports a registered default as set.
func Test_ValidateConfig_EmptyKeyIsFineWhenEncryptionIsOff(t *testing.T) {
	testConfig := configuration{Viper: viper.New()}
	testConfig.Set("database.encryption.enabled", false)
	testConfig.Set("database.encryption.key", "")

	require.NoError(t, testConfig.ValidateConfig())
}

func Test_ResolveJWTIssuerKey(t *testing.T) {
	dir := t.TempDir()

	//an explicit, non-default key is honored as-is (no file written)
	k, err := ResolveJWTIssuerKey("operator-supplied-strong-key", dir)
	require.NoError(t, err)
	require.Equal(t, "operator-supplied-strong-key", k)
	_, statErr := os.Stat(filepath.Join(dir, jwtKeyFileName))
	require.True(t, os.IsNotExist(statErr), "explicit key must not write a key file")

	//the known public default is treated as "unset" -> generate + persist
	gen, err := ResolveJWTIssuerKey(DefaultJWTIssuerKey, dir)
	require.NoError(t, err)
	require.NotEmpty(t, gen)
	require.NotEqual(t, DefaultJWTIssuerKey, gen)
	require.Len(t, gen, 64) //256-bit, hex-encoded

	//persisted with 0600
	info, statErr := os.Stat(filepath.Join(dir, jwtKeyFileName))
	require.NoError(t, statErr)
	require.Equal(t, os.FileMode(0600), info.Mode().Perm())

	//empty is also "unset", and reuses the persisted key (stable across restarts)
	again, err := ResolveJWTIssuerKey("", dir)
	require.NoError(t, err)
	require.Equal(t, gen, again)
}
