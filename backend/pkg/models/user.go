package models

import (
	"fmt"
	"strings"
	"time"

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

	// LastLogin and LoginCount record USE, so an admin can tell a live account from an abandoned one
	// and a patient can answer "has anyone else been in my record?" — a question people genuinely ask
	// about medical data (#512).
	//
	// DELIBERATELY NO IP ADDRESS AND NO USER-AGENT. That is what held up the full sign-in audit on
	// #507: logging the family's own addresses, on a product whose pitch is that nobody else holds
	// your data, needs a retention policy and a deliberate privacy decision. A timestamp and a
	// counter need neither and answer the question that matters.
	//
	// Successful sign-ins only. A failure counter on the user row invites the account-lockout design
	// already rejected on #507 — brute force is handled by throttling instead (#509).
	//
	// A pointer, so "never signed in" is nil rather than the zero time pretending to be 1 January
	// year 1; the UI renders that as "Never".
	LastLogin  *time.Time `json:"last_login,omitempty"`
	LoginCount int        `json:"login_count"`
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
