package auth

import "github.com/golang-jwt/jwt/v4"

type UserRegisteredClaims struct {
	UserMetadata
	jwt.RegisteredClaims

	// Optional fields for access tokens
	TokenID   string `json:"token_id,omitempty"`
	TokenType string `json:"token_type,omitempty"`

	// SessionStart is the first login time for browser sessions (#445). Preserved across sliding
	// renewals so AbsoluteMax can be enforced. Omitted on legacy tokens → treat IssuedAt as start.
	SessionStart *jwt.NumericDate `json:"session_start,omitempty"`

	// TokenGeneration is the user's revocation counter at the moment this token was issued (#508).
	// RequireAuth refuses a token whose value is BELOW the user's current one, so bumping the user
	// ends every session issued before the bump.
	//
	// `omitempty` and the zero value do the upgrade work: a token minted before this release has no
	// such claim, decodes as 0, and matches a user whose counter is still 0 — so nobody is signed out
	// by deploying it.
	TokenGeneration int `json:"token_generation,omitempty"`
}
