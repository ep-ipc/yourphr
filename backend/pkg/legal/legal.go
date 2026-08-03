// Package legal serves this instance's Privacy Policy and Terms of Service (#463).
//
// The documents come from the instance, not from yourphr.org. Three reasons, in increasing
// order of seriousness:
//
//  1. A self-hosted PHR on a home server should not need an external site reachable to show its
//     own privacy policy — least of all at the moment it asks a user to consent.
//  2. The OPERATOR is the data controller. The policy says so itself: the project holds no
//     records, the operator does. A controller who cannot state their own terms is a
//     contradiction, so an operator override is supported.
//  3. Consent must be provable. Recording "agreed to the document at this URL" proves nothing
//     once the document changes; recording a digest of the exact text does. That is also what
//     makes the operator override safe rather than a way to quietly rewrite what people agreed
//     to — see Digest.
package legal

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/russross/blackfriday/v2"
)

// Kind identifies one of the two documents.
type Kind string

const (
	KindPrivacyPolicy  Kind = "privacy"
	KindTermsOfService Kind = "terms"
)

// Source says where the served text came from, so the Admin screen and the consent record can
// tell an operator's own document from the shipped one.
type Source string

const (
	// SourceShipped — the text embedded in this release.
	SourceShipped Source = "shipped"
	// SourceOperator — a file this operator placed in the data directory.
	SourceOperator Source = "operator"
)

//go:embed privacy-policy.md
var shippedPrivacyPolicy []byte

//go:embed terms-of-service.md
var shippedTermsOfService []byte

// overrideFileNames maps each document to the file an operator may drop into <data>/config/.
var overrideFileNames = map[Kind]string{
	KindPrivacyPolicy:  "privacy-policy.md",
	KindTermsOfService: "terms-of-service.md",
}

// Document is one legal document as served.
type Document struct {
	Kind Kind `json:"kind"`
	// HTML is the rendered document, for display.
	HTML string `json:"html"`
	// Markdown is the source text — what Digest is computed over.
	Markdown string `json:"markdown,omitempty"`
	// Digest is "sha256:<hex>" of the Markdown. This is what a consent record stores: it pins
	// exactly what a user was shown, independent of any later edit.
	Digest string `json:"digest"`
	Source Source `json:"source"`
	// Path is the override file's location when Source is operator, so an admin can find it.
	Path string `json:"path,omitempty"`
}

// Kinds returns both documents' identifiers, for callers that iterate.
func Kinds() []Kind { return []Kind{KindPrivacyPolicy, KindTermsOfService} }

// ParseKind maps a URL segment to a Kind.
func ParseKind(value string) (Kind, error) {
	switch Kind(strings.ToLower(strings.TrimSpace(value))) {
	case KindPrivacyPolicy:
		return KindPrivacyPolicy, nil
	case KindTermsOfService:
		return KindTermsOfService, nil
	}
	return "", fmt.Errorf("unknown legal document %q", value)
}

// OverridePath is where an operator places their own version of a document.
func OverridePath(appConfig config.Interface, kind Kind) string {
	return filepath.Join(config.DataDir(appConfig), "config", overrideFileNames[kind])
}

// Load returns the effective document: the operator's own text when present, else the text
// shipped with this release.
//
// An unreadable or empty override is NOT silently ignored. Falling back to the shipped policy
// would show users a document their operator did not write and may have deliberately replaced —
// the exact failure the override exists to prevent.
func Load(appConfig config.Interface, kind Kind) (Document, error) {
	markdown, source, path, err := loadSource(appConfig, kind)
	if err != nil {
		return Document{}, err
	}

	return Document{
		Kind:     kind,
		HTML:     string(blackfriday.Run(markdown)),
		Markdown: string(markdown),
		Digest:   Digest(markdown),
		Source:   source,
		Path:     path,
	}, nil
}

func loadSource(appConfig config.Interface, kind Kind) ([]byte, Source, string, error) {
	path := OverridePath(appConfig, kind)

	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(strings.TrimSpace(string(raw))) == 0 {
			return nil, "", "", fmt.Errorf("legal override %s is empty; remove the file to use the shipped document", path)
		}
		return raw, SourceOperator, path, nil
	case os.IsNotExist(err):
		return shipped(kind), SourceShipped, "", nil
	default:
		return nil, "", "", fmt.Errorf("reading legal override %s: %w", path, err)
	}
}

func shipped(kind Kind) []byte {
	if kind == KindTermsOfService {
		return shippedTermsOfService
	}
	return shippedPrivacyPolicy
}

// Digest is "sha256:<hex>" over the document source.
//
// Computed on the MARKDOWN rather than the rendered HTML: rendering can change between releases
// when the renderer is upgraded, and a consent record must not appear to change because a
// library did. The words a user agreed to are the words in the source.
//
// Line endings are normalised so a CRLF copy of the same text does not read as a different
// document — an operator editing on Windows should not invalidate consent.
func Digest(markdown []byte) string {
	normalised := strings.ReplaceAll(string(markdown), "\r\n", "\n")
	sum := sha256.Sum256([]byte(normalised))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Digests returns the current digest of each document, for stamping onto a consent record.
func Digests(appConfig config.Interface) (map[Kind]string, error) {
	out := make(map[Kind]string, len(Kinds()))
	for _, kind := range Kinds() {
		doc, err := Load(appConfig, kind)
		if err != nil {
			return nil, err
		}
		out[kind] = doc.Digest
	}
	return out, nil
}
