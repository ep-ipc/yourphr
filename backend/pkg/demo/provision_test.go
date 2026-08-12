package demo

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	mock_config "github.com/fastenhealth/fasten-onprem/backend/pkg/config/mock"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

// harness wires the mocks and a temp data root, and returns the root so a test can read back the
// custom config file that SetCustomValues writes.
func harness(t *testing.T, configure func(*mock_config.MockInterface, *mock_database.MockDatabaseRepository)) (
	*mock_config.MockInterface, *mock_database.MockDatabaseRepository, *logrus.Entry, string,
) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)

	dataDir := t.TempDir()
	cfg := mock_config.NewMockInterface(ctrl)
	db := mock_database.NewMockDatabaseRepository(ctrl)

	// config.DataDir reads these; CustomConfigPath is derived from the result.
	cfg.EXPECT().GetString("storage.data_dir").Return(dataDir).AnyTimes()
	cfg.EXPECT().GetString("database.location").Return(filepath.Join(dataDir, "fasten.db")).AnyTimes()
	configure(cfg, db)

	return cfg, db, logrus.WithField("test", t.Name()), dataDir
}

// userWithPassword returns a demo account whose stored password is the bcrypt hash of plain, the
// way the repository stores it.
func userWithPassword(t *testing.T, username, plain string) *models.User {
	t.Helper()
	user := &models.User{Username: username, Role: pkg.UserRoleUser}
	require.NoError(t, user.HashPassword(plain))
	return user
}

// customValues reads back what SetCustomValues persisted.
func customValues(t *testing.T, dataDir string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dataDir, "config", "app-custom-config.json"))
	require.NoError(t, err)
	var values map[string]interface{}
	require.NoError(t, json.Unmarshal(raw, &values))
	return values
}

func TestProvisionCredential(t *testing.T) {
	// The case that protects every ordinary install: not a single database call, so demo mode
	// cannot rewrite a password on an instance that never opted in.
	t.Run("does nothing when demo mode is off", func(t *testing.T) {
		cfg, db, logger, dataDir := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(false)
			db.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(0)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Times(0)
		})

		require.NoError(t, ProvisionCredential(context.Background(), cfg, db, logger))
		_, err := os.Stat(filepath.Join(dataDir, "config", "app-custom-config.json"))
		require.True(t, os.IsNotExist(err), "nothing written on a non-demo instance")
	})

	// Demo mode on before the demo account exists is an operator ordering mistake, not a reason to
	// fail a startup — this returns nil so the instance still comes up.
	t.Run("warns and does not error when the demo account is missing", func(t *testing.T) {
		cfg, db, logger, _ := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("demo")
			db.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(nil, errors.New("record not found"))
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Times(0)
		})

		require.NoError(t, ProvisionCredential(context.Background(), cfg, db, logger))
	})

	t.Run("does nothing when demo.username is empty", func(t *testing.T) {
		cfg, db, logger, _ := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("")
			db.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(0)
		})

		require.NoError(t, ProvisionCredential(context.Background(), cfg, db, logger))
	})

	// The normal path on every restart. Rotating here would invalidate a working demo for no
	// reason, so assert the absence of the write rather than just the outcome.
	t.Run("leaves a matching credential alone", func(t *testing.T) {
		cfg, db, logger, dataDir := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("demo")
			cfg.EXPECT().GetString("demo.password").Return("already-provisioned")
			db.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(userWithPassword(t, "demo", "already-provisioned"), nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Times(0)
		})

		require.NoError(t, ProvisionCredential(context.Background(), cfg, db, logger))
		_, err := os.Stat(filepath.Join(dataDir, "config", "app-custom-config.json"))
		require.True(t, os.IsNotExist(err), "an already-provisioned instance rewrites nothing")
	})

	// What a freshly restored seed (#505) looks like: the account carries the throwaway hash the
	// seed builder used, and demo.password is either empty or left over from the previous database.
	t.Run("generates a credential when none is configured", func(t *testing.T) {
		var stored string
		var updatedFor string
		cfg, db, logger, dataDir := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("demo")
			cfg.EXPECT().GetString("demo.password").Return("")
			db.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(userWithPassword(t, "demo", "seed-throwaway"), nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).DoAndReturn(
				func(ctx context.Context, hashed string) error {
					stored = hashed
					if username, ok := ctx.Value(pkg.ContextKeyTypeAuthUsername).(string); ok {
						updatedFor = username
					}
					return nil
				})
			// SetCustomValues applies the change to the running config as well as the file.
			cfg.EXPECT().Set("demo.password", gomock.Any()).Times(1)
		})

		require.NoError(t, ProvisionCredential(context.Background(), cfg, db, logger))

		// The account must be updated through the context, the same way a request resolves a user —
		// getting this wrong would silently rewrite whoever GetCurrentUser happened to find.
		require.Equal(t, "demo", updatedFor)

		values := customValues(t, dataDir)
		password, ok := values["demo.password"].(string)
		require.True(t, ok, "demo.password must be written to the custom config")
		require.Len(t, password, 32, "24 random bytes, base64url, no padding")

		// The stored value must be a HASH of the generated password, not the password itself and
		// not a hash of a hash — the mistake that shipped #504 broken the first time.
		require.NotEqual(t, password, stored)
		check := &models.User{Password: stored}
		require.NoError(t, check.CheckPassword(password))
	})

	// The drift case: a configured password that no longer matches the account. Left alone it means
	// demo-signin refuses every visitor, which is the failure #514 was about.
	t.Run("regenerates when the configured credential no longer matches", func(t *testing.T) {
		cfg, db, logger, dataDir := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("demo")
			cfg.EXPECT().GetString("demo.password").Return("from-the-previous-database")
			db.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(userWithPassword(t, "demo", "what-the-seed-baked"), nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
			cfg.EXPECT().Set("demo.password", gomock.Any()).Times(1)
		})

		require.NoError(t, ProvisionCredential(context.Background(), cfg, db, logger))

		values := customValues(t, dataDir)
		require.NotEqual(t, "from-the-previous-database", values["demo.password"])
	})

	// A failure to write the account must not leave the config claiming a password that was never
	// set: that combination reads as configured and refuses every visitor. Returning the error means
	// the next start tries again.
	t.Run("does not record a password it could not set", func(t *testing.T) {
		cfg, db, logger, dataDir := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("demo")
			cfg.EXPECT().GetString("demo.password").Return("")
			db.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(userWithPassword(t, "demo", "seed-throwaway"), nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(errors.New("database is locked"))
		})

		require.Error(t, ProvisionCredential(context.Background(), cfg, db, logger))
		_, err := os.Stat(filepath.Join(dataDir, "config", "app-custom-config.json"))
		require.True(t, os.IsNotExist(err))
	})
}

