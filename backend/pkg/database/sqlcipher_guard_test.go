package database

import (
	"errors"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// TestVerifySqlcipherActive_RejectsPlaintextConnection is the #401 regression guard.
//
// A connection opened WITHOUT the sqlcipher pragmas stands in for the failure this protects
// against: a build that linked the stock mattn/go-sqlite3 driver, where `_cipher=sqlcipher` is an
// unknown DSN parameter that is silently ignored. The database opens, the app runs, and PHI is
// written in plaintext with no error anywhere. verifySqlcipherActive must reject that.
func TestVerifySqlcipherActive_RejectsPlaintextConnection(t *testing.T) {
	f, err := os.CreateTemp("", "sqlcipher-guard-plain.*.db")
	require.NoError(t, err)
	defer os.Remove(f.Name())

	db, err := gorm.Open(sqlite.Open("file:"+f.Name()), &gorm.Config{})
	require.NoError(t, err)

	err = verifySqlcipherActive(db)

	require.Error(t, err, "an unencrypted connection must NOT pass the guard")
	require.ErrorIs(t, err, ErrSqlcipherNotActive)
	// The operator has no other clue why this happened — the remediation must name the real cause.
	require.Contains(t, err.Error(), "go-sqlite3")
	require.Contains(t, err.Error(), "replace")
}

// TestVerifySqlcipherActive_AcceptsEncryptedConnection confirms the guard is not simply always
// failing — with the SQLCipher fork linked and the pragmas applied, it must pass.
func TestVerifySqlcipherActive_AcceptsEncryptedConnection(t *testing.T) {
	f, err := os.CreateTemp("", "sqlcipher-guard-enc.*.db")
	require.NoError(t, err)
	defer os.Remove(f.Name())

	dsn := "file:" + f.Name() + sqlitePragmaString(map[string]string{
		"_cipher":           "sqlcipher",
		"_legacy":           "3",
		"_hmac_use":         "off",
		"_kdf_iter":         "4000",
		"_legacy_page_size": "1024",
		"_key":              "012345678901234567890",
	})
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)

	require.NoError(t, verifySqlcipherActive(db),
		"a SQLCipher connection must pass — if this fails, the build is NOT linking the SQLCipher fork")
}

// TestErrSqlcipherNotActiveIsIdentifiable pins that callers can branch on the sentinel rather than
// string-matching, so the fatal path stays distinguishable from ordinary connection errors.
func TestErrSqlcipherNotActiveIsIdentifiable(t *testing.T) {
	require.True(t, errors.Is(ErrSqlcipherNotActive, ErrSqlcipherNotActive))
	require.Contains(t, ErrSqlcipherNotActive.Error(), "NOT active")
}
