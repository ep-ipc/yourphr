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
}
