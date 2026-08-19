package database

import (
	"context"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/stretchr/testify/require"
)

// ctxForUser builds the context RequireAuth produces: the username under the auth key.
func ctxForUser(username string) context.Context {
	return context.WithValue(context.Background(), pkg.ContextKeyTypeAuthUsername, username)
}

func createAccessTestUser(t *testing.T, repo DatabaseRepository, username string) {
	t.Helper()
	require.NoError(t, repo.CreateUser(context.Background(), &models.User{
		Username: username,
		Password: "testpassword-long-enough",
		FullName: "Access Test " + username,
	}))
}

// The core property: repeated access on the same day increments ONE bucket rather than growing a
// row per request, and the bucket carries first/last timestamps.
func TestRecordAccessEvent_AggregatesPerDay(t *testing.T) {
	repo, cleanup := newTestRepo(t)
	defer cleanup()
	createAccessTestUser(t, repo, "accessuser")
	ctx := ctxForUser("accessuser")

	require.NoError(t, repo.RecordAccessEvent(ctx, "Conditions"))
	require.NoError(t, repo.RecordAccessEvent(ctx, "Conditions"))
	require.NoError(t, repo.RecordAccessEvent(ctx, "Documents"))

	events, err := repo.ListAccessEvents(ctx)
	require.NoError(t, err)
	require.Len(t, events, 2, "same-day same-category accesses must aggregate")

	byCategory := map[string]models.AccessEvent{}
	for _, e := range events {
		byCategory[e.Category] = e
	}
	require.EqualValues(t, 2, byCategory["Conditions"].Count)
	require.EqualValues(t, 1, byCategory["Documents"].Count)
	require.Equal(t, "accessuser", byCategory["Conditions"].ActorUsername)
	require.False(t, byCategory["Conditions"].FirstAt.IsZero())
	require.False(t, byCategory["Conditions"].LastAt.Before(byCategory["Conditions"].FirstAt))
}

// One user's access log must never show another user's accesses — the log is per record owner.
func TestListAccessEvents_IsolatedPerUser(t *testing.T) {
	repo, cleanup := newTestRepo(t)
	defer cleanup()
	createAccessTestUser(t, repo, "owner-a")
	createAccessTestUser(t, repo, "owner-b")

	require.NoError(t, repo.RecordAccessEvent(ctxForUser("owner-a"), "Medications"))

	eventsB, err := repo.ListAccessEvents(ctxForUser("owner-b"))
	require.NoError(t, err)
	require.Empty(t, eventsB, "owner-b must not see owner-a's access log")

	eventsA, err := repo.ListAccessEvents(ctxForUser("owner-a"))
	require.NoError(t, err)
	require.Len(t, eventsA, 1)
}

// An empty category is a programming error at the call site, refused rather than stored as a blank
// row the patient cannot interpret.
func TestRecordAccessEvent_RefusesEmptyCategory(t *testing.T) {
	repo, cleanup := newTestRepo(t)
	defer cleanup()
	createAccessTestUser(t, repo, "accessuser")

	require.Error(t, repo.RecordAccessEvent(ctxForUser("accessuser"), ""))
}
