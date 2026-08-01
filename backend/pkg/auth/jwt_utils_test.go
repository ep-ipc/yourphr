package auth_test

import (
	"testing"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/golang-jwt/jwt/v4"
	"github.com/stretchr/testify/require"
)

const testKey = "thisismysupersecuressessionsecretlength"

func testUser() models.User {
	return models.User{
		FullName: "John Doe",
		Username: "john.doe@example.com",
		Email:    "john.doe@example.com",
		Role:     pkg.UserRoleUser,
	}
}

func TestJwtGenerateSessionToken_HasSessionStartAndExp(t *testing.T) {
	tok, err := auth.JwtGenerateSessionToken(testUser(), testKey, auth.DefaultSessionPolicy())
	require.NoError(t, err)
	claims, err := auth.JwtValidateFastenToken(testKey, tok)
	require.NoError(t, err)
	require.Equal(t, "john.doe@example.com", claims.Subject)
	require.NotNil(t, claims.SessionStart)
	require.NotNil(t, claims.ExpiresAt)
	require.InDelta(t, time.Hour.Seconds(), claims.ExpiresAt.Sub(time.Now()).Seconds(), 5)
}

func TestJwtMaybeRenewSession_RenewsWhenNearExpiry(t *testing.T) {
	user := testUser()
	policy := auth.SessionPolicy{
		TTL:              time.Hour,
		AbsoluteMax:      12 * time.Hour,
		RenewIfRemaining: 30 * time.Minute,
	}
	// Short-lived token so remaining < renew window
	tok, err := auth.JwtGenerateSessionToken(user, testKey, auth.SessionPolicy{
		TTL:              10 * time.Minute,
		AbsoluteMax:      12 * time.Hour,
		RenewIfRemaining: 30 * time.Minute,
	})
	require.NoError(t, err)
	claims, err := auth.JwtValidateFastenToken(testKey, tok)
	require.NoError(t, err)
	sessionStart := claims.SessionStart.Time

	newTok, renewed, err := auth.JwtMaybeRenewSession(claims, user, testKey, policy)
	require.NoError(t, err)
	require.True(t, renewed)
	require.NotEmpty(t, newTok)

	newClaims, err := auth.JwtValidateFastenToken(testKey, newTok)
	require.NoError(t, err)
	require.WithinDuration(t, sessionStart, newClaims.SessionStart.Time, time.Second)
	require.True(t, newClaims.ExpiresAt.After(claims.ExpiresAt.Time))
}

func TestJwtMaybeRenewSession_SkipsWhenPlentyOfLifeLeft(t *testing.T) {
	user := testUser()
	policy := auth.DefaultSessionPolicy()
	tok, err := auth.JwtGenerateSessionToken(user, testKey, policy)
	require.NoError(t, err)
	claims, err := auth.JwtValidateFastenToken(testKey, tok)
	require.NoError(t, err)

	_, renewed, err := auth.JwtMaybeRenewSession(claims, user, testKey, policy)
	require.NoError(t, err)
	require.False(t, renewed)
}

func TestJwtMaybeRenewSession_NoExtendPastAbsoluteMax(t *testing.T) {
	user := testUser()
	policy := auth.SessionPolicy{
		TTL:              time.Hour,
		AbsoluteMax:      2 * time.Hour,
		RenewIfRemaining: time.Hour,
	}
	tok, err := auth.JwtGenerateSessionToken(user, testKey, auth.SessionPolicy{
		TTL:              15 * time.Minute,
		AbsoluteMax:      20 * time.Minute,
		RenewIfRemaining: 30 * time.Minute,
	})
	require.NoError(t, err)
	claims, err := auth.JwtValidateFastenToken(testKey, tok)
	require.NoError(t, err)
	// Pretend session started long ago so absolute max is already exhausted
	claims.SessionStart = jwt.NewNumericDate(time.Now().Add(-3 * time.Hour))

	_, renewed, err := auth.JwtMaybeRenewSession(claims, user, testKey, policy)
	require.NoError(t, err)
	require.False(t, renewed)
}

func TestJwtGenerateFastenTokenFromUser_EmptyKey(t *testing.T) {
	_, err := auth.JwtGenerateFastenTokenFromUser(testUser(), "")
	require.Error(t, err)
}
