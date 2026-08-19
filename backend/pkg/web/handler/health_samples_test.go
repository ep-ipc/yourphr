package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

var healthTestBase = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

func float64Ptr(v float64) *float64 { return &v }

// healthSampleContext wires a gin context with the logger and mock repository the handlers pull from
// the request context.
func healthSampleContext(t *testing.T, mockDB *mock_database.MockDatabaseRepository, method, target string, body interface{}) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
	c.Set(pkg.ContextKeyTypeDatabase, mockDB)

	var reader *bytes.Buffer
	if body != nil {
		encoded, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewBuffer(encoded)
	} else {
		reader = bytes.NewBuffer(nil)
	}
	c.Request, _ = http.NewRequest(method, target, reader)
	c.Request.Header.Set("Content-Type", "application/json")
	return c, w
}

func validHeartRateInput(uuid string, minutesFromBase int) HealthSampleInput {
	at := healthTestBase.Add(time.Duration(minutesFromBase) * time.Minute)
	return HealthSampleInput{
		UUID:       uuid,
		Type:       "HKQuantityTypeIdentifierHeartRate",
		Start:      at,
		End:        at,
		Value:      float64Ptr(72),
		Unit:       "count/min",
		SourceName: "Apple Watch",
	}
}

// --- buildHealthSample ------------------------------------------------------------------------

func TestBuildHealthSample_QuantitySample(t *testing.T) {
	sample, err := buildHealthSample(validHeartRateInput("hr-1", 0))
	require.NoError(t, err)
	require.Equal(t, "hr-1", sample.ExternalUUID)
	require.Equal(t, "HKQuantityTypeIdentifierHeartRate", sample.HKType)
	require.Equal(t, "heart_rate", sample.MetricType)
	require.Equal(t, "count/min", sample.Unit)
	require.NotNil(t, sample.ValueNum)
	require.Equal(t, 72.0, *sample.ValueNum)
}

// A unit alias is stored in the canonical spelling, so a chart never has to know that "bpm" and
// "count/min" are the same thing.
func TestBuildHealthSample_NormalizesUnitAliases(t *testing.T) {
	input := validHeartRateInput("hr-1", 0)
	input.Unit = "bpm"

	sample, err := buildHealthSample(input)
	require.NoError(t, err)
	require.Equal(t, "count/min", sample.Unit)
}

// Storing a heart rate whose unit might be beats per hour is worse than not storing it.
func TestBuildHealthSample_RejectsWrongUnitForKnownMetric(t *testing.T) {
	input := validHeartRateInput("hr-1", 0)
	input.Unit = "mmHg"

	_, err := buildHealthSample(input)
	require.Error(t, err)
	require.Contains(t, err.Error(), "heart_rate")
}

func TestBuildHealthSample_RejectsMissingUnitForKnownMetric(t *testing.T) {
	input := validHeartRateInput("hr-1", 0)
	input.Unit = ""

	_, err := buildHealthSample(input)
	require.Error(t, err)
}

func TestBuildHealthSample_RejectsMissingValueForQuantityMetric(t *testing.T) {
	input := validHeartRateInput("hr-1", 0)
	input.Value = nil

	_, err := buildHealthSample(input)
	require.Error(t, err)
	require.Contains(t, err.Error(), "numeric value")
}

func TestBuildHealthSample_CategorySample(t *testing.T) {
	sample, err := buildHealthSample(HealthSampleInput{
		UUID:      "sleep-1",
		Type:      "HKCategoryTypeIdentifierSleepAnalysis",
		Start:     healthTestBase,
		End:       healthTestBase.Add(6 * time.Hour),
		ValueText: "4",
	})
	require.NoError(t, err)
	require.Equal(t, "sleep_stage", sample.MetricType)
	require.Equal(t, "asleepDeep", sample.ValueText, "HealthKit's raw enum is stored under its name")
	require.Nil(t, sample.ValueNum)
}

