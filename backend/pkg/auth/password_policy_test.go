package auth_test

import (
	"strings"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	mock_config "github.com/fastenhealth/fasten-onprem/backend/pkg/config/mock"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// shippedPolicy is the policy as configured out of the box, so the tests exercise the values an
// instance actually runs with rather than a convenient fiction.
func shippedPolicy() auth.PasswordPolicy {
	return auth.PasswordPolicy{
		MinLength:         8,
		MaxLength:         69,
		DenyCommon:        true,
		DenyUsername:      true,
		UsernameMinLength: 3,
	}
}

func TestValidatePassword_Length(t *testing.T) {
	p := shippedPolicy()

	// The case that started this: seven characters was accepted by the API and then refused by our
	// own sign-in form (#505).
	err := p.ValidatePassword("someone", "demo123")
	require.Error(t, err)
	require.Contains(t, err.Error(), "at least 8", "the message must say what to do differently")

	require.NoError(t, p.ValidatePassword("someone", "12345678x"), "exactly at the minimum is allowed")
	require.NoError(t, p.ValidatePassword("someone", strings.Repeat("a", 69)))

	// bcrypt refuses over 72 bytes with ErrPasswordTooLong. The point of the check is that a person
	// pasting a long passphrase is told the limit rather than shown an internal error.
	err = p.ValidatePassword("someone", strings.Repeat("a", 70))
	require.Error(t, err)
	require.Contains(t, err.Error(), "69 bytes or fewer")
}

// Length is measured in BYTES because that is what bcrypt limits, and UTF-8 is variable width — so
// a passphrase well under any character count can still be refused by the library.
func TestValidatePassword_LengthIsBytesNotCharacters(t *testing.T) {
	p := shippedPolicy()

	// 20 emoji = 80 bytes. A character count would wave this through and bcrypt would then reject it.
	emoji := strings.Repeat("😀", 20)
	require.Equal(t, 80, len(emoji))
	require.Error(t, p.ValidatePassword("someone", emoji))

	// Two bytes each, so this is 8 characters but 16 bytes — comfortably valid, and proof the rule
	// is not accidentally counting runes somewhere.
	require.NoError(t, p.ValidatePassword("someone", "ééééééée"))
}

// An operator cannot configure past what bcrypt accepts; a misconfiguration must not surface as
// ErrPasswordTooLong from inside the hashing library.
func TestValidatePassword_ClampsToBcryptCeiling(t *testing.T) {
	p := shippedPolicy()
	p.MaxLength = 200

	err := p.ValidatePassword("someone", strings.Repeat("a", 100))
	require.Error(t, err)
	require.Contains(t, err.Error(), "72 bytes or fewer")
}

func TestValidatePassword_DenyUsername(t *testing.T) {
	p := shippedPolicy()

	err := p.ValidatePassword("demo", "demo12345")
	require.Error(t, err)
	require.Contains(t, err.Error(), "username")

	// Case-insensitive: capitalising it is not a different password to anyone attacking the account.
	require.Error(t, p.ValidatePassword("demo", "MyDEMOpassphrase"))

	// Note the fixture avoids anything the COMMON list would catch first — `demo` is itself a
	// commonly-tried password, so `demo12345` is refused by that rule whatever deny_username says.
	p.DenyUsername = false
	require.NoError(t, p.ValidatePassword("demo", "demo-battery-staple"), "operators can turn the rule off")
}

func TestValidatePassword_DenyCommon(t *testing.T) {
	p := shippedPolicy()

	for _, password := range []string{"password", "PASSWORD", "password1", "password123", "12345678", "iloveyou"} {
		err := p.ValidatePassword("someone", password)
		require.Errorf(t, err, "%q is among the first passwords any attacker tries", password)
	}

	require.NoError(t, p.ValidatePassword("someone", "correct-horse-battery"))

	p.DenyCommon = false
	require.NoError(t, p.ValidatePassword("someone", "password"), "operators can turn the rule off")
}

func TestValidateUsername(t *testing.T) {
	p := shippedPolicy()

	err := p.ValidateUsername("ab")
	require.Error(t, err)
	require.Contains(t, err.Error(), "at least 3")

	require.NoError(t, p.ValidateUsername("jim"))
	require.Error(t, p.ValidateUsername("   "), "whitespace is not a username")
}

// Nothing is hardcoded: the whole point is that an operator running a family instance behind a VPN
// and one running an internet-facing instance can differ.
func TestPasswordPolicyFromConfig(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	cfg := mock_config.NewMockInterface(ctrl)
	cfg.EXPECT().GetInt("password.min_length").Return(16)
	cfg.EXPECT().GetInt("password.max_length").Return(64)
	cfg.EXPECT().GetBool("password.deny_common").Return(false)
	cfg.EXPECT().GetBool("password.deny_username").Return(false)
	cfg.EXPECT().GetInt("username.min_length").Return(5)

	p := auth.PasswordPolicyFromConfig(cfg)

	require.Equal(t, 16, p.MinLength)
	require.Equal(t, 64, p.MaxLength)
	require.False(t, p.DenyCommon)
	require.False(t, p.DenyUsername)
	require.Equal(t, 5, p.UsernameMinLength)

	// And the values are actually used, not merely stored.
	require.Error(t, p.ValidatePassword("someone", "123456789012"), "12 characters is under this instance's 16")
	require.NoError(t, p.ValidatePassword("someone", "password12345678"), "deny_common is off here")
}

// A generated demo credential (#515) is 32 base64 characters and must satisfy the shipped policy —
// otherwise provisioning would produce a password the instance's own rules reject.
func TestShippedPolicyAcceptsAGeneratedCredential(t *testing.T) {
	require.NoError(t, shippedPolicy().ValidatePassword("demo", "kJ8mN2pQ7rS4tU6vW9xY1zA3bC5dE7fG"))
}
