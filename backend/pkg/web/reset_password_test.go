package web

import (
	"context"
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

// resetHarness wires mocks with the shipped password policy, and returns the data dir so a test can
// inspect the file the command writes.
func resetHarness(t *testing.T, configure func(*mock_config.MockInterface, *mock_database.MockDatabaseRepository)) (
	*mock_config.MockInterface, *mock_database.MockDatabaseRepository, *logrus.Entry, string,
) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)

	dataDir := t.TempDir()
	cfg := mock_config.NewMockInterface(ctrl)
	db := mock_database.NewMockDatabaseRepository(ctrl)

	cfg.EXPECT().GetString("storage.data_dir").Return(dataDir).AnyTimes()
	cfg.EXPECT().GetString("database.location").Return(filepath.Join(dataDir, "fasten.db")).AnyTimes()
	// The generated password must satisfy the instance's OWN policy (#506).
	cfg.EXPECT().GetInt("password.min_length").Return(8).AnyTimes()
	cfg.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
	cfg.EXPECT().GetBool("password.deny_common").Return(true).AnyTimes()
	cfg.EXPECT().GetBool("password.deny_username").Return(true).AnyTimes()
	cfg.EXPECT().GetInt("username.min_length").Return(3).AnyTimes()
	configure(cfg, db)

	return cfg, db, logrus.WithField("test", t.Name()), dataDir
}

func TestResetUserPassword(t *testing.T) {
	t.Run("sets a generated password, writes it 0600, and revokes sessions", func(t *testing.T) {
		var storedHash string
		var updatedFor string
		var bumped string
		cfg, db, logger, dataDir := resetHarness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			db.EXPECT().GetUserByUsername(gomock.Any(), "owner").Return(&models.User{Username: "owner"}, nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).DoAndReturn(
				func(ctx context.Context, hashed string) error {
					storedHash = hashed
					if u, ok := ctx.Value(pkg.ContextKeyTypeAuthUsername).(string); ok {
						updatedFor = u
					}
					return nil
				})
			// #508: a reset is usually a response to losing control of an account, so the sessions
			// that account already had must not survive it.
			db.EXPECT().BumpUserTokenGeneration(gomock.Any(), "owner").DoAndReturn(
				func(_ context.Context, username string) error { bumped = username; return nil })
		})

		path, err := ResetUserPassword(cfg, db, logger, "owner")
		require.NoError(t, err)
		require.Equal(t, filepath.Join(dataDir, BootstrapAdminPasswordFile), path)
		require.Equal(t, "owner", updatedFor, "the password must be set on the named account, not on whoever the context resolves to")
		require.Equal(t, "owner", bumped)

		info, err := os.Stat(path)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "the file holds a live credential")

		raw, err := os.ReadFile(path)
		require.NoError(t, err)
		password := string(raw)
		require.Len(t, password, 32)
		require.NotContains(t, password, "\n", "a stray newline in a password is a support ticket")

		// The repository stores a HASH. Handing it plaintext would store a password in the clear, and
		// handing CreateUser a hash stores a hash of a hash — the two take opposite things, which is
		// how #504 shipped broken the first time.
		require.NotEqual(t, password, storedHash)
		check := &models.User{Password: storedHash}
		require.NoError(t, check.CheckPassword(password), "the account must be signable-into with the written value")
	})

	// A typo must not produce a password file for an account that does not exist — that would send an
	// operator to a credential which cannot work, during the incident this command exists for.
	t.Run("refuses an unknown username and writes nothing", func(t *testing.T) {
		cfg, db, logger, dataDir := resetHarness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			db.EXPECT().GetUserByUsername(gomock.Any(), "nobody").Return(nil, nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Times(0)
			db.EXPECT().BumpUserTokenGeneration(gomock.Any(), gomock.Any()).Times(0)
		})

		_, err := ResetUserPassword(cfg, db, logger, "nobody")
		require.Error(t, err)
		require.Contains(t, err.Error(), "no user named")

		_, statErr := os.Stat(filepath.Join(dataDir, BootstrapAdminPasswordFile))
		require.True(t, os.IsNotExist(statErr))
	})

	t.Run("requires a username", func(t *testing.T) {
		cfg, db, logger, _ := resetHarness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			db.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(0)
		})

		_, err := ResetUserPassword(cfg, db, logger, "   ")
		require.Error(t, err)
	})

	// The reset must not fail because sessions could not be revoked: the password is already changed
	// by then, and reporting failure would send the operator round the loop again during an incident.
	t.Run("still succeeds when the session bump fails", func(t *testing.T) {
		cfg, db, logger, _ := resetHarness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			db.EXPECT().GetUserByUsername(gomock.Any(), "owner").Return(&models.User{Username: "owner"}, nil)
			db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
			db.EXPECT().BumpUserTokenGeneration(gomock.Any(), "owner").Return(os.ErrPermission)
		})

		_, err := ResetUserPassword(cfg, db, logger, "owner")
		require.NoError(t, err, "the password IS reset at that point; the warning belongs in the log")
	})
}

// The value must exist in exactly one place — the file. A log line carrying it would put it in every
// sink the instance ships to, which is the whole reason the command prints a path instead.
func TestResetUserPasswordNeverLogsTheValue(t *testing.T) {
	cfg, db, _, dataDir := resetHarness(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
		db.EXPECT().GetUserByUsername(gomock.Any(), "owner").Return(&models.User{Username: "owner"}, nil)
		db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
		db.EXPECT().BumpUserTokenGeneration(gomock.Any(), "owner").Return(nil)
	})

	captured := &resetCaptureHook{}
	log := logrus.New()
	log.AddHook(captured)
	log.SetLevel(logrus.DebugLevel)

	_, err := ResetUserPassword(cfg, db, logrus.NewEntry(log), "owner")
	require.NoError(t, err)

	raw, err := os.ReadFile(filepath.Join(dataDir, BootstrapAdminPasswordFile))
	require.NoError(t, err)
	for _, line := range captured.lines {
		require.NotContains(t, line, string(raw))
	}
}

type resetCaptureHook struct{ lines []string }

func (h *resetCaptureHook) Levels() []logrus.Level { return logrus.AllLevels }
func (h *resetCaptureHook) Fire(entry *logrus.Entry) error {
	h.lines = append(h.lines, entry.Message)
	return nil
}