func TestBuildHealthSample_RejectsUnknownCategoryValue(t *testing.T) {
	_, err := buildHealthSample(HealthSampleInput{
		UUID:      "sleep-1",
		Type:      "HKCategoryTypeIdentifierSleepAnalysis",
		Start:     healthTestBase,
		ValueText: "dreaming",
	})
	require.Error(t, err)
}

// An app that ships a metric before the server learns it must not lose the user's data, so an
// unrecognized identifier is stored verbatim with no metric type instead of being rejected.
func TestBuildHealthSample_KeepsUnknownTypeVerbatim(t *testing.T) {
	sample, err := buildHealthSample(HealthSampleInput{
		UUID:  "mystery-1",
		Type:  "HKQuantityTypeIdentifierSomethingNew",
		Start: healthTestBase,
		Value: float64Ptr(3.5),
		Unit:  "furlongs",
	})
	require.NoError(t, err)
	require.Equal(t, "HKQuantityTypeIdentifierSomethingNew", sample.HKType)
	require.Empty(t, sample.MetricType, "an unknown type has no normalized name")
	require.Equal(t, "furlongs", sample.Unit, "the unit is preserved as sent")
	require.Equal(t, 3.5, *sample.ValueNum)
}

func TestBuildHealthSample_Rejections(t *testing.T) {
	tests := []struct {
		name  string
		input HealthSampleInput
	}{
		{name: "missing uuid", input: HealthSampleInput{Type: "HKQuantityTypeIdentifierHeartRate", Start: healthTestBase, Value: float64Ptr(72), Unit: "count/min"}},
		{name: "blank uuid", input: HealthSampleInput{UUID: "   ", Type: "HKQuantityTypeIdentifierHeartRate", Start: healthTestBase, Value: float64Ptr(72), Unit: "count/min"}},
		{name: "missing type", input: HealthSampleInput{UUID: "hr-1", Start: healthTestBase, Value: float64Ptr(72), Unit: "count/min"}},
		{name: "missing start", input: HealthSampleInput{UUID: "hr-1", Type: "HKQuantityTypeIdentifierHeartRate", Value: float64Ptr(72), Unit: "count/min"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := buildHealthSample(tt.input)
			require.Error(t, err)
		})
	}
}

func TestBuildHealthSample_RejectsEndBeforeStart(t *testing.T) {
	input := validHeartRateInput("hr-1", 0)
	input.End = input.Start.Add(-time.Minute)

	_, err := buildHealthSample(input)
	require.Error(t, err)
	require.Contains(t, err.Error(), "end is before start")
}

// An instantaneous sample legitimately has no distinct end.
func TestBuildHealthSample_DefaultsMissingEndToStart(t *testing.T) {
	input := validHeartRateInput("hr-1", 0)
	input.End = time.Time{}

	sample, err := buildHealthSample(input)
	require.NoError(t, err)
	require.True(t, sample.EndTime.Equal(sample.StartTime))
}

func TestBuildHealthSample_StoresMetadataAsJSON(t *testing.T) {
	input := validHeartRateInput("hr-1", 0)
	input.Metadata = map[string]interface{}{"HKMetadataKeyHeartRateMotionContext": 1}

	sample, err := buildHealthSample(input)
	require.NoError(t, err)
	require.NotEmpty(t, sample.Metadata)

	var decoded map[string]interface{}
	require.NoError(t, json.Unmarshal(sample.Metadata, &decoded))
	require.Contains(t, decoded, "HKMetadataKeyHeartRateMotionContext")
}

func TestBuildHealthSample_LeavesMetadataUnsetWhenAbsent(t *testing.T) {
	sample, err := buildHealthSample(validHeartRateInput("hr-1", 0))
	require.NoError(t, err)
	require.Empty(t, sample.Metadata)
}

// --- CreateHealthSamples ----------------------------------------------------------------------

