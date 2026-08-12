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
	// Read when scanning for an existing admin: the read-only demo admin (#516) does not count as
	// one. Registered AFTER configure so a test that names a demo admin wins — gomock matches
	// expectations in declaration order, and a default declared first would swallow the override.
	cfg.EXPECT().GetString("demo.admin.username").Return("").AnyTimes()

	return &AppEngine{Config: cfg, Logger: logrus.WithField("test", t.Name()), deviceRepo: db}, dataDir
}

func TestProvisionBootstrapAdmin(t *testing.T) {
	// A stock install must be untouched — this is the case that protects every existing user, so it
	// asserts the absence of BOTH database calls rather than just the outcome.
	t.Run("does nothing when disabled", func(t *testing.T) {
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(false)
			db.EXPECT().GetUsers(gomock.Any()).Times(0)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).Times(0)
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
			db.EXPECT().GetUsers(gomock.Any()).Return(nil, nil)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).DoAndReturn(
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

	// "admin" is on the repository's deny-list and is the first thing every operator tries. Since
	// #519 that list guards self-service SIGNUP, where a stranger picks the name — not an account
	// provisioned from the operator's own configuration. So this must succeed, and it must go
	// through the provisioning entry point rather than the one that still refuses reserved names.
	t.Run("provisions a reserved username, because the operator configured it", func(t *testing.T) {
		var created *models.User
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("admin")
			db.EXPECT().GetUsers(gomock.Any()).Return(nil, nil)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).Times(0)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, u *models.User) error { created = u; return nil })
		})

		require.NoError(t, ae.ProvisionBootstrapAdmin())
		require.NotNil(t, created)
		require.Equal(t, "admin", created.Username)
		require.Equal(t, pkg.UserRoleAdmin, created.Role)

		_, statErr := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.NoError(t, statErr, "the generated password must still be written")
	})

	// Every restart re-runs provisioning, so this is the common path, and getting it wrong would
	// either reset an operator's password or create duplicate admins.
	t.Run("does nothing when an admin already exists", func(t *testing.T) {
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("admindemo")
			db.EXPECT().GetUsers(gomock.Any()).Return([]models.User{{Username: "someone", Role: pkg.UserRoleAdmin}}, nil)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).Times(0)
		})

		require.NoError(t, ae.ProvisionBootstrapAdmin())
		_, err := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.True(t, os.IsNotExist(err), "an existing install must not get a new password file")
	})

	// The read-only demo admin (#516) is a PUBLIC entrance that cannot change anything, so an
	// instance holding only that account still has no administrator. Counting it would suppress
	// provisioning and leave the operator with no way in at all — on a host whose whole point is
	// that strangers can sign in.
	t.Run("does not count the read-only demo admin as an admin", func(t *testing.T) {
		var created *models.User
		ae, _ := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("admindemo")
			db.EXPECT().GetUsers(gomock.Any()).Return([]models.User{
				{Username: "demo", Role: pkg.UserRoleUser},
				{Username: "demoadmin", Role: pkg.UserRoleAdmin},
			}, nil)
			cfg.EXPECT().GetString("demo.admin.username").Return("demoadmin").AnyTimes()
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).DoAndReturn(func(ctx context.Context, user *models.User) error {
				created = user
				return nil
			})
		})

		require.NoError(t, ae.ProvisionBootstrapAdmin())
		require.NotNil(t, created, "the operator's own admin must still be provisioned")
		require.Equal(t, "admindemo", created.Username)
	})

	t.Run("warns rather than guessing when the username is empty", func(t *testing.T) {
		ae, _ := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("")
			db.EXPECT().GetUsers(gomock.Any()).Times(0)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).Times(0)
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
			db.EXPECT().GetUsers(gomock.Any()).Return(nil, nil)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).Return(errors.New("boom"))
		})

		require.Error(t, ae.ProvisionBootstrapAdmin())
		_, err := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.True(t, os.IsNotExist(err),
			"a password file for an account that does not exist sends the operator to a dead credential")
	})

	// THE case that #505 depends on. A pre-seeded database contains the demo user, so the original
	// "no users" trigger would never fire and the instance would come up administrable by nobody,
	// with the first-run wizard suppressed because users exist. Provisioning must treat "users but no
	// admin" as the state it exists to fix.
	t.Run("provisions when users exist but none is an admin", func(t *testing.T) {
		var created *models.User
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("admindemo")
			db.EXPECT().GetUsers(gomock.Any()).Return([]models.User{{Username: "demo", Role: pkg.UserRoleUser}}, nil)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).DoAndReturn(
				func(_ context.Context, u *models.User) error { created = u; return nil })
		})

		require.NoError(t, ae.ProvisionBootstrapAdmin())
		require.NotNil(t, created, "a seeded instance with no admin must get one")
		require.Equal(t, pkg.UserRoleAdmin, created.Role)
		_, err := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.NoError(t, err, "and its password must be readable")
	})

	// Adopting an existing account by resetting its password would be a privilege-escalation path
	// dressed up as convenience: point the variable at a real user, restart, read their new password.
	t.Run("refuses to adopt an existing non-admin account with the same name", func(t *testing.T) {
		ae, dataDir := engineFor(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("bootstrap.admin.enabled").Return(true)
			cfg.EXPECT().GetString("bootstrap.admin.username").Return("demo")
			db.EXPECT().GetUsers(gomock.Any()).Return([]models.User{{Username: "demo", Role: pkg.UserRoleUser}}, nil)
			db.EXPECT().CreateProvisionedUser(gomock.Any(), gomock.Any()).Times(0)
		})

		err := ae.ProvisionBootstrapAdmin()
		require.Error(t, err)
		require.Contains(t, err.Error(), "already exists")
		_, statErr := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.True(t, os.IsNotExist(statErr), "no password file for an account we declined to touch")
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
			"the repository reserves %q but bootstrap provisioning does not, so provisioning it would not be logged "+
				"with a database error instead of a message naming the variable to change", name)
	}
}
