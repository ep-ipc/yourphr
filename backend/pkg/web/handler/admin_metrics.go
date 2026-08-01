package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/metrics"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// AdminMetricsResponse is the payload for GET /api/secure/admin/metrics (#441).
// Powers the Admin Dashboard Metrics card. Scrape port stays internal; this endpoint
// surfaces config + process counters + recent job summaries over the normal API.
type AdminMetricsResponse struct {
	ScrapeEnabled bool             `json:"scrape_enabled"`
	ScrapeAddr    string           `json:"scrape_addr,omitempty"`
	ScrapePath    string           `json:"scrape_path"`
	ScrapeNote    string           `json:"scrape_note"`
	Process       metrics.Snapshot `json:"process"`
	RecentJobs    []RecentSyncJob  `json:"recent_jobs"`
}

// RecentSyncJob is a compact job row for the Metrics card.
type RecentSyncJob struct {
	ID         string                 `json:"id"`
	JobStatus  string                 `json:"job_status"`
	CreatedAt  string                 `json:"created_at,omitempty"`
	DoneTime   string                 `json:"done_time,omitempty"`
	SourceID   string                 `json:"source_id,omitempty"`
	Summary    *models.SyncJobSummary `json:"summary,omitempty"`
}

// GetAdminMetrics returns metrics config, in-process counters, and recent sync jobs. Admin-only.
func GetAdminMetrics(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "admin role required"})
		return
	}
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	enabled := appConfig.GetBool("metrics.enabled")
	addr := appConfig.GetString("metrics.addr")
	if addr == "" {
		port := appConfig.GetInt("metrics.port")
		if port <= 0 {
			port = 9091
		}
		addr = fmt.Sprintf(":%d", port)
	}

	resp := AdminMetricsResponse{
		ScrapeEnabled: enabled,
		ScrapePath:    "/metrics",
		ScrapeNote:    "Prometheus scrape is cluster-internal only. Do not expose on public Ingress. Configure metrics.enabled / metrics.port|addr (YOURPHR_METRICS_*).",
		Process:       metrics.Global.Snapshot(),
		RecentJobs:    []RecentSyncJob{},
	}
	if enabled {
		resp.ScrapeAddr = addr
	}

	// Recent SYNC jobs for this admin user (same scope as GET /jobs).
	jobType := pkg.BackgroundJobTypeSync
	jobs, err := databaseRepo.ListBackgroundJobs(c, models.BackgroundJobQueryOptions{
		JobType: &jobType,
		Limit:   10,
	})
	if err != nil {
		logger.Warnf("admin metrics: list jobs: %v", err)
	} else {
		for _, j := range jobs {
			row := RecentSyncJob{
				ID:        j.ID.String(),
				JobStatus: string(j.JobStatus),
			}
			if !j.CreatedAt.IsZero() {
				row.CreatedAt = j.CreatedAt.UTC().Format(time.RFC3339)
			}
			if j.DoneTime != nil {
				row.DoneTime = j.DoneTime.UTC().Format(time.RFC3339)
			}
			var data models.BackgroundJobSyncData
			if len(j.Data) > 0 && json.Unmarshal(j.Data, &data) == nil {
				row.SourceID = data.SourceID.String()
				row.Summary = data.Summary
			}
			resp.RecentJobs = append(resp.RecentJobs, row)
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": resp})
}
