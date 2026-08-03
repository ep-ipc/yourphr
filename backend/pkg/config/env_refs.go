package config

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Environment references let a config VALUE name an environment variable instead of carrying a
// secret (#460). Ported from jwilleke/ngdpbase's ConfigurationManager.resolveEnvRef.
//
//	"jwt.issuer.key": "${YOURPHR_JWT_ISSUER_KEY}"
//	"database.location": "${DATA_ROOT}/fasten.db"
//
// Two forms, with deliberately different strictness:
//
//	$VAR    whole-value reference. STRICT — an unset variable is an error, because the value was
//	        supposed to come from somewhere and silently becoming empty would start the instance
//	        in a state nobody chose.
//	${VAR}  embedded substitution. LENIENT — resolves to empty when unset, so a reference can
//	        stand in for "this is optional, and here is where it would come from".
//
// Note what this does NOT do: keys prefixed YOURPHR_ are already mapped by viper's AutomaticEnv,
// so YOURPHR_JWT_ISSUER_KEY overrides jwt.issuer.key with or without a reference. References earn
// their keep for variables that are NOT auto-mapped (a Kubernetes secret exposed under some other
// name), for embedding a value inside a larger string, and — mostly — as documentation: the
// shipped file can show where a secret comes from without containing one.
var (
	bareEnvRef     = regexp.MustCompile(`^\$([A-Za-z_][A-Za-z0-9_]*)$`)
	embeddedEnvRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)
)

// ResolveEnvRefs replaces environment references in every string value of values.
//
// Returns an error naming the key and the variable when a strict $VAR reference is unset, so the
// failure says what to set rather than surfacing later as an empty setting.
func ResolveEnvRefs(values map[string]interface{}) (map[string]interface{}, error) {
	out := make(map[string]interface{}, len(values))
	for key, value := range values {
		text, ok := value.(string)
		if !ok {
			out[key] = value
			continue
		}

		resolved, err := resolveEnvRef(text)
		if err != nil {
			return nil, fmt.Errorf("config key %q: %w", key, err)
		}
		out[key] = resolved
	}
	return out, nil
}

func resolveEnvRef(value string) (string, error) {
	if match := bareEnvRef.FindStringSubmatch(strings.TrimSpace(value)); match != nil {
		name := match[1]
		resolved, ok := os.LookupEnv(name)
		if !ok {
			return "", fmt.Errorf("environment variable %s is not set (referenced as $%s; use ${%s} if it is optional)", name, name, name)
		}
		return resolved, nil
	}

	// Embedded form: unset variables become empty, matching ngdpbase.
	return embeddedEnvRef.ReplaceAllStringFunc(value, func(token string) string {
		name := embeddedEnvRef.FindStringSubmatch(token)[1]
		return os.Getenv(name)
	}), nil
}
