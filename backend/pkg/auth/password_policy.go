package auth

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
)

// PasswordPolicy is the rule set a NEW or CHANGED password must satisfy (#506).
//
// WHY IT EXISTS. Before this, the only server-side check was "not blank"
// (models.User.HashPassword), so a one-character password was accepted through the API while three
// different browser forms enforced three different rules that also disagreed with their own error
// messages. A policy that lives only in the browser is a policy the rest of the system can violate —
// which is not hypothetical here: the demo seed was built with a seven-character password that the
// signup API accepted and our own sign-in form then refused (#505).
//
// WHERE IT IS ENFORCED. Signup, admin user-create, and change-password. Deliberately NOT sign-in:
// an account created before a policy existed, or before an operator raised the minimum, must still
// be able to sign in. Validating a password someone already has locks them out of their own records
// to enforce a rule they cannot act on until they are inside.
//
// WHAT IT DELIBERATELY OMITS. Composition rules — one uppercase, one digit, one symbol. NIST
// SP 800-63B recommends against them: they push people toward `Password1!` and into reuse while
// adding little entropy. Length plus a breached-password check is the current guidance.
//
// EVERY VALUE IS CONFIGURATION. Nothing here is hardcoded: an operator running a family instance
// behind a VPN and one running an internet-facing instance have genuinely different needs.
//
// When the authentication provider framework lands (docs/planning/authentication-framework.md),
// this is what the password provider owns. It is written to move without changing.
type PasswordPolicy struct {
	MinLength    int
	MaxLength    int
	DenyCommon   bool
	DenyUsername bool

	UsernameMinLength int
}

// PasswordPolicyFromConfig reads the policy. Same shape as SessionPolicyFromConfig, and for the
// same reason: one place converts configuration into a value the rest of the code can reason about.
func PasswordPolicyFromConfig(cfg config.Interface) PasswordPolicy {
	return PasswordPolicy{
		MinLength:         cfg.GetInt("password.min_length"),
		MaxLength:         cfg.GetInt("password.max_length"),
		DenyCommon:        cfg.GetBool("password.deny_common"),
		DenyUsername:      cfg.GetBool("password.deny_username"),
		UsernameMinLength: cfg.GetInt("username.min_length"),
	}
}

// bcryptMaxBytes is bcrypt's hard ceiling. Anything longer is refused by the library itself with
// ErrPasswordTooLong, which reaches a user pasting a long passphrase out of a password manager as a
// raw internal error. It is a property of the algorithm, not a preference, so it is a constant here
// and configuration is clamped to it rather than allowed past it.
const bcryptMaxBytes = 72

// ValidatePassword returns nil when the password satisfies the policy, or an error naming the rule
// it broke. The message is shown to the person typing, so it says what to do differently — "at
// least 8 characters", never "invalid password".
//
// LENGTH IS MEASURED IN BYTES, not characters, because bcrypt's limit is a byte limit and UTF-8 is
// variable width: an emoji is four bytes, so a 20-"character" passphrase can be 80 bytes and fail
// inside the library after passing a character count.
func (p PasswordPolicy) ValidatePassword(username, password string) error {
	if strings.TrimSpace(password) == "" {
		return fmt.Errorf("password cannot be empty")
	}

	length := len(password)

	if p.MinLength > 0 && length < p.MinLength {
		return fmt.Errorf("password must be at least %d characters long", p.MinLength)
	}

	max := p.MaxLength
	if max <= 0 || max > bcryptMaxBytes {
		// An operator cannot configure past what bcrypt accepts. Silently clamping beats letting a
		// misconfiguration surface as ErrPasswordTooLong from inside the hashing library.
		max = bcryptMaxBytes
	}
	if length > max {
		return fmt.Errorf("password must be %d bytes or fewer (note that accented and emoji characters take more than one byte each)", max)
	}

	if p.DenyUsername && username != "" && strings.Contains(strings.ToLower(password), strings.ToLower(username)) {
		return fmt.Errorf("password must not contain your username")
	}

	if p.DenyCommon && isCommonPassword(password) {
		return fmt.Errorf("that password is one of the most commonly used passwords, so it is among the first an attacker tries — please choose another")
	}

	return nil
}

// ValidateUsername checks the one rule the server has an opinion about. The reserved-name deny-list
// is separate and lives in the repository (#519), because it applies to self-service registration
// rather than to every account.
func (p PasswordPolicy) ValidateUsername(username string) error {
	trimmed := strings.TrimSpace(username)
	if trimmed == "" {
		return fmt.Errorf("username cannot be empty")
	}
	if p.UsernameMinLength > 0 && len(trimmed) < p.UsernameMinLength {
		return fmt.Errorf("username must be at least %d characters long", p.UsernameMinLength)
	}
	return nil
}

// compliantAttempts bounds the retry loop below: a generated password can fail the instance's own
// policy — most plausibly because a short username happens to appear inside random base64 — and a
// handful of attempts makes that vanishingly unlikely without risking an unbounded loop if an
// operator has configured a policy nothing random can satisfy.
const compliantAttempts = 8

// GenerateCompliantPassword returns a random password that satisfies this instance's policy (#506).
//
// Shared by the CLI reset (#510) and the admin reset (#511) so neither can hand out a credential the
// change-password screen would then refuse — the same class of mistake as the demo seed built with a
// password our own sign-in form rejected (#505).
func GenerateCompliantPassword(cfg config.Interface, username string) (string, error) {
	policy := PasswordPolicyFromConfig(cfg)
	for attempt := 0; attempt < compliantAttempts; attempt++ {
		candidate, err := generateRandomPassword()
		if err != nil {
			return "", fmt.Errorf("could not generate a password: %w", err)
		}
		if policy.ValidatePassword(username, candidate) == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not generate a password satisfying this instance's password policy after %d attempts — check password.min_length and password.max_length", compliantAttempts)
}

// generateRandomPassword returns a URL-safe random string. 24 bytes is 192 bits, base64 to 32
// printable characters: short enough to read down a phone, long enough that bcrypt's cost is the
// least of an attacker's problems. crypto/rand, not math/rand — this is a credential.
func generateRandomPassword() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
