package config

import (
	"fmt"
	"os"
	"sort"
	"strings"
)

// provisioningEnvPrefixes are YOURPHR_* variables that are NOT configuration keys.
//
// They are provisioning inputs, read once at startup by the provider seeders to create catalog
// rows, and ignored thereafter — the value in effect afterwards is the database row, which an
// admin may have edited. They are deliberately absent from the catalogue: listing them would put
// them on the Admin Configuration screen showing the environment's value while the row held a
// different one, and that screen's contract is that it shows the effective value.
//
// See docs/configuration-system.md and #471.
var provisioningEnvPrefixes = []string{
	"YOURPHR_SANDBOX_",
	"YOURPHR_PROD_BLUEBUTTON_",
}

// UnknownKeyReport names configuration that will have no effect.
type UnknownKeyReport struct {
	// FromCustomConfig are keys in app-custom-config.json that are not settings.
	FromCustomConfig []string
	// FromEnvironment are YOURPHR_* variables that map to no setting.
	FromEnvironment []string
}

// Empty reports whether there is nothing to warn about.
func (r UnknownKeyReport) Empty() bool {
	return len(r.FromCustomConfig) == 0 && len(r.FromEnvironment) == 0
}

// Messages renders one operator-facing line per unknown key.
//
// Each names where the key came from, because "unknown key" without a location is not
// actionable — the whole failure being addressed is not knowing which of several places a value
// lives in.
func (r UnknownKeyReport) Messages(customConfigPath string) []string {
	var out []string
	for _, key := range r.FromCustomConfig {
		out = append(out, fmt.Sprintf(
			"config: %q in %s is not a known setting and has no effect", key, customConfigPath))
	}
	for _, name := range r.FromEnvironment {
		out = append(out, fmt.Sprintf(
			"config: environment variable %s does not map to any known setting and has no effect", name))
	}
	return out
}

// FindUnknownKeys reports configuration that will silently do nothing.
//
// This is not hypothetical. The reference deployment's mounted config set four keys that do not
// exist — web.listen_port is not web.listen.port — and it ran that way indefinitely, because
// nothing distinguishes "set" from "ignored" when a value simply falls through to its default.
//
// WARN, never refuse. Refusing to start on an unknown key would turn a removed setting into a
// boot loop on upgrade: every instance still carrying the old key would fail to come up. An
// unknown key is an operator's mistake worth naming loudly, not worth taking an instance down
// for.
func FindUnknownKeys(c Interface) (UnknownKeyReport, error) {
	known, err := DefaultConfigValues()
	if err != nil {
		return UnknownKeyReport{}, err
	}

	lowered := make(map[string]struct{}, len(known))
	for key := range known {
		lowered[strings.ToLower(key)] = struct{}{}
	}

	// Compare environment variables in their OWN spelling rather than trying to invert the
	// mapping: EnvVarFor is lossy, since both "." and "-" become "_", so YOURPHR_A_B could mean
	// a.b or a-b. Going key -> variable is exact; going back is a guess.
	knownEnvVars := make(map[string]struct{}, len(known))
	for key := range known {
		knownEnvVars[EnvVarFor(key)] = struct{}{}
	}

	report := UnknownKeyReport{
		FromCustomConfig: unknownCustomKeys(c, lowered),
		FromEnvironment:  unknownEnvironmentKeys(knownEnvVars),
	}
	sort.Strings(report.FromCustomConfig)
	sort.Strings(report.FromEnvironment)
	return report, nil
}

func unknownCustomKeys(c Interface, known map[string]struct{}) []string {
	custom, err := CustomConfigValues(c)
	if err != nil {
		// A malformed file is reported by LoadCustomConfig, which runs first and fails loudly.
		// Nothing useful to add here.
		return nil
	}

	var out []string
	for key := range custom {
		if _, ok := known[strings.ToLower(key)]; !ok {
			out = append(out, key)
		}
	}
	return out
}

func unknownEnvironmentKeys(knownEnvVars map[string]struct{}) []string {
	var out []string
	for _, entry := range os.Environ() {
		name, _, found := strings.Cut(entry, "=")
		if !found || !strings.HasPrefix(name, "YOURPHR_") {
			continue
		}
		if isProvisioningEnvVar(name) {
			continue
		}
		if _, ok := knownEnvVars[name]; !ok {
			out = append(out, name)
		}
	}
	return out
}

func isProvisioningEnvVar(name string) bool {
	for _, prefix := range provisioningEnvPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
