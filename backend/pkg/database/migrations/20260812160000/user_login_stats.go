// Package _20260812160000 adds users.last_login and users.login_count (#512).
//
// A dated snapshot of the model rather than a reference to models.User, following the convention in
// this directory: a migration must keep describing the schema as it was when it ran.
package _20260812160000

import (
	"time"

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

	TokenGeneration int `json:"-"`

	// Existing rows migrate with NULL / 0, which the UI reads as "Never" — nobody's history is
	// invented, and no backfill is possible or wanted.
	LastLogin  *time.Time `json:"last_login,omitempty"`
	LoginCount int        `json:"login_count"`
}

func (User) TableName() string { return "users" }
