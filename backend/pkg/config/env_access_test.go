package config_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// envAccessAllowlist names the packages permitted to read the process environment directly.
// Everything else must go through config.Interface, so that layering (defaults < custom config
// < env), validation and provenance happen in exactly one place — the discipline carried over
// from jwilleke/ngdpbase's ConfigurationManager. See #455.
//
// Paths are relative to the repo root, matched as prefixes.
var envAccessAllowlist = []string{
	// The config package IS the accessor. Binding env vars is its job.
	"backend/pkg/config",
	// Standalone relay binary: a separate process with three env vars and no config file, so it
	// deliberately opts out of the config stack rather than importing it for nothing.
	"backend/cmd/relay",
}

// forbiddenEnvCalls are the direct process-environment reads this guard rejects.
var forbiddenEnvCalls = map[string]bool{
	"Getenv":    true,
	"LookupEnv": true,
	"Environ":   true,
}

// TestNoDirectEnvironmentReads fails when a new os.Getenv / os.LookupEnv / os.Environ appears
// outside the allowlist.
//
// This exists because the sweep in #455 is worthless without it: the next direct read would
// otherwise arrive with the next feature, and reviewers do not reliably catch a single added
// line. A failure here is not necessarily a bug — it is a question: should this value be a
// config key instead? Usually yes. If genuinely not, extend envAccessAllowlist with a comment
// saying why.
//
// LIMIT: this matches CALL expressions (os.Getenv("X")). Passing os.Getenv as a function value
// is not flagged — backend/pkg/web/server.go does exactly that, deliberately, to give the
// provider seeders an injectable seam for tests. Someone determined to route around the guard
// could assign it to a variable first; the guard is a ratchet against drift, not a sandbox.
func TestNoDirectEnvironmentReads(t *testing.T) {
	root := repoRoot(t)

	var violations []string
	err := filepath.Walk(filepath.Join(root, "backend"), func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		// Tests may set up their own environment; the rule is about production code paths.
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}

		rel, relErr := filepath.Rel(root, path)
		require.NoError(t, relErr)
		rel = filepath.ToSlash(rel)
		for _, allowed := range envAccessAllowlist {
			if strings.HasPrefix(rel, allowed) {
				return nil
			}
		}

		fset := token.NewFileSet()
		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return parseErr
		}

		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "os" || !forbiddenEnvCalls[sel.Sel.Name] {
				return true
			}
			violations = append(violations,
				rel+":"+itoa(fset.Position(call.Pos()).Line)+" os."+sel.Sel.Name)
			return true
		})
		return nil
	})
	require.NoError(t, err)

	require.Emptyf(t, violations,
		"direct environment reads outside the allowlist:\n  %s\n\n"+
			"Route the value through config.Interface (add a SetDefault, and a BindEnv if the var is "+
			"not YOURPHR_-prefixed), or extend envAccessAllowlist in this file with a comment "+
			"explaining why this package legitimately opts out. See #455.",
		strings.Join(violations, "\n  "))
}

// repoRoot walks up from the test's working directory to the module root.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	require.NoError(t, err)
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "go.mod")); statErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		require.NotEqual(t, dir, parent, "could not find go.mod above %s", dir)
		dir = parent
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}
