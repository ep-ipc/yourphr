package database

import (
	"context"
	"fmt"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// healthTestUser creates a user and returns a context authenticated as them.
func (suite *RepositoryTestSuite) healthTestUser(dbRepo DatabaseRepository, username string) (*models.User, context.Context) {
	userModel := &models.User{
		Username: username,
		Password: "testpassword",
		Email:    username + "@test.com",
	}
	require.NoError(suite.T(), dbRepo.CreateUser(context.Background(), userModel))
	return userModel, context.WithValue(context.Background(), pkg.ContextKeyTypeAuthUsername, username)
}

// healthSampleFixture builds a valid heart rate sample at the given offset from a fixed base time.
func healthSampleFixture(externalUUID string, minutesFromBase int) models.HealthSample {
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	at := base.Add(time.Duration(minutesFromBase) * time.Minute)
	value := 60.0 + float64(minutesFromBase)
	return models.HealthSample{
		ExternalUUID: externalUUID,
		HKType:       "HKQuantityTypeIdentifierHeartRate",
		MetricType:   "heart_rate",
		StartTime:    at,
		EndTime:      at,
		ValueNum:     &value,
		Unit:         "count/min",
		SourceName:   "Apple Watch",
	}
}

// The repository owns row ownership: whatever user_id a caller puts in the struct is discarded in
// favor of the authenticated user, so a compromised or buggy client cannot write into another
// person's record.
func (suite *RepositoryTestSuite) TestCreateHealthSamples_OwnershipComesFromTheSession() {
	dbRepo := suite.repositoryForTest()
	userModel, authContext := suite.healthTestUser(dbRepo, "health_owner")

	sample := healthSampleFixture("sample-1", 0)
	sample.UserID = uuid.New() // a user id the caller made up

	stored, err := dbRepo.CreateHealthSamples(authContext, []models.HealthSample{sample})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, stored)

	samples, total, err := dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, total)
	require.Len(suite.T(), samples, 1)
	require.Equal(suite.T(), userModel.ID, samples[0].UserID, "the supplied user_id must be overwritten")
}

// The whole point of keying on HKObject.uuid: a phone that retries a push whose response it never saw,
// or re-sends an overlapping window, must not double the user's data.
func (suite *RepositoryTestSuite) TestCreateHealthSamples_IsIdempotent() {
	dbRepo := suite.repositoryForTest()
	_, authContext := suite.healthTestUser(dbRepo, "health_idempotent")

	batch := []models.HealthSample{
		healthSampleFixture("sample-1", 0),
		healthSampleFixture("sample-2", 5),
		healthSampleFixture("sample-3", 10),
	}

	stored, err := dbRepo.CreateHealthSamples(authContext, batch)
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 3, stored)

	// Re-send the identical batch.
	restored, err := dbRepo.CreateHealthSamples(authContext, []models.HealthSample{
		healthSampleFixture("sample-1", 0),
		healthSampleFixture("sample-2", 5),
		healthSampleFixture("sample-3", 10),
	})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 0, restored, "a replayed batch must store nothing")

	// An overlapping batch stores only what is genuinely new.
	overlapping, err := dbRepo.CreateHealthSamples(authContext, []models.HealthSample{
		healthSampleFixture("sample-3", 10),
		healthSampleFixture("sample-4", 15),
	})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, overlapping)

	_, total, err := dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 4, total)
}

// Two people on one instance push samples whose HealthKit UUIDs are generated independently and could
// collide. Dedup is per user, so one user's sample must never suppress or reveal another's.
func (suite *RepositoryTestSuite) TestHealthSamples_AreIsolatedPerUser() {
	dbRepo := suite.repositoryForTest()
	firstUser, firstContext := suite.healthTestUser(dbRepo, "health_first")
	secondUser, secondContext := suite.healthTestUser(dbRepo, "health_second")

	// Deliberately the SAME external uuid for both users.
	stored, err := dbRepo.CreateHealthSamples(firstContext, []models.HealthSample{healthSampleFixture("shared-uuid", 0)})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, stored)

	stored, err = dbRepo.CreateHealthSamples(secondContext, []models.HealthSample{healthSampleFixture("shared-uuid", 0)})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, stored, "dedup is scoped per user, so this is not a duplicate")

	firstSamples, firstTotal, err := dbRepo.ListHealthSamples(firstContext, models.HealthSampleQueryOptions{})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, firstTotal)
	require.Equal(suite.T(), firstUser.ID, firstSamples[0].UserID)

	secondSamples, secondTotal, err := dbRepo.ListHealthSamples(secondContext, models.HealthSampleQueryOptions{})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, secondTotal)
	require.Equal(suite.T(), secondUser.ID, secondSamples[0].UserID)
}

