package config_test

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/stretchr/testify/require"
)

func TestDefaultConfigValues_ParsesAndStripsComments(t *testing.T) {
	values, err := config.DefaultConfigValues()
	require.NoError(t, err)
	require.NotEmpty(t, values)

	for key := range values {
		require.False(t, strings.HasPrefix(key, "_"),
			"comment key %q must be stripped before reaching the config", key)
	}
}

// The whole design rests on keys being flat dotted paths rather than nested objects. A nested
// object here would mean something re-introduced the namespace-or-value ambiguity.
func TestDefaultConfig_KeysAreFlatAndLowercase(t *testing.T) {
	values, err := config.DefaultConfigValues()
	require.NoError(t, err)

	for key, value := range values {
		require.Equal(t, strings.ToLower(key), key,
			"key %q must be lowercase — viper lowercases on lookup, so a mixed-case key would "+
				"appear to work while resolving to something else", key)

		_, nested := value.(map[string]interface{})
		require.False(t, nested,
			"key %q holds a nested object; keys must carry the full dotted path instead", key)
	}
}

// The signing key must never be a literal in a file that lives in git. It is an env reference
// (#460), so with YOURPHR_JWT_ISSUER_KEY unset it resolves empty — and empty already means
// "generate a real key", which is how a stock install stays secure with no operator action.
func TestDefaultConfig_JWTIssuerKeyIsAnEnvReferenceNotALiteral(t *testing.T) {
	t.Setenv("YOURPHR_JWT_ISSUER_KEY", "")

	values, err := config.DefaultConfigValues()
	require.NoError(t, err)

	require.Equal(t, "", values["jwt.issuer.key"],
		"an unset YOURPHR_JWT_ISSUER_KEY must resolve empty so a key gets generated")
	require.NotEqual(t, config.DefaultJWTIssuerKey, values["jwt.issuer.key"],
		"the committed placeholder must never be the effective default")
}

func TestDefaultConfig_JWTIssuerKeyUsesTheEnvironmentWhenSet(t *testing.T) {
	t.Setenv("YOURPHR_JWT_ISSUER_KEY", "operator-supplied-key")

	values, err := config.DefaultConfigValues()
	require.NoError(t, err)

	require.Equal(t, "operator-supplied-key", values["jwt.issuer.key"])
}

// The placeholder must not survive anywhere in the shipped file — it is the string an attacker
// would try first.
func TestDefaultConfig_ContainsNoCommittedSigningKey(t *testing.T) {
	require.NotContains(t, string(mustReadDefaults(t)), config.DefaultJWTIssuerKey,
		"app-default-config.json is in git and must not carry the known-public signing key")
}

func TestDefaultConfig_PathDefaultsMatchTheirConstants(t *testing.T) {
	values, err := config.DefaultConfigValues()
	require.NoError(t, err)

	require.Equal(t, config.DefaultDatabaseLocation, values["database.location"])
	require.Equal(t, config.DefaultCacheLocation, values["cache.location"])
}

// Numbers must survive as ints. encoding/json decodes every number as float64, so without
// normalisation 9091 reaches an operator's screen as 9.091e+03.
func TestDefaultConfig_WholeNumbersStayIntegers(t *testing.T) {
	values, err := config.DefaultConfigValues()
	require.NoError(t, err)

	require.Equal(t, 9091, values["metrics.port"])
	require.Equal(t, 60, values["jwt.session_ttl_minutes"])
}

func TestInit_AppliesShippedDefaults(t *testing.T) {
	c := newTestConfig(t)

	require.Equal(t, "8080", c.GetString("web.listen.port"))
	require.Equal(t, 9091, c.GetInt("metrics.port"))
	require.Equal(t, 60, c.GetInt("jwt.session_ttl_minutes"))
	require.Equal(t, false, c.GetBool("cda_converter.enabled"))
	require.Equal(t, "/opt/fasten/db/fasten.db", c.GetString("database.location"))
	require.Equal(t, "", c.GetString("operator.contact_email"))
}

// The camelCase keys that used to be written as web.listen.https.certDir must still resolve —
// they are stored lowercase now, and viper lowercases lookups, so both spellings work.
func TestInit_CamelCaseLookupsStillResolve(t *testing.T) {
	c := newTestConfig(t)

	require.Equal(t, "certs", c.GetString("web.listen.https.certDir"))
	require.Equal(t, "certs", c.GetString("web.listen.https.certdir"))
	require.Equal(t, "certs/shared", c.GetString("web.listen.https.sharedDir"))
}

// DRIFT GUARD. Every key the code reads must exist in the shipped defaults, or that read
// silently yields a zero value — the failure mode is a feature quietly doing nothing.
func TestDefaultConfig_CoversEveryKeyTheCodeReads(t *testing.T) {
	values, err := config.DefaultConfigValues()
	require.NoError(t, err)

	// Keys legitimately absent from the catalogue.
	exempt := map[string]bool{
		// Operator-supplied only; there is deliberately no default, and ValidateConfig keys off
		// IsSet, which a default would make permanently true.
		"database.encryption.key": true,
		// Set at runtime from a CLI flag, never from config.
		"variable": true,
	}

	root := repoRoot(t)
	seen := map[string][]string{}

	err = filepath.Walk(filepath.Join(root, "backend"), func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		fset := token.NewFileSet()
		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return parseErr
		}
		rel, _ := filepath.Rel(root, path)

		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !strings.HasPrefix(sel.Sel.Name, "Get") {
				return true
			}
			lit, ok := call.Args[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			key := strings.Trim(lit.Value, `"`)
			// Only dotted keys are config lookups; bare strings are map/header/query reads.
			if !strings.Contains(key, ".") {
				return true
			}
			seen[strings.ToLower(key)] = append(seen[strings.ToLower(key)],
				filepath.ToSlash(rel)+":"+itoa(fset.Position(call.Pos()).Line))
			return true
		})
		return nil
	})
	require.NoError(t, err)

	lowered := map[string]bool{}
	for key := range values {
		lowered[strings.ToLower(key)] = true
	}

	var missing []string
	for key, sites := range seen {
		if lowered[key] || exempt[key] {
			continue
		}
		// Config keys are the only dotted strings we care about; skip anything that never looked
		// like one (file extensions, MIME types, version strings picked up by the heuristic).
		if strings.ContainsAny(key, "/ :%") || strings.HasPrefix(key, ".") {
			continue
		}
		missing = append(missing, key+"  ("+strings.Join(sites, ", ")+")")
	}

	require.Emptyf(t, missing,
		"these keys are read in code but absent from app-default-config.json:\n  %s\n\n"+
			"An absent key reads as a zero value, so the feature silently does nothing. Add it to "+
			"the file, or to the exempt list here with a reason. See #456.",
		strings.Join(missing, "\n  "))
}

// Guards the catalogue against silent shrinkage: the file is the operator-facing inventory, so
// a key vanishing matters even when nothing reads it yet.
func TestDefaultConfig_KeyCountSanity(t *testing.T) {
	values, err := config.DefaultConfigValues()
	require.NoError(t, err)

	require.GreaterOrEqual(t, len(values), 50,
		"the shipped catalogue lost keys; if a setting was genuinely removed, lower this bound "+
			"deliberately in the same commit")

	raw := map[string]json.RawMessage{}
	require.NoError(t, json.Unmarshal(mustReadDefaults(t), &raw))
	require.NotEmpty(t, raw["_comment"], "the file must keep its header comment for operators")
}

func mustReadDefaults(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "backend", "pkg", "config", "app-default-config.json"))
	require.NoError(t, err)
	return b
}
