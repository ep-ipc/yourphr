package web

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	mock_config "github.com/fastenhealth/fasten-onprem/backend/pkg/config/mock"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/handler"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

// engineFor wires an AppEngine with mocks and a temp data dir, and returns the dir so a test can
// inspect the password file.
func engineFor(t *testing.T, configure func(*mock_config.MockInterface, *mock_database.MockDatabaseRepository)) (*AppEngine, string) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)

	dataDir := t.TempDir()
	cfg := mock_config.NewMockInterface(ctrl)
	db := mock_database.NewMockDatabaseRepository(ctrl)

	// config.DataDir reads these; every test wants the temp dir.
	cfg.EXPECT().GetString("storage.data_dir").Return(dataDir).AnyTimes()
	cfg.EXPECT().GetString("database.location").Return(filepath.Join(dataDir, "fasten.db")).AnyTimes()
	configure(cfg, db)

	return &AppEngine{Config: cfg, Logger: logrus.WithField("test", t.Name()), deviceRepo: db}, dataDir
}

func TestProvisionBootstrapAdmin(t *testing.T) {
	// A stock install must be untouched — this is the case that protects every existing user, so it
	// asserts the absence of BOTH database calls rather than just the outcome.
	t.Run("does nothing when disabled", func(t *testing.T) {
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(false)
			db.EXPECT().GetUserCount(gomock.Any()).Times(0)
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)
		})

		require.NoError(t, ae.ProvisionBootstrapAdmin())
		_, err := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.True(t, os.IsNotExist(err), "no password file on a stock install")
	})

	t.Run("creates an admin and writes the password 0600", func(t *testing.T) {
		var created *models.User
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("admindemo")
			db.EXPECT().GetUserCount(gomock.Any()).Return(0, nil)
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, u *models.User) error { created = u; return nil })
		})

		require.NoError(t, ae.ProvisionBootstrapAdmin())

		require.NotNil(t, created)
		require.Equal(t, "admindemo", created.Username)
		require.Equal(t, pkg.UserRoleAdmin, created.Role, "a provisioned account that is not admin would be pointless")

		path := filepath.Join(dataDir, BootstrapAdminPasswordFile)
		info, err := os.Stat(path)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "the file holds a live admin credential")

		raw, err := os.ReadFile(path)
		require.NoError(t, err)
		password := string(raw)
		require.NotEmpty(t, password)
		require.NotContains(t, password, "\n", "a trailing newline ends up inside the pasted password")

		// CreateUser hashes whatever it is handed (gorm_common.go:47), so this function must pass
		// the PLAINTEXT. An earlier version pre-hashed, which produced a hash of a hash and an
		// account nobody could sign into — and a test that called CheckPassword on the value this
		// function produced passed anyway, because it verified the wrong artifact. Assert what the
		// repository actually receives.
		require.Equal(t, password, created.Password,
			"CreateUser hashes what it is given; handing it a hash makes the account unusable")
	})

	t.Run("refuses a reserved username instead of failing in the database layer", func(t *testing.T) {
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("admin")
			db.EXPECT().GetUserCount(gomock.Any()).Times(0)
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)
		})

		err := ae.ProvisionBootstrapAdmin()
		require.Error(t, err, `"admin" is on the repository's reserved list, and it is the first thing an operator tries`)
		require.Contains(t, err.Error(), "reserved")
		require.Contains(t, err.Error(), "YOURPHR_BOOTSTRAP_ADMIN_USERNAME", "the error must name what to change")

		_, statErr := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.True(t, os.IsNotExist(statErr))
	})

	// Every restart re-runs provisioning, so this is the common path, and getting it wrong would
	// either reset an operator's password or create duplicate admins.
	t.Run("does nothing when users already exist", func(t *testing.T) {
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("admindemo")
			db.EXPECT().GetUserCount(gomock.Any()).Return(3, nil)
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)
		})

		require.NoError(t, ae.ProvisionBootstrapAdmin())
		_, err := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.True(t, os.IsNotExist(err), "an existing install must not get a new password file")
	})

	t.Run("warns rather than guessing when the username is empty", func(t *testing.T) {
		ae, _ := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("")
			db.EXPECT().GetUserCount(gomock.Any()).Times(0)
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)
		})
		require.NoError(t, ae.ProvisionBootstrapAdmin(), "a misconfiguration must not stop the instance starting")
	})

	// If the account is created but the password write failed, the instance has an admin nobody can
	// log in as AND userCount > 0 blocks the first-run wizard — unadministrable. So a failed create
	// must not leave the file behind either.
	t.Run("leaves no password file when account creation fails", func(t *testing.T) {
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("admindemo")
			db.EXPECT().GetUserCount(gomock.Any()).Return(0, nil)
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Return(errors.New("boom"))
		})

		require.Error(t, ae.ProvisionBootstrapAdmin())
		_, err := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.True(t, os.IsNotExist(err),
			"a password file for an account that does not exist sends the operator to a dead credential")
	})

	t.Run("generates a different password every time", func(t *testing.T) {
		seen := map[string]bool{}
		for i := 0; i < 20; i++ {
			p, err := generateBootstrapPassword()
			require.NoError(t, err)
			require.False(t, seen[p], "generated passwords must not repeat")
			require.GreaterOrEqual(t, len(p), 32)
			seen[p] = true
		}
	})
}

func TestClearBootstrapAdminPassword(t *testing.T) {
	ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {})
	path := filepath.Join(dataDir, BootstrapAdminPasswordFile)
	require.NoError(t, os.WriteFile(path, []byte("secret"), 0o600))

	require.NoError(t, ClearBootstrapAdminPassword(ae.Config))
	_, err := os.Stat(path)
	require.True(t, os.IsNotExist(err), "the file must be gone after the admin has signed in")

	// Every login after the first hits this, so a missing file is not an error.
	require.NoError(t, ClearBootstrapAdminPassword(ae.Config), "a second call must be a no-op")
}

// The signin handler cannot import pkg/web (that would be an import cycle), so it carries its own
// copy of the filename. If the two ever drift, the file silently survives first login and rides
// into every backup — exactly what #504 set out to avoid.
func TestBootstrapPasswordFileNamesAgree(t *testing.T) {
	require.Equal(t, BootstrapAdminPasswordFile, handler.BootstrapAdminPasswordFile,
		"pkg/web and pkg/web/handler must name the same file")
}

// The reserved-name check here duplicates the repository's own list so it can run before any
// database call. If the repository adds a name and this does not, provisioning fails at startup
// with a database error instead of the message that tells the operator what to change.
func TestReservedBootstrapUsernamesMatchRepository(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "database", "gorm_common.go"))
	require.NoError(t, err)

	block := regexp.MustCompile(`(?s)reservedUsernames\s*=\s*map\[string\]bool\{(.*?)\n\}`).FindSubmatch(source)
	require.Len(t, block, 2, "could not find reservedUsernames in gorm_common.go — did it move?")

	names := regexp.MustCompile(`"([a-z]+)"`).FindAllSubmatch(block[1], -1)
	require.NotEmpty(t, names)
	for _, m := range names {
		name := string(m[1])
		require.Truef(t, isReservedBootstrapUsername(name),
			"the repository reserves %q but bootstrap provisioning does not, so it would fail at CreateUser "+
				"with a database error instead of a message naming the variable to change", name)
	}
}
