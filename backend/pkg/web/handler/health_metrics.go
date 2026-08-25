package handler

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// ListHealthMetrics returns one summary row per metric the user has stored, plus when the iPhone last
// pushed. The catalog UI lists these; it does not page through health_samples.
func ListHealthMetrics(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	summaries, err := databaseRepo.SummarizeHealthMetrics(c)
	if err != nil {
		logger.Errorln("health metrics: list:", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to list health metrics"})
		return
	}

	states, err := databaseRepo.GetHealthSyncStates(c, "")
	if err != nil {
		logger.Errorln("health metrics: sync state:", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to list health metrics"})
		return
	}

	catalog := models.HealthMetricsCatalog{Metrics: summaries}
	if catalog.Metrics == nil {
		catalog.Metrics = []models.HealthMetricSummary{}
	}
	for _, state := range states {
		synced := state.LastSyncedAt
		if catalog.LastSyncedAt == nil || synced.After(*catalog.LastSyncedAt) {
			t := synced
			catalog.LastSyncedAt = &t
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": catalog})
}

// GetHealthSeries returns a chart-sized series for one metric in a time window. Mode is chosen by the
// UI registry (points, day, stages) so a new HealthKit type can pick a chart without a server change.
func GetHealthSeries(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	queryOptions := models.HealthSeriesQueryOptions{
		MetricTypes: parseMetricTypes(c.QueryArray("metric_type")),
		HKType:      strings.TrimSpace(c.Query("hk_type")),
		Mode:        strings.TrimSpace(c.Query("mode")),
	}
	if queryOptions.Mode == "" {
		queryOptions.Mode = models.HealthSeriesModePoints
	}
	switch queryOptions.Mode {
	case models.HealthSeriesModePoints, models.HealthSeriesModeDay, models.HealthSeriesModeStages:
	default:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "mode must be points, day, or stages"})
		return
	}
	if len(queryOptions.MetricTypes) == 0 && queryOptions.HKType == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "metric_type or hk_type is required"})
		return
	}

	if raw := strings.TrimSpace(c.Query("start_after")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "start_after must be an RFC3339 timestamp"})
			return
		}
		queryOptions.StartTimeAfter = &parsed
	}
	if raw := strings.TrimSpace(c.Query("start_before")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "start_before must be an RFC3339 timestamp"})
			return
		}
		queryOptions.StartTimeBefore = &parsed
	}
	if raw := strings.TrimSpace(c.Query("max_points")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "max_points must be an integer"})
			return
		}
		queryOptions.MaxPoints = parsed
	}

	series, err := databaseRepo.QueryHealthSeries(c, queryOptions)
	if err != nil {
		logger.Errorln("health series:", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to query health series"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": series})
}
