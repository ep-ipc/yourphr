package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

// REGRESSION for yourphr#470. The binary used to read "config.yaml" from its working directory
// automatically, which made it a silent fourth configuration layer on every deployment — and in
// the reference deployment that file was shadowed by a ConfigMap, so removing the mount would
// have revealed settings (encryption on with no key) that crash the backend at startup.
//
// A config file must now only be read when one is asked for.
func TestNoConfigFileIsReadFromTheWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "config.yaml"),
		[]byte("log:\n  level: TRAPDOOR\n"), 0o644))

	cwd, err := os.Getwd()
	require.NoError(t, err)
	require.NoError(t, os.Chdir(dir))
	t.Cleanup(func() { _ = os.Chdir(cwd) })

	c, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, c.Init())

	require.Equal(t, "INFO", c.GetString("log.level"),
		"a config.yaml sitting in the working directory must not be picked up implicitly")
}

// The explicit flag still works — the Makefile and bare-metal installs rely on it.
//
// The file turns encryption off because the shipped default is ON and validation now requires a
// key when it is: an unencrypted install has to say so, which is what every deployment template
// does.
func TestConfigFileIsReadWhenAskedFor(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mine.yaml")
	require.NoError(t, os.WriteFile(path,
		[]byte("log:\n  level: DEBUG\ndatabase:\n  encryption:\n    enabled: false\n"), 0o644))

	c, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, c.Init())
	require.NoError(t, c.ReadConfig(path))

	require.Equal(t, "DEBUG", c.GetString("log.level"))
}

// The other half of yourphr#470: encryption on with no key is the combination that crashed the
// backend at startup once the shadowing ConfigMap was removed. It is now refused by name, with the
// two ways out in the message, instead of failing later inside the database driver.
func TestEncryptionWithoutAKeyIsRefusedByName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mine.yaml")
	require.NoError(t, os.WriteFile(path,
		[]byte("database:\n  encryption:\n    enabled: true\n"), 0o644))

	c, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, c.Init())

	err = c.ReadConfig(path)
	require.Error(t, err)
	require.Contains(t, err.Error(), "database.encryption.key is required")
	require.Contains(t, err.Error(), "YOURPHR_DATABASE_ENCRYPTION_ENABLED=false",
		"the error must name the way out, not just the problem")
}
