package config_test

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

// The committed bootstrap templates, one per deployment type (#474). An operator's first contact
// with configuration is copying one of these, so a variable that has quietly been renamed or
// deleted here is worse than no example at all: it looks authoritative and does nothing.
//
// This is the same failure FindUnknownKeys warns about at runtime, caught at build time instead —
// the reference deployment shipped four keys that did not exist (web.listen_port is not
// web.listen.port) and ran that way indefinitely.
var envExampleFiles = []string{
	".env.example",
	".env.baremetal.example",
	".env.docker.example",
	".env.k8s.example",
	".env.dev.example",
}

// nonYourphrExampleVars are variables in the templates that are deliberately NOT settings.
// docker-compose.yml substitutes them to decide what is published on the host; the application
// never reads them, so they have no catalogue entry and must not be flagged.
var nonYourphrExampleVars = map[string]struct{}{
	"HOSTNAME":   {},
	"IP":         {},
	"PORT":       {},
	"domainname": {},
	"HOST_IP":    {},
	"HOST_PORT":  {},
}

func TestEnvExamples_OnlyReferenceRealSettings(t *testing.T) {
	known, err := config.DefaultConfigValues()
	require.NoError(t, err)

	knownEnvVars := make(map[string]string, len(known))
	for key := range known {
		knownEnvVars[config.EnvVarFor(key)] = key
	}

	for _, name := range envExampleFiles {
		t.Run(name, func(t *testing.T) {
			for _, v := range readExampleVars(t, filepath.Join(repoRoot(t), name)) {
				if _, ok := nonYourphrExampleVars[v]; ok {
					continue
				}
				require.Truef(t, strings.HasPrefix(v, "YOURPHR_"),
					"%s sets %s, which is neither a YOURPHR_ setting nor a known compose variable", name, v)
				if _, ok := knownEnvVars[v]; !ok {
					t.Errorf("%s documents %s, which maps to no setting in app-default-config.json — "+
						"an operator copying this file gets a variable that does nothing", name, v)
				}
			}
		})
	}
}

// Every template must exist. Deleting one silently is how a deployment type loses its documented
// bootstrap; the list above is the contract.
func TestEnvExamples_AllPresent(t *testing.T) {
	for _, name := range envExampleFiles {
		_, err := os.Stat(filepath.Join(repoRoot(t), name))
		require.NoErrorf(t, err, "missing bootstrap template %s", name)
	}
}

// readExampleVars returns every variable name assigned in the file, INCLUDING ones commented out.
// Commented lines are the ones an operator uncomments, so a stale name there misleads exactly as
// much as a live one — and being commented is precisely why it would otherwise never be noticed.
func readExampleVars(t *testing.T, path string) []string {
	t.Helper()

	file, err := os.Open(path)
	require.NoError(t, err)
	defer file.Close()

	var out []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		line = strings.TrimSpace(strings.TrimPrefix(line, "#"))

		name, _, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		name = strings.TrimSpace(name)
		// Prose containing an "=" is not an assignment; a variable name has no spaces.
		if name == "" || strings.ContainsAny(name, " \t") {
			continue
		}
		out = append(out, name)
	}
	require.NoError(t, scanner.Err())
	return out
}
