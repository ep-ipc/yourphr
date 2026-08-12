package models

import (
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
)

type User struct {
	ModelBase
	FullName string `json:"full_name"`
	Username string `json:"username" gorm:"unique"`
	Password string `json:"password"`

	//additional optional metadata that Fasten stores with users
	Picture string       `json:"picture"`
	Email   string       `json:"email"`
	Role    pkg.UserRole `json:"role"`

	// TokenGeneration makes session JWTs revocable (#508). Session tokens are stateless, so before
	// this a stolen one stayed valid until it expired — changing your password evicted nobody, which
	// made the one action a user takes after a compromise into false comfort.
	//
	// Every session token carries the value current when it was issued; RequireAuth refuses a token
	// whose generation is BELOW the user's. Bumping it therefore ends every existing session at once,
	// which is what a password change, an admin reset, a CLI reset, and "sign out everywhere" all
	// need to mean.
	//
	// Zero by default and absent from older tokens, which read as 0 — so deploying this logs nobody
	// out. Sessions only die once something deliberately bumps the value.
	//
	// Not serialized to JSON: it is internal bookkeeping, and no client has a use for it.
	TokenGeneration int `json:"-"`
}

func (user *User) HashPassword(password string) error {
	if len(strings.TrimSpace(password)) == 0 {
		return fmt.Errorf("password cannot be empty")
	}
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), 14)
	if err != nil {
		return err
	}
	user.Password = string(bytes)
	return nil
}
func (user *User) CheckPassword(providedPassword string) error {
	err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(providedPassword))
	if err != nil {
		return err
	}
	return nil
}
