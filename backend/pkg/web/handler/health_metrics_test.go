package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

func TestListHealthMetrics_ReturnsCatalogAndLatestSync(t *testing.T) {
	ginSetTestMode(t)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	earlier := healthTestBase
	later := healthTestBase.Add(time.Hour)
	mockDB.EXPECT().SummarizeHealthMetrics(gomock.Any()).
		Return([]models.HealthMetricSummary{{MetricType: "heart_rate", SampleCount: 12}}, nil)
	mockDB.EXPECT().GetHealthSyncStates(gomock.Any(), "").
		Return([]models.HealthSyncState{
			{MetricType: "heart_rate", LastSyncedAt: earlier},
			{MetricType: "step_count", LastSyncedAt: later},
		}, nil)

	c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/metrics", nil)
	ListHealthMetrics(c)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data models.HealthMetricsCatalog `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data.Metrics, 1)
	require.Equal(t, "heart_rate", body.Data.Metrics[0].MetricType)
	require.NotNil(t, body.Data.LastSyncedAt)
	require.True(t, body.Data.LastSyncedAt.Equal(later))
}

func TestListHealthMetrics_EmptyCatalogIsAListNotNull(t *testing.T) {
	ginSetTestMode(t)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().SummarizeHealthMetrics(gomock.Any()).Return(nil, nil)
	mockDB.EXPECT().GetHealthSyncStates(gomock.Any(), "").Return(nil, nil)

	c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/metrics", nil)
	ListHealthMetrics(c)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data models.HealthMetricsCatalog `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotNil(t, body.Data.Metrics)
	require.Empty(t, body.Data.Metrics)
}

func TestGetHealthSeries_PassesQueryOptionsThrough(t *testing.T) {
	ginSetTestMode(t)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	var captured models.HealthSeriesQueryOptions
	mockDB.EXPECT().QueryHealthSeries(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ interface{}, opts models.HealthSeriesQueryOptions) (models.HealthSeries, error) {
			captured = opts
			return models.HealthSeries{MetricType: "heart_rate", Total: 3, Points: []models.HealthSeriesPoint{{T: healthTestBase, V: 72}}}, nil
		})

	c, w := healthSampleContext(t, mockDB, http.MethodGet,
		"/health/series?metric_type=heart_rate&mode=points&start_after=2026-03-01T12:00:00Z&start_before=2026-03-06T12:00:00Z&max_points=50", nil)
	GetHealthSeries(c)

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"heart_rate"}, captured.MetricTypes)
	require.Equal(t, models.HealthSeriesModePoints, captured.Mode)
	require.Equal(t, 50, captured.MaxPoints)
	require.NotNil(t, captured.StartTimeAfter)
	require.NotNil(t, captured.StartTimeBefore)
}

func TestGetHealthSeries_RejectsBadParameters(t *testing.T) {
	ginSetTestMode(t)

	tests := []struct {
		name  string
		query string
	}{
		{name: "missing metric", query: ""},
		{name: "bad mode", query: "?metric_type=heart_rate&mode=heatmap"},
		{name: "start_after not rfc3339", query: "?metric_type=heart_rate&start_after=yesterday"},
		{name: "max_points not an integer", query: "?metric_type=heart_rate&max_points=lots"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockCtrl := gomock.NewController(t)
			defer mockCtrl.Finish()
			mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

			c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/series"+tt.query, nil)
			GetHealthSeries(c)

			require.Equal(t, http.StatusBadRequest, w.Code)
		})
	}
}

func TestGetHealthSeries_ReportsRepositoryFailure(t *testing.T) {
	ginSetTestMode(t)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

	mockDB.EXPECT().QueryHealthSeries(gomock.Any(), gomock.Any()).Return(models.HealthSeries{}, errors.New("boom"))

	c, w := healthSampleContext(t, mockDB, http.MethodGet, "/health/series?metric_type=heart_rate", nil)
	GetHealthSeries(c)

	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func ginSetTestMode(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)
}