func (suite *RepositoryTestSuite) TestListHealthSamples_FiltersByMetricAndWindow() {
	dbRepo := suite.repositoryForTest()
	_, authContext := suite.healthTestUser(dbRepo, "health_filters")

	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	steps := healthSampleFixture("steps-1", 0)
	steps.HKType = "HKQuantityTypeIdentifierStepCount"
	steps.MetricType = "step_count"
	steps.Unit = "count"

	batch := []models.HealthSample{
		healthSampleFixture("hr-1", 0),
		healthSampleFixture("hr-2", 30),
		healthSampleFixture("hr-3", 60),
		steps,
	}
	stored, err := dbRepo.CreateHealthSamples(authContext, batch)
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 4, stored)

	// Metric filter.
	samples, total, err := dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{
		MetricTypes: []string{"step_count"},
	})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, total)
	require.Len(suite.T(), samples, 1)
	require.Equal(suite.T(), "step_count", samples[0].MetricType)

	// Window filter: inclusive lower bound, exclusive upper bound.
	after := base.Add(30 * time.Minute)
	before := base.Add(60 * time.Minute)
	samples, total, err = dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{
		MetricTypes:     []string{"heart_rate"},
		StartTimeAfter:  &after,
		StartTimeBefore: &before,
	})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 1, total)
	require.Len(suite.T(), samples, 1)
	require.Equal(suite.T(), "hr-2", samples[0].ExternalUUID)
}

func (suite *RepositoryTestSuite) TestListHealthSamples_OrdersNewestFirstByDefault() {
	dbRepo := suite.repositoryForTest()
	_, authContext := suite.healthTestUser(dbRepo, "health_order")

	_, err := dbRepo.CreateHealthSamples(authContext, []models.HealthSample{
		healthSampleFixture("hr-1", 0),
		healthSampleFixture("hr-2", 10),
		healthSampleFixture("hr-3", 20),
	})
	require.NoError(suite.T(), err)

	samples, _, err := dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{})
	require.NoError(suite.T(), err)
	require.Len(suite.T(), samples, 3)
	require.Equal(suite.T(), "hr-3", samples[0].ExternalUUID, "newest first by default")

	samples, _, err = dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{SortAscending: true})
	require.NoError(suite.T(), err)
	require.Len(suite.T(), samples, 3)
	require.Equal(suite.T(), "hr-1", samples[0].ExternalUUID)
}

// Paging is what keeps this endpoint from becoming the unbounded read that GetVitalsRecognized is, so
// the limit must be honored, clamped at the ceiling, and defaulted when unset — while total keeps
// reporting the full match count so a caller knows there is more.
func (suite *RepositoryTestSuite) TestListHealthSamples_BoundsThePage() {
	dbRepo := suite.repositoryForTest()
	_, authContext := suite.healthTestUser(dbRepo, "health_paging")

	batch := make([]models.HealthSample, 0, 10)
	for i := 0; i < 10; i++ {
		batch = append(batch, healthSampleFixture(fmt.Sprintf("hr-%02d", i), i))
	}
	_, err := dbRepo.CreateHealthSamples(authContext, batch)
	require.NoError(suite.T(), err)

	samples, total, err := dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{Limit: 4})
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 10, total, "total counts every match, not just the page")
	require.Len(suite.T(), samples, 4)

	// Offset walks the ordering.
	second, _, err := dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{Limit: 4, Offset: 4})
	require.NoError(suite.T(), err)
	require.Len(suite.T(), second, 4)
	require.NotEqual(suite.T(), samples[0].ExternalUUID, second[0].ExternalUUID)

	// A limit past the ceiling is clamped rather than rejected.
	samples, _, err = dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{Limit: models.HealthSampleMaxLimit + 1000})
	require.NoError(suite.T(), err)
	require.Len(suite.T(), samples, 10)

	// An unset limit falls back to the default rather than returning everything.
	samples, _, err = dbRepo.ListHealthSamples(authContext, models.HealthSampleQueryOptions{})
	require.NoError(suite.T(), err)
	require.Len(suite.T(), samples, 10)
}