func decodeIngestResponse(t *testing.T, w *httptest.ResponseRecorder) HealthSampleIngestResponse {
	t.Helper()
	var body struct {
		Success bool                       `json:"success"`
		Data    HealthSampleIngestResponse `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.True(t, body.Success)
	return body.Data
}

func TestCreateHealthSamples_StoresBatch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Len(2)).Return(int64(2), nil)

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a", Name: "iPhone"},
		Samples: []HealthSampleInput{validHeartRateInput("hr-1", 0), validHeartRateInput("hr-2", 5)},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	data := decodeIngestResponse(t, w)
	require.Equal(t, 2, data.Received)
	require.Equal(t, 2, data.Accepted)
	require.EqualValues(t, 2, data.Stored)
	require.EqualValues(t, 0, data.Duplicates)
	require.Equal(t, 0, data.Rejected)
	require.Empty(t, data.Errors)
}

// The app advances its HealthKit anchor based on these counts, so a replayed push must be reported as
// duplicates rather than as a failure.
func TestCreateHealthSamples_ReportsDuplicates(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Len(3)).Return(int64(1), nil)

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device: HealthDeviceInfo{DeviceID: "iphone-a"},
		Samples: []HealthSampleInput{
			validHeartRateInput("hr-1", 0),
			validHeartRateInput("hr-2", 5),
			validHeartRateInput("hr-3", 10),
		},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	data := decodeIngestResponse(t, w)
	require.EqualValues(t, 1, data.Stored)
	require.EqualValues(t, 2, data.Duplicates)
}

// One malformed sample in a batch of otherwise good ones must not cost the user the whole push.
func TestCreateHealthSamples_RejectsBadSamplesIndividually(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	badUnit := validHeartRateInput("hr-bad", 5)
	badUnit.Unit = "mmHg"

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Len(1)).Return(int64(1), nil)

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a"},
		Samples: []HealthSampleInput{validHeartRateInput("hr-good", 0), badUnit},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	data := decodeIngestResponse(t, w)
	require.Equal(t, 2, data.Received)
	require.Equal(t, 1, data.Accepted)
	require.EqualValues(t, 1, data.Stored)
	require.Equal(t, 1, data.Rejected)
	require.Len(t, data.Errors, 1)
	require.Equal(t, "hr-bad", data.Errors[0].UUID)
	require.NotEmpty(t, data.Errors[0].Reason)
}

// A batch that is wrong in every row must not produce a response bigger than the request.
func TestCreateHealthSamples_CapsTheReportedErrorList(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	badCount := healthSampleMaxReportedErrors + 25
	samples := make([]HealthSampleInput, 0, badCount)
	for i := 0; i < badCount; i++ {
		bad := validHeartRateInput(fmt.Sprintf("hr-%d", i), i)
		bad.Unit = "furlongs"
		samples = append(samples, bad)
	}

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Len(0)).Return(int64(0), nil)

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a"},
		Samples: samples,
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	data := decodeIngestResponse(t, w)
	require.Equal(t, badCount, data.Rejected, "the full rejection count is still reported")
	require.Len(t, data.Errors, healthSampleMaxReportedErrors)
}

// A looping or misconfigured background client must be told to page rather than allowed to push
// unbounded work into one request. The database must not be touched at all.
func TestCreateHealthSamples_RejectsOversizedBatch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
	// No EXPECT: gomock fails the test if the repository is called.

	samples := make([]HealthSampleInput, HealthSampleMaxBatch+1)
	for i := range samples {
		samples[i] = validHeartRateInput(fmt.Sprintf("hr-%d", i), 0)
	}

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a"},
		Samples: samples,
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "maximum")
}

func TestCreateHealthSamples_RequiresDeviceID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Samples: []HealthSampleInput{validHeartRateInput("hr-1", 0)},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "device_id")
}

func TestCreateHealthSamples_RejectsMalformedJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
	c.Set(pkg.ContextKeyTypeDatabase, mockDB)
	c.Request, _ = http.NewRequest(http.MethodPost, "/health/samples", strings.NewReader("{not json"))
	c.Request.Header.Set("Content-Type", "application/json")

	CreateHealthSamples(c)

	require.Equal(t, http.StatusBadRequest, w.Code)
}

// An oversized body is refused with 413 rather than read into memory, since nothing else on
// /api/secure bounds request bodies.
func TestCreateHealthSamples_RejectsOversizedBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	oversized := bytes.NewBuffer(nil)
	oversized.WriteString(`{"device":{"device_id":"iphone-a"},"samples":[`)
	oversized.WriteString(strings.Repeat(`{"uuid":"padding-padding-padding-padding"},`, (healthSampleMaxBodyBytes/42)+64))
	oversized.WriteString(`{"uuid":"x"}]}`)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
	c.Set(pkg.ContextKeyTypeDatabase, mockDB)
	c.Request, _ = http.NewRequest(http.MethodPost, "/health/samples", oversized)
	c.Request.Header.Set("Content-Type", "application/json")

	CreateHealthSamples(c)

	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code)
}

func TestCreateHealthSamples_ReportsStorageFailure(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Any()).Return(int64(0), errors.New("database is locked"))

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a"},
		Samples: []HealthSampleInput{validHeartRateInput("hr-1", 0)},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusInternalServerError, w.Code)
}

// The anchor is recorded with the newest sample time it corresponds to, which is what lets a
// reinstalled app resume at the right point.
func TestCreateHealthSamples_RecordsAnchorsWithLatestSampleTime(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Len(2)).Return(int64(2), nil)

	var captured *models.HealthSyncState
	mockDB.EXPECT().UpsertHealthSyncState(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ interface{}, state *models.HealthSyncState) error {
			captured = state
			return nil
		})

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a", Name: "iPhone 15"},
		Samples: []HealthSampleInput{validHeartRateInput("hr-1", 0), validHeartRateInput("hr-2", 30)},
		Anchors: map[string]string{"heart_rate": "anchor-blob"},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	require.NotNil(t, captured)
	require.Equal(t, "iphone-a", captured.DeviceID)
	require.Equal(t, "iPhone 15", captured.DeviceName)
	require.Equal(t, "heart_rate", captured.MetricType)
	require.Equal(t, "anchor-blob", captured.Anchor)
	require.NotNil(t, captured.LastSampleEndTime)
	require.True(t, captured.LastSampleEndTime.Equal(healthTestBase.Add(30*time.Minute)),
		"the anchor is paired with the newest sample in the batch")
}

// A failed anchor write must not fail the request: the samples are already stored, and the app simply
// re-sends from its previous anchor next time, which dedups.
func TestCreateHealthSamples_SucceedsWhenAnchorWriteFails(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Any()).Return(int64(1), nil)
	mockDB.EXPECT().UpsertHealthSyncState(gomock.Any(), gomock.Any()).Return(errors.New("database is locked"))

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a"},
		Samples: []HealthSampleInput{validHeartRateInput("hr-1", 0)},
		Anchors: map[string]string{"heart_rate": "anchor-blob"},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	require.EqualValues(t, 1, decodeIngestResponse(t, w).Stored)
}

// An empty push carrying only an anchor is how an app confirms it has caught up.
func TestCreateHealthSamples_AcceptsAnchorOnlyPush(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Len(0)).Return(int64(0), nil)
	mockDB.EXPECT().UpsertHealthSyncState(gomock.Any(), gomock.Any()).Return(nil)

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a"},
		Anchors: map[string]string{"heart_rate": "anchor-blob"},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	data := decodeIngestResponse(t, w)
	require.Equal(t, 0, data.Received)
	require.EqualValues(t, 0, data.Stored)
}

func TestCreateHealthSamples_SkipsBlankAnchorKeys(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().CreateHealthSamples(gomock.Any(), gomock.Any()).Return(int64(0), nil)
	// No UpsertHealthSyncState EXPECT: a blank metric key must not produce a sync-state row.

	c, w := healthSampleContext(t, mockDB, http.MethodPost, "/health/samples", HealthSampleIngestRequest{
		Device:  HealthDeviceInfo{DeviceID: "iphone-a"},
		Anchors: map[string]string{"  ": "anchor-blob"},
	})
	CreateHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
}

// --- ListHealthSamples ------------------------------------------------------------------------

func TestListHealthSamples_PassesQueryOptionsThrough(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	var captured models.HealthSampleQueryOptions
	mockDB.EXPECT().ListHealthSamples(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ interface{}, opts models.HealthSampleQueryOptions) ([]models.HealthSample, int64, error) {
			captured = opts
			return []models.HealthSample{}, 0, nil
		})

	c, w := healthSampleContext(t, mockDB, http.MethodGet,
		"/health/samples?metric_type=heart_rate,step_count&metric_type=sleep_stage&start_after=2026-03-01T12:00:00Z&start_before=2026-03-02T12:00:00Z&limit=25&offset=50&sort=asc", nil)
	ListHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"heart_rate", "step_count", "sleep_stage"}, captured.MetricTypes,
		"repeated and comma-separated metric_type must both work")
	require.Equal(t, 25, captured.Limit)
	require.Equal(t, 50, captured.Offset)
	require.True(t, captured.SortAscending)
	require.NotNil(t, captured.StartTimeAfter)
	require.True(t, captured.StartTimeAfter.Equal(healthTestBase))
	require.NotNil(t, captured.StartTimeBefore)
}

func TestListHealthSamples_RejectsBadParameters(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name  string
		query string
	}{
		{name: "start_after not rfc3339", query: "?start_after=yesterday"},
		{name: "start_before not rfc3339", query: "?start_before=2026-03-01"},
		{name: "limit not an integer", query: "?limit=lots"},
		{name: "offset not an integer", query: "?offset=some"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockCtrl := gomock.NewController(t)
			defer mockCtrl.Finish()
			mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
			// No EXPECT: a malformed query must not reach the database.

			c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/samples"+tt.query, nil)
			ListHealthSamples(c)

			require.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}

func TestListHealthSamples_ReturnsTotalAlongsideThePage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().ListHealthSamples(gomock.Any(), gomock.Any()).
		Return([]models.HealthSample{{ExternalUUID: "hr-1"}}, int64(4200), nil)

	c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/samples?limit=1", nil)
	ListHealthSamples(c)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			Total   int64                 `json:"total"`
			Count   int                   `json:"count"`
			Samples []models.HealthSample `json:"samples"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.EqualValues(t, 4200, body.Data.Total, "the caller must be able to tell there is more")
	require.Equal(t, 1, body.Data.Count)
	require.Len(t, body.Data.Samples, 1)
}

func TestListHealthSamples_ReportsRepositoryFailure(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().ListHealthSamples(gomock.Any(), gomock.Any()).Return(nil, int64(0), errors.New("boom"))

	c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/samples", nil)
	ListHealthSamples(c)

	require.Equal(t, http.StatusInternalServerError, w.Code)
}

// --- GetHealthSyncState -----------------------------------------------------------------------

func TestGetHealthSyncState_FiltersByDevice(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().GetHealthSyncStates(gomock.Any(), "iphone-a").
		Return([]models.HealthSyncState{{DeviceID: "iphone-a", MetricType: "heart_rate", Anchor: "blob"}}, nil)

	c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/sync-state?device_id=iphone-a", nil)
	GetHealthSyncState(c)

	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), "heart_rate")
}

func TestGetHealthSyncState_ReturnsEveryDeviceByDefault(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().GetHealthSyncStates(gomock.Any(), "").Return([]models.HealthSyncState{}, nil)

	c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/sync-state", nil)
	GetHealthSyncState(c)

	require.Equal(t, http.StatusOK, w.Code)
}

func TestGetHealthSyncState_ReportsRepositoryFailure(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().GetHealthSyncStates(gomock.Any(), gomock.Any()).Return(nil, errors.New("boom"))

	c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/sync-state", nil)
	GetHealthSyncState(c)

	require.Equal(t, http.StatusInternalServerError, w.Code)
}
