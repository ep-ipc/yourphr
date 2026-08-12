// Package _20260812120000 adds users.token_generation, the counter that makes session JWTs
// revocable (#508).
//
// A dated snapshot of the model rather than a reference to models.User, following the convention in
// this directory: a migration must keep describing the schema as it was when it ran, even after the
// live model moves on.
package _20260812120000

import (
	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
)

type User struct {
	models.ModelBase
	FullName string `json:"full_name"`
	Username string `json:"username" gorm:"unique"`
	Password string `json:"password"`

	Picture string       `json:"picture"`
	Email   string       `json:"email"`
	Role    pkg.UserRole `json:"role"`

	// Defaults to 0 for every existing row, and tokens issued before this release carry no such
	// claim — which also reads as 0. So the upgrade logs nobody out.
	TokenGeneration int `json:"-"`
}

func (User) TableName() string { return "users" }