func (suite *RepositoryTestSuite) TestUpsertHealthSyncState_ReplacesTheAnchorPerDeviceAndMetric() {
	dbRepo := suite.repositoryForTest()
	userModel, authContext := suite.healthTestUser(dbRepo, "health_anchor")

	firstEnd := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	require.NoError(suite.T(), dbRepo.UpsertHealthSyncState(authContext, &models.HealthSyncState{
		DeviceID:          "iphone-a",
		DeviceName:        "iPhone",
		MetricType:        "heart_rate",
		Anchor:            "anchor-one",
		LastSampleEndTime: &firstEnd,
	}))

	states, err := dbRepo.GetHealthSyncStates(authContext, "")
	require.NoError(suite.T(), err)
	require.Len(suite.T(), states, 1)
	require.Equal(suite.T(), "anchor-one", states[0].Anchor)
	require.Equal(suite.T(), userModel.ID, states[0].UserID)
	require.False(suite.T(), states[0].LastSyncedAt.IsZero(), "an unset LastSyncedAt is stamped on write")

	// The same device and metric updates in place.
	secondEnd := firstEnd.Add(time.Hour)
	require.NoError(suite.T(), dbRepo.UpsertHealthSyncState(authContext, &models.HealthSyncState{
		DeviceID:          "iphone-a",
		MetricType:        "heart_rate",
		Anchor:            "anchor-two",
		LastSampleEndTime: &secondEnd,
	}))

	states, err = dbRepo.GetHealthSyncStates(authContext, "")
	require.NoError(suite.T(), err)
	require.Len(suite.T(), states, 1, "the same device and metric must update, not accumulate")
	require.Equal(suite.T(), "anchor-two", states[0].Anchor)

	// A different metric, and a different device, each get their own row.
	require.NoError(suite.T(), dbRepo.UpsertHealthSyncState(authContext, &models.HealthSyncState{
		DeviceID:   "iphone-a",
		MetricType: "step_count",
		Anchor:     "anchor-steps",
	}))
	require.NoError(suite.T(), dbRepo.UpsertHealthSyncState(authContext, &models.HealthSyncState{
		DeviceID:   "ipad-b",
		MetricType: "heart_rate",
		Anchor:     "anchor-ipad",
	}))

	states, err = dbRepo.GetHealthSyncStates(authContext, "")
	require.NoError(suite.T(), err)
	require.Len(suite.T(), states, 3)

	// Narrowing to one device is how a reinstalled app asks only about itself.
	states, err = dbRepo.GetHealthSyncStates(authContext, "ipad-b")
	require.NoError(suite.T(), err)
	require.Len(suite.T(), states, 1)
	require.Equal(suite.T(), "anchor-ipad", states[0].Anchor)
}

func (suite *RepositoryTestSuite) TestUpsertHealthSyncState_RequiresDeviceAndMetric() {
	dbRepo := suite.repositoryForTest()
	_, authContext := suite.healthTestUser(dbRepo, "health_anchor_validation")

	require.Error(suite.T(), dbRepo.UpsertHealthSyncState(authContext, &models.HealthSyncState{MetricType: "heart_rate"}))
	require.Error(suite.T(), dbRepo.UpsertHealthSyncState(authContext, &models.HealthSyncState{DeviceID: "iphone-a"}))
}

func (suite *RepositoryTestSuite) TestHealthSyncState_IsIsolatedPerUser() {
	dbRepo := suite.repositoryForTest()
	_, firstContext := suite.healthTestUser(dbRepo, "health_anchor_first")
	_, secondContext := suite.healthTestUser(dbRepo, "health_anchor_second")

	require.NoError(suite.T(), dbRepo.UpsertHealthSyncState(firstContext, &models.HealthSyncState{
		DeviceID:   "iphone-a",
		MetricType: "heart_rate",
		Anchor:     "first-anchor",
	}))
	require.NoError(suite.T(), dbRepo.UpsertHealthSyncState(secondContext, &models.HealthSyncState{
		DeviceID:   "iphone-a",
		MetricType: "heart_rate",
		Anchor:     "second-anchor",
	}))

	firstStates, err := dbRepo.GetHealthSyncStates(firstContext, "")
	require.NoError(suite.T(), err)
	require.Len(suite.T(), firstStates, 1)
	require.Equal(suite.T(), "first-anchor", firstStates[0].Anchor)

	secondStates, err := dbRepo.GetHealthSyncStates(secondContext, "")
	require.NoError(suite.T(), err)
	require.Len(suite.T(), secondStates, 1)
	require.Equal(suite.T(), "second-anchor", secondStates[0].Anchor)
}

func (suite *RepositoryTestSuite) TestCreateHealthSamples_EmptyBatchIsANoOp() {
	dbRepo := suite.repositoryForTest()
	_, authContext := suite.healthTestUser(dbRepo, "health_empty")

	stored, err := dbRepo.CreateHealthSamples(authContext, nil)
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 0, stored)
}

// Every path must refuse to act without an authenticated user rather than fall back to a global scope.
func (suite *RepositoryTestSuite) TestHealthSamples_RequireAnAuthenticatedUser() {
	dbRepo := suite.repositoryForTest()

	_, err := dbRepo.CreateHealthSamples(context.Background(), []models.HealthSample{healthSampleFixture("hr-1", 0)})
	require.Error(suite.T(), err)

	_, _, err = dbRepo.ListHealthSamples(context.Background(), models.HealthSampleQueryOptions{})
	require.Error(suite.T(), err)

	err = dbRepo.UpsertHealthSyncState(context.Background(), &models.HealthSyncState{DeviceID: "a", MetricType: "heart_rate"})
	require.Error(suite.T(), err)

	_, err = dbRepo.GetHealthSyncStates(context.Background(), "")
	require.Error(suite.T(), err)
}
