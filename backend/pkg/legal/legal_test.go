package legal_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/legal"
	"github.com/stretchr/testify/require"
)

func newConfig(t *testing.T) (config.Interface, string) {
	t.Helper()
	root := t.TempDir()
	c, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, c.Init())
	c.Set("storage.data_dir", root)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "config"), 0o755))
	return c, root
}

func writeOverride(t *testing.T, root string, name, body string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(root, "config", name), []byte(body), 0o644))
}

// The shipped documents must be usable with no operator action — an instance that has never
// been configured still has to show a policy.
func TestLoad_ServesTheShippedDocumentByDefault(t *testing.T) {
	c, _ := newConfig(t)

	for _, kind := range legal.Kinds() {
		doc, err := legal.Load(c, kind)
		require.NoError(t, err)
		require.Equal(t, legal.SourceShipped, doc.Source)
		require.NotEmpty(t, doc.HTML)
		require.Contains(t, doc.Digest, "sha256:")
		require.Empty(t, doc.Path, "there is no override file to point at")
	}
}

func TestLoad_RendersMarkdownToHTML(t *testing.T) {
	c, root := newConfig(t)
	writeOverride(t, root, "privacy-policy.md", "# Our Policy\n\nWe hold your records.\n")

	doc, err := legal.Load(c, legal.KindPrivacyPolicy)
	require.NoError(t, err)
	require.Contains(t, doc.HTML, "<h1>Our Policy</h1>")
	require.Contains(t, doc.HTML, "<p>We hold your records.</p>")
}

// The operator is the data controller, so their text wins.
func TestLoad_OperatorOverrideWins(t *testing.T) {
	c, root := newConfig(t)
	writeOverride(t, root, "privacy-policy.md", "# Clinic policy\n")

	doc, err := legal.Load(c, legal.KindPrivacyPolicy)
	require.NoError(t, err)
	require.Equal(t, legal.SourceOperator, doc.Source)
	require.Contains(t, doc.HTML, "Clinic policy")
	require.Contains(t, doc.Path, "privacy-policy.md", "an admin needs to know where the file is")

	// Overriding one document must not affect the other.
	terms, err := legal.Load(c, legal.KindTermsOfService)
	require.NoError(t, err)
	require.Equal(t, legal.SourceShipped, terms.Source)
}

// Falling back to the shipped policy would show users a document their operator deliberately
// replaced — precisely what the override exists to prevent. Fail loudly instead.
func TestLoad_EmptyOverrideIsAnError(t *testing.T) {
	c, root := newConfig(t)
	writeOverride(t, root, "privacy-policy.md", "   \n\n")

	_, err := legal.Load(c, legal.KindPrivacyPolicy)
	require.Error(t, err)
	require.Contains(t, err.Error(), "empty")
	require.Contains(t, err.Error(), "remove the file", "the message must say how to fix it")
}

func TestLoad_UnreadableOverrideIsAnError(t *testing.T) {
	c, root := newConfig(t)
	// A directory where a file is expected: readable path, unreadable content.
	require.NoError(t, os.MkdirAll(filepath.Join(root, "config", "privacy-policy.md"), 0o755))

	_, err := legal.Load(c, legal.KindPrivacyPolicy)
	require.Error(t, err)
}

// --- digest: what makes consent provable ------------------------------------------------------

func TestDigest_ChangesWithTheText(t *testing.T) {
	require.NotEqual(t, legal.Digest([]byte("one")), legal.Digest([]byte("two")))
	require.Equal(t, legal.Digest([]byte("same")), legal.Digest([]byte("same")))
	require.True(t, strings.HasPrefix(legal.Digest([]byte("x")), "sha256:"))
}

// An operator editing on Windows must not invalidate every existing consent record.
func TestDigest_IgnoresLineEndingStyle(t *testing.T) {
	require.Equal(t,
		legal.Digest([]byte("# Policy\nLine two\n")),
		legal.Digest([]byte("# Policy\r\nLine two\r\n")))
}

// Computed over the SOURCE, not the rendered HTML: upgrading the Markdown renderer must not make
// a stored consent record appear to refer to a different document.
func TestDigest_IsOverTheMarkdownNotTheHTML(t *testing.T) {
	c, root := newConfig(t)
	markdown := "# Policy\n\nBody.\n"
	writeOverride(t, root, "privacy-policy.md", markdown)

	doc, err := legal.Load(c, legal.KindPrivacyPolicy)
	require.NoError(t, err)
	require.Equal(t, legal.Digest([]byte(markdown)), doc.Digest)
	require.NotEqual(t, legal.Digest([]byte(doc.HTML)), doc.Digest)
}

// An operator changing their policy must produce a different digest — that is the whole point:
// a consent record pins the text, so a later edit is detectable rather than silent.
func TestDigest_MovesWhenTheOperatorEditsTheirPolicy(t *testing.T) {
	c, root := newConfig(t)
	writeOverride(t, root, "privacy-policy.md", "# Version one\n")
	first, err := legal.Load(c, legal.KindPrivacyPolicy)
	require.NoError(t, err)

	writeOverride(t, root, "privacy-policy.md", "# Version two\n")
	second, err := legal.Load(c, legal.KindPrivacyPolicy)
	require.NoError(t, err)

	require.NotEqual(t, first.Digest, second.Digest)
}

func TestDigests_CoversBothDocuments(t *testing.T) {
	c, _ := newConfig(t)

	digests, err := legal.Digests(c)
	require.NoError(t, err)
	require.Len(t, digests, 2)
	require.NotEmpty(t, digests[legal.KindPrivacyPolicy])
	require.NotEmpty(t, digests[legal.KindTermsOfService])
	require.NotEqual(t, digests[legal.KindPrivacyPolicy], digests[legal.KindTermsOfService])
}

func TestParseKind(t *testing.T) {
	for _, in := range []string{"privacy", "PRIVACY", " privacy "} {
		kind, err := legal.ParseKind(in)
		require.NoError(t, err)
		require.Equal(t, legal.KindPrivacyPolicy, kind)
	}
	_, err := legal.ParseKind("something-else")
	require.Error(t, err)
}

func TestOverridePath_LivesUnderTheDataRoot(t *testing.T) {
	c, root := newConfig(t)
	require.Equal(t,
		filepath.Join(root, "config", "privacy-policy.md"),
		legal.OverridePath(c, legal.KindPrivacyPolicy))
}
