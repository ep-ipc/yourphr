package database

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/event_bus"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

// The counter columns are NULL on every row that predates the migration that added them: AutoMigrate
// emits `ALTER TABLE users ADD <col> integer` with no DEFAULT (#528). A user built through
// CreateUser gets an explicit 0 from the insert and can never reproduce that state, which is exactly
// why the original tests passed while both features were broken in the field. Every test here starts
// by forcing the columns back to NULL.
func newUserCountersRepo(t *testing.T) (*GormRepository, *models.User) {
	t.Helper()

	dbFile, err := os.CreateTemp("", fmt.Sprintf("%s.*.db", t.Name()))
	require.NoError(t, err)
	t.Cleanup(func() { os.Remove(dbFile.Name()) })

	testConfig, err := config.Create()
	require.NoError(t, err)
	testConfig.SetDefault("database.location", dbFile.Name())
	testConfig.SetDefault("database.encryption.enabled", false)
	testConfig.SetDefault("log.level", "INFO")

	repo, err := NewRepository(testConfig, logrus.WithField("test", t.Name()), event_bus.NewNoopEventBusServer())
	require.NoError(t, err)

	user := &models.User{Username: "test_username", Password: "testpassword", Email: "test@test.com"}
	require.NoError(t, repo.CreateUser(context.Background(), user))

	return repo.(*GormRepository), user
}

// nullTheCounters puts the row into the state a pre-migration account is actually in.
func nullTheCounters(t *testing.T, gr *GormRepository, username string) {
	t.Helper()
	require.NoError(t, gr.GormClient.Exec(
		"UPDATE users SET token_generation = NULL, login_count = NULL WHERE username = ?", username).Error)
}

func readCounters(t *testing.T, gr *GormRepository, username string) (tokenGeneration *int, loginCount *int) {
	t.Helper()
	require.NoError(t, gr.GormClient.Raw(
		"SELECT token_generation FROM users WHERE username = ?", username).Scan(&tokenGeneration).Error)
	require.NoError(t, gr.GormClient.Raw(
		"SELECT login_count FROM users WHERE username = ?", username).Scan(&loginCount).Error)
	return tokenGeneration, loginCount
}

// A NULL token_generation made session revocation inert: NULL + 1 is NULL, NULL reads back as 0, and
// an already-issued token also carries 0, so `claims < current` was false and the session survived.
// The bump has to reach 1 from NULL or every revocation path is a lie.
func TestBumpUserTokenGeneration_FromNull(t *testing.T) {
	gr, user := newUserCountersRepo(t)
	nullTheCounters(t, gr, user.Username)

	require.NoError(t, gr.BumpUserTokenGeneration(context.Background(), user.Username))

	tokenGeneration, _ := readCounters(t, gr, user.Username)
	require.NotNil(t, tokenGeneration, "token_generation is still NULL — every issued session survives the bump")
	require.Equal(t, 1, *tokenGeneration, "a token carrying generation 0 must now be rejected")
}

// The symptom that surfaced the bug: Admin → Users showed a real Last sign-in beside Sign-ins 0,
// and it stayed 0 no matter how many times the account signed in. last_login is a plain assignment
// so it wrote correctly; only the arithmetic column was lost.
func TestRecordSuccessfulLogin_FromNull(t *testing.T) {
	gr, user := newUserCountersRepo(t)
	nullTheCounters(t, gr, user.Username)

	require.NoError(t, gr.RecordSuccessfulLogin(context.Background(), user.Username))

	_, loginCount := readCounters(t, gr, user.Username)
	require.NotNil(t, loginCount, "login_count is still NULL — the sign-in was never counted")
	require.Equal(t, 1, *loginCount)

	require.NoError(t, gr.RecordSuccessfulLogin(context.Background(), user.Username))
	_, loginCount = readCounters(t, gr, user.Username)
	require.Equal(t, 2, *loginCount, "the counter must keep climbing once it has left NULL")
}

// Both writes report success — RowsAffected 1, no error — whether or not they actually wrote. That is
// what kept this invisible: nothing was ever logged, and neither caller could have detected it.
func TestCounterWritesFromNullAreNotSilentNoOps(t *testing.T) {
	gr, user := newUserCountersRepo(t)
	nullTheCounters(t, gr, user.Username)

	require.NoError(t, gr.BumpUserTokenGeneration(context.Background(), user.Username))
	require.NoError(t, gr.RecordSuccessfulLogin(context.Background(), user.Username))

	tokenGeneration, loginCount := readCounters(t, gr, user.Username)
	require.NotNil(t, tokenGeneration)
	require.NotNil(t, loginCount)
	require.Equal(t, 1, *tokenGeneration)
	require.Equal(t, 1, *loginCount)
}

// The migration itself, not just the COALESCE guard. Existing instances already recorded the two
// earlier migration IDs, so the correction had to arrive as its own entry; this deletes only the new
// ID's row and re-runs, which is as close to an upgrade of a live database as a test gets.
func TestMigrationBackfillsNullCounters(t *testing.T) {
	gr, user := newUserCountersRepo(t)
	nullTheCounters(t, gr, user.Username)

	tokenGeneration, loginCount := readCounters(t, gr, user.Username)
	require.Nil(t, tokenGeneration, "precondition: the row is in the pre-migration state")
	require.Nil(t, loginCount, "precondition: the row is in the pre-migration state")

	require.NoError(t, gr.GormClient.Exec("DELETE FROM migrations WHERE id = ?", "20260813090000").Error)
	require.NoError(t, gr.Migrate())

	tokenGeneration, loginCount = readCounters(t, gr, user.Username)
	require.NotNil(t, tokenGeneration)
	require.NotNil(t, loginCount)
	// 0, not 1: the backfill restores what both original migrations intended, so it must not log
	// anybody out on upgrade.
	require.Equal(t, 0, *tokenGeneration, "backfilling must not invalidate live sessions")
	require.Equal(t, 0, *loginCount)
}
