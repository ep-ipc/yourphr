package handler

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// A SourceCredential carries ClientSecret, AccessToken and RefreshToken as plain strings. Passing
// the whole struct to a format verb prints all three in cleartext — and %v ignores the `json:"-"`
// tag that keeps ClientSecret out of API responses, so the tag is no protection here.
//
// This is not hypothetical twice over. source.go logged the entire posted credential at Info
// ("Parsed Create SourceCredential Credentials Payload: %v"), and the first-run wizard logged the
// database encryption key, both into a log the Admin Dashboard serves over HTTP.
//
// Log identifiers instead: sourceCred.ID, sourceCred.EndpointID, sourceCred.SourceType.
//
// See yourphr#476. The durable fix is config.Secret on those fields, which makes the leak
// impossible rather than merely tested for; until then this catches the reflex.
var credentialStructLogPattern = regexp.MustCompile(
	`(?i)(logger|log)\.[A-Za-z]+\([^)]*%[+#]?v[^)]*,\s*(\*)?(sourceCred|sourceCredential|cred)\s*[,)]`)

func TestNoLogCallPrintsAWholeSourceCredential(t *testing.T) {
	root := filepath.Join(repoRootForHandlerTests(t), "backend", "pkg")

	var violations []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		for i, line := range strings.Split(string(body), "\n") {
			if credentialStructLogPattern.MatchString(line) {
				violations = append(violations,
					filepath.Base(path)+":"+itoaLocal(i+1)+": "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	require.NoError(t, err)

	require.Emptyf(t, violations,
		"these log calls print a whole credential struct, leaking ClientSecret / AccessToken / "+
			"RefreshToken in cleartext:\n  %s\n\nLog an identifier instead (.ID, .EndpointID). See yourphr#476.",
		strings.Join(violations, "\n  "))
}

func repoRootForHandlerTests(t *testing.T) string {
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

func itoaLocal(i int) string {
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
