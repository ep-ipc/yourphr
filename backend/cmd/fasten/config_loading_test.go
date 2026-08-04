package main

import (
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
	"github.com/urfave/cli/v2"
)

// REGRESSION for yourphr#470. The binary used to read "config.yaml" from its working directory
// automatically, which made it a silent configuration layer on every deployment — and in the
// reference deployment that file was shadowed by a ConfigMap, so removing the mount would have
// revealed settings (encryption on with no key) that put the backend into standby with no UI.
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

// yourphr#474 removed the YAML layer entirely, including the explicit --config flag.
//
// The flag itself is kept ONLY so this error can be produced. Accepting it and ignoring the file
// would drop the operator's real settings silently, which is the failure the removal was for;
// deleting the flag would produce "flag provided but not defined: -config", which explains
// nothing. So passing it must fail, and the failure must say what to do instead.
func TestConfigFlagIsRejectedWithInstructions(t *testing.T) {
	set := flagSetWithConfig(t, "/some/where/mine.yaml")

	err := rejectRemovedConfigFlag(cli.NewContext(nil, set, nil))

	require.Error(t, err)
	require.Contains(t, err.Error(), "/some/where/mine.yaml", "name the file that is being ignored")
	require.Contains(t, err.Error(), ".env.docker.example", "name the replacement")
	require.Contains(t, err.Error(), "docs/configuration-system.md")
}

// The overwhelmingly common case — no flag — must stay silent.
func TestNoConfigFlagIsFine(t *testing.T) {
	require.NoError(t, rejectRemovedConfigFlag(cli.NewContext(nil, emptyFlagSet(t), nil)))
}

func flagSetWithConfig(t *testing.T, value string) *flag.FlagSet {
	t.Helper()
	set := emptyFlagSet(t)
	require.NoError(t, set.Set("config", value))
	return set
}

func emptyFlagSet(t *testing.T) *flag.FlagSet {
	t.Helper()
	set := flag.NewFlagSet("test", flag.ContinueOnError)
	set.String("config", "", "")
	return set
}
