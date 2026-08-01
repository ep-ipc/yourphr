package auth

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/golang-jwt/jwt/v4"
)

// generateToken is a helper to generate JWT tokens with flexible claims
func generateToken(user models.User, issuerSigningKey string, expiresAt time.Time, tokenID, tokenType string, sessionStart *time.Time) (string, error) {
	if len(strings.TrimSpace(issuerSigningKey)) == 0 {
		return "", fmt.Errorf("issuer signing key cannot be empty")
	}
	now := time.Now()
	claims := UserRegisteredClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "docker-fastenhealth",
			Subject:   user.Username,
			ID:        tokenID,
		},
		UserMetadata: UserMetadata{
			FullName: user.FullName,
			Email:    user.Email,
			Role:     user.Role,
		},
		TokenType: tokenType,
	}
	if sessionStart != nil {
		claims.SessionStart = jwt.NewNumericDate(*sessionStart)
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(issuerSigningKey))
}

// JwtGenerateFastenTokenFromUser generates a browser session JWT using DefaultSessionPolicy (#445).
func JwtGenerateFastenTokenFromUser(user models.User, issuerSigningKey string) (string, error) {
	return JwtGenerateSessionToken(user, issuerSigningKey, DefaultSessionPolicy())
}

// JwtGenerateSessionToken issues a new session JWT with session_start=now and exp=now+policy.TTL
// (capped by AbsoluteMax, which for a fresh session is just TTL).
func JwtGenerateSessionToken(user models.User, issuerSigningKey string, policy SessionPolicy) (string, error) {
	if policy.TTL <= 0 {
		policy = DefaultSessionPolicy()
	}
	now := time.Now()
	exp := now.Add(policy.TTL)
	if policy.AbsoluteMax > 0 {
		absEnd := now.Add(policy.AbsoluteMax)
		if exp.After(absEnd) {
			exp = absEnd
		}
	}
	return generateToken(user, issuerSigningKey, exp, "", "", &now)
}

// JwtMaybeRenewSession returns a new session JWT when the current one is valid and within the
// renew window, without exceeding AbsoluteMax from session_start. renewed=false leaves the token unchanged.
// Access tokens (token_type=access) are never renewed here.
func JwtMaybeRenewSession(claims *UserRegisteredClaims, user models.User, issuerSigningKey string, policy SessionPolicy) (newToken string, renewed bool, err error) {
	if claims == nil {
		return "", false, errors.New("claims required")
	}
	if claims.TokenType == "access" {
		return "", false, nil
	}
	if policy.TTL <= 0 {
		policy = DefaultSessionPolicy()
	}

	now := time.Now()
	if claims.ExpiresAt == nil || claims.ExpiresAt.Before(now) {
		return "", false, errors.New("token expired")
	}

	// Only renew when nearing expiry (activity near end of life).
	remaining := claims.ExpiresAt.Sub(now)
	if remaining > policy.RenewIfRemaining {
		return "", false, nil
	}

	sessionStart := now
	if claims.SessionStart != nil {
		sessionStart = claims.SessionStart.Time
	} else if claims.IssuedAt != nil {
		// Legacy tokens without session_start: use original iat as session start.
		sessionStart = claims.IssuedAt.Time
	}

	absEnd := sessionStart.Add(policy.AbsoluteMax)
	if !now.Before(absEnd) {
		// Absolute max already reached — allow current token until exp, but do not extend.
		return "", false, nil
	}

	exp := now.Add(policy.TTL)
	if exp.After(absEnd) {
		exp = absEnd
	}
	// If absEnd is so close that exp would not move meaningfully past current exp, skip.
	if !exp.After(claims.ExpiresAt.Time) {
		return "", false, nil
	}

	tok, err := generateToken(user, issuerSigningKey, exp, "", "", &sessionStart)
	if err != nil {
		return "", false, err
	}
	return tok, true, nil
}

func JwtValidateFastenToken(encryptionKey string, signedToken string) (*UserRegisteredClaims, error) {
	token, err := jwt.ParseWithClaims(
		signedToken,
		&UserRegisteredClaims{},
		func(token *jwt.Token) (interface{}, error) {
			if jwt.SigningMethodHS256 != token.Method {
				return nil, fmt.Errorf("invalid signing algorithm: %s", token.Method)
			}
			return []byte(encryptionKey), nil
		},
	)
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*UserRegisteredClaims)
	if !ok {
		err = errors.New("couldn't parse claims")
		return nil, err
	}
	if claims.ExpiresAt == nil || claims.ExpiresAt.Unix() < time.Now().Unix() {
		err = errors.New("token expired")
		return nil, err
	}
	return claims, nil
}

// JwtGenerateAccessToken generates an access token with custom expiration and metadata
func JwtGenerateAccessToken(user models.User, issuerSigningKey string, expiresAt time.Time, tokenID string) (string, error) {
	return generateToken(user, issuerSigningKey, expiresAt, tokenID, "access", nil)
}