func TestProvisionAdmin(t *testing.T) {
	// An admin account a stranger can enter must take TWO flags. A single mis-set boolean creating
	// one is the failure mode worth pinning.
	t.Run("does nothing unless both flags are set", func(t *testing.T) {
		for _, flags := range []struct{ demo, admin bool }{{false, true}, {true, false}, {false, false}} {
			cfg, db, logger, _ := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
				cfg.EXPECT().GetBool("demo.enabled").Return(flags.demo).AnyTimes()
				cfg.EXPECT().GetBool("demo.admin.enabled").Return(flags.admin).AnyTimes()
				db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)
				db.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(0)
			})
			require.NoError(t, ProvisionAdmin(context.Background(), cfg, db, logger))
		}
	})

	t.Run("creates the demo admin with a generated password", func(t *testing.T) {
		var created *models.User
		cfg, db, logger, dataDir := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetBool("demo.admin.enabled").Return(true)
			cfg.EXPECT().GetString("demo.admin.username").Return("demoadmin")
			db.EXPECT().GetUserByUsername(gomock.Any(), "demoadmin").Return(nil, errors.New("record not found"))
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).DoAndReturn(func(ctx context.Context, user *models.User) error {
				created = user
				return nil
			})
			cfg.EXPECT().Set("demo.admin.password", gomock.Any()).Times(1)
		})

		require.NoError(t, ProvisionAdmin(context.Background(), cfg, db, logger))

		require.NotNil(t, created)
		require.Equal(t, pkg.UserRoleAdmin, created.Role, "the tour is of the ADMIN screens")

		values := customValues(t, dataDir)
		password, ok := values["demo.admin.password"].(string)
		require.True(t, ok)
		require.Len(t, password, 32)
		// CreateUser hashes what it is handed, so this must be the plaintext — pre-hashing here
		// would store a hash of a hash and lock the account nobody could then sign into.
		require.Equal(t, password, created.Password)
	})

	// What a restored seed looks like once the demo admin has been created on a previous database.
	t.Run("rotates when the configured password no longer matches", func(t *testing.T) {
		cfg, db, logger, dataDir := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetBool("demo.admin.enabled").Return(true)
			cfg.EXPECT().GetString("demo.admin.username").Return("demoadmin")
			cfg.EXPECT().GetString("demo.admin.password").Return("from-the-previous-database")
			db.EXPECT().GetUserByUsername(gomock.Any(), "demoadmin").Return(userWithPassword(t, "demoadmin", "something-else"), nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)
			cfg.EXPECT().Set("demo.admin.password", gomock.Any()).Times(1)
		})

		require.NoError(t, ProvisionAdmin(context.Background(), cfg, db, logger))
		require.NotEqual(t, "from-the-previous-database", customValues(t, dataDir)["demo.admin.password"])
	})

	t.Run("leaves a matching credential alone", func(t *testing.T) {
		cfg, db, logger, _ := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetBool("demo.admin.enabled").Return(true)
			cfg.EXPECT().GetString("demo.admin.username").Return("demoadmin")
			cfg.EXPECT().GetString("demo.admin.password").Return("already-provisioned")
			db.EXPECT().GetUserByUsername(gomock.Any(), "demoadmin").Return(userWithPassword(t, "demoadmin", "already-provisioned"), nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Times(0)
			db.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)
		})

		require.NoError(t, ProvisionAdmin(context.Background(), cfg, db, logger))
	})
}

// The whole promise of a generated credential is that it exists in one place. A log line carrying
// the value would put it in every log sink the instance ships to.
func TestProvisionCredentialNeverLogsTheValue(t *testing.T) {
	var written string
	cfg, db, _, _ := harness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
		cfg.EXPECT().GetBool("demo.enabled").Return(true)
		cfg.EXPECT().GetString("demo.username").Return("demo")
		cfg.EXPECT().GetString("demo.password").Return("")
		db.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(userWithPassword(t, "demo", "seed-throwaway"), nil)
		db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
		cfg.EXPECT().Set("demo.password", gomock.Any()).DoAndReturn(func(key string, value interface{}) {
			written = value.(string)
		})
	})

	captured := &captureHook{}
	log := logrus.New()
	log.AddHook(captured)
	log.SetLevel(logrus.DebugLevel)

	require.NoError(t, ProvisionCredential(context.Background(), cfg, db, logrus.NewEntry(log)))
	require.NotEmpty(t, written)
	for _, line := range captured.lines {
		require.NotContains(t, line, written)
	}
}

type captureHook struct{ lines []string }

func (h *captureHook) Levels() []logrus.Level { return logrus.AllLevels }
func (h *captureHook) Fire(entry *logrus.Entry) error {
	h.lines = append(h.lines, entry.Message)
	return nil
}
