package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/healthkit"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"gorm.io/datatypes"
)

const (
	// HealthSampleMaxBatch caps one push. A watch generates samples faster than a phone uploads them,
	// so the app is expected to page through its backlog rather than send a year in one request.
	HealthSampleMaxBatch = 5000
	// healthSampleMaxBodyBytes bounds the request body. Nothing else on /api/secure does this, so an
	// endpoint whose whole purpose is to accept bulk data has to bound itself.
	healthSampleMaxBodyBytes = 8 << 20 // 8MiB
	// healthSampleMaxReportedErrors caps the per-sample rejection list. A batch that is wrong in every
	// row should not produce a response larger than the request that caused it; Rejected still carries
	// the full count.
	healthSampleMaxReportedErrors = 50
)

// HealthSampleIngestRequest is the body for POST /api/secure/health/samples.
type HealthSampleIngestRequest struct {
	Device  HealthDeviceInfo    `json:"device"`
	Samples []HealthSampleInput `json:"samples"`
	// Anchors maps a normalized metric type to the opaque HKQueryAnchor the app wants remembered, so a
	// reinstall can resume. Recorded only after the samples in this request are stored.
	Anchors map[string]string `json:"anchors"`
}

// HealthDeviceInfo identifies the phone doing the pushing, which is not necessarily the device that
// recorded the samples (an Apple Watch reading arrives via the iPhone).
type HealthDeviceInfo struct {
	DeviceID   string `json:"device_id"`
	Name       string `json:"name"`
	OSVersion  string `json:"os_version"`
	AppVersion string `json:"app_version"`
}

// HealthSampleInput is one HealthKit sample as sent by the app.
type HealthSampleInput struct {
	// UUID is HKObject.uuid and is what makes a re-push idempotent.
	UUID string `json:"uuid"`
	// Type is the raw HealthKit type identifier, e.g. HKQuantityTypeIdentifierHeartRate.
	Type  string    `json:"type"`
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`

	// Value and Unit carry quantity samples; ValueText carries category samples such as sleep stages.
	Value     *float64 `json:"value"`
	Unit      string   `json:"unit"`
	ValueText string   `json:"value_text"`

	SourceName      string                 `json:"source_name"`
	SourceBundleID  string                 `json:"source_bundle_id"`
	DeviceName      string                 `json:"device_name"`
	CorrelationUUID string                 `json:"correlation_uuid"`
	Metadata        map[string]interface{} `json:"metadata"`
}

// HealthSampleRejection explains why one sample was not stored. The rest of the batch still is.
type HealthSampleRejection struct {
	UUID   string `json:"uuid"`
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// HealthSampleIngestResponse tells the app exactly what happened, so it only advances its anchor when
// the samples behind it are durably stored.
type HealthSampleIngestResponse struct {
	Received   int                     `json:"received"`
	Accepted   int                     `json:"accepted"`
	Stored     int64                   `json:"stored"`
	Duplicates int64                   `json:"duplicates"`
	Rejected   int                     `json:"rejected"`
	Errors     []HealthSampleRejection `json:"errors,omitempty"`
}

// CreateHealthSamples ingests a batch of Apple Health samples from the iPhone companion app.
//
// These are stored in health_samples rather than as FHIR Observations on purpose: the FHIR write path
// evaluates ~40 FHIRPath expressions in a fresh JavaScript runtime per resource, which measures near a
// second apiece, and a watch produces samples far faster than that.
func CreateHealthSamples(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, healthSampleMaxBodyBytes)

	var req HealthSampleIngestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{
				"success": false,
				"error":   fmt.Sprintf("request body exceeds %d bytes; send fewer samples per request", healthSampleMaxBodyBytes),
			})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "invalid request: " + err.Error()})
		return
	}

	deviceID := strings.TrimSpace(req.Device.DeviceID)
	if deviceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "device.device_id is required"})
		return
	}
	if len(req.Samples) > HealthSampleMaxBatch {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"error":   fmt.Sprintf("batch contains %d samples; the maximum is %d", len(req.Samples), HealthSampleMaxBatch),
		})
		return
	}

	samples := make([]models.HealthSample, 0, len(req.Samples))
	rejections := make([]HealthSampleRejection, 0)
	rejected := 0
	// latestEnd tracks, per metric type, the newest sample in this batch, so a stored anchor is paired
	// with the point in time it corresponds to.
	latestEnd := map[string]time.Time{}

	for _, input := range req.Samples {
		sample, err := buildHealthSample(input)
		if err != nil {
			rejected++
			if len(rejections) < healthSampleMaxReportedErrors {
				rejections = append(rejections, HealthSampleRejection{
					UUID:   input.UUID,
					Type:   input.Type,
					Reason: err.Error(),
				})
			}
			continue
		}

		samples = append(samples, sample)
		if current, ok := latestEnd[sample.MetricType]; !ok || sample.EndTime.After(current) {
			latestEnd[sample.MetricType] = sample.EndTime
		}
	}

	stored, err := databaseRepo.CreateHealthSamples(c, samples)
	if err != nil {
		logger.Errorln("health samples: store batch:", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to store health samples"})
		return
	}

	// Anchors are persisted after the samples they describe. If this fails the samples are still
	// stored, and the app simply re-sends from its previous anchor next time, which dedups.
	for metricType, anchor := range req.Anchors {
		metricType = strings.TrimSpace(metricType)
		if metricType == "" {
			continue
		}
		state := models.HealthSyncState{
			DeviceID:     deviceID,
			DeviceName:   req.Device.Name,
			MetricType:   metricType,
			Anchor:       anchor,
			LastSyncedAt: time.Now(),
		}
		if end, ok := latestEnd[metricType]; ok {
			endCopy := end
			state.LastSampleEndTime = &endCopy
		}
		if err := databaseRepo.UpsertHealthSyncState(c, &state); err != nil {
			logger.Warnf("health samples: could not record sync anchor for %s: %v", metricType, err)
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": HealthSampleIngestResponse{
		Received:   len(req.Samples),
		Accepted:   len(samples),
		Stored:     stored,
		Duplicates: int64(len(samples)) - stored,
		Rejected:   rejected,
		Errors:     rejections,
	}})
}

// buildHealthSample validates and normalizes one incoming sample.
//
// A type identifier this server does not recognize is stored verbatim with an empty metric type rather
// than rejected, so an app that ships a new metric first does not lose data. A type that IS recognized
// must arrive with a unit or category value this server accepts, because a heart rate whose unit might
// be beats per hour is worse than no heart rate at all.
func buildHealthSample(input HealthSampleInput) (models.HealthSample, error) {
	sample := models.HealthSample{}

	externalUUID := strings.TrimSpace(input.UUID)
	if externalUUID == "" {
		return sample, errors.New("uuid is required")
	}
	hkType := strings.TrimSpace(input.Type)
	if hkType == "" {
		return sample, errors.New("type is required")
	}
	if input.Start.IsZero() {
		return sample, errors.New("start is required")
	}

	end := input.End
	if end.IsZero() {
		// An instantaneous sample legitimately has no distinct end.
		end = input.Start
	}
	if end.Before(input.Start) {
		return sample, errors.New("end is before start")
	}

	sample.ExternalUUID = externalUUID
	sample.HKType = hkType
	sample.StartTime = input.Start.UTC()
	sample.EndTime = end.UTC()
	sample.SourceName = input.SourceName
	sample.SourceBundleID = input.SourceBundleID
	sample.DeviceName = input.DeviceName
	sample.CorrelationUUID = input.CorrelationUUID

	metric, known := healthkit.Lookup(hkType)
	if !known {
		sample.ValueNum = input.Value
		sample.Unit = strings.TrimSpace(input.Unit)
		sample.ValueText = strings.TrimSpace(input.ValueText)
	} else {
		sample.MetricType = metric.MetricType

		switch metric.Kind {
		case healthkit.KindQuantity:
			if input.Value == nil {
				return sample, fmt.Errorf("%s requires a numeric value", metric.MetricType)
			}
			unit, ok := metric.NormalizeUnit(input.Unit)
			if !ok {
				return sample, fmt.Errorf("%s expects unit %q, got %q", metric.MetricType, metric.CanonicalUnit, input.Unit)
			}
			sample.ValueNum = input.Value
			sample.Unit = unit
		case healthkit.KindCategory:
			value, ok := metric.NormalizeCategoryValue(input.ValueText)
			if !ok {
				return sample, fmt.Errorf("%s does not accept value %q", metric.MetricType, input.ValueText)
			}
			sample.ValueText = value
		}
	}

	if len(input.Metadata) > 0 {
		encoded, err := json.Marshal(input.Metadata)
		if err != nil {
			return sample, fmt.Errorf("metadata is not serializable: %w", err)
		}
		sample.Metadata = datatypes.JSON(encoded)
	}

	return sample, nil
}

// ListHealthSamples returns a bounded page of the user's Apple Health samples. It exists so ingestion
// can be verified before any UI exists, and it is paginated by construction: this table grows by a row
// every few minutes.
func ListHealthSamples(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	queryOptions := models.HealthSampleQueryOptions{
		MetricTypes:   parseMetricTypes(c.QueryArray("metric_type")),
		SortAscending: strings.EqualFold(c.Query("sort"), "asc"),
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
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "limit must be an integer"})
			return
		}
		queryOptions.Limit = parsed
	}
	if raw := strings.TrimSpace(c.Query("offset")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "offset must be an integer"})
			return
		}
		queryOptions.Offset = parsed
	}

	samples, total, err := databaseRepo.ListHealthSamples(c, queryOptions)
	if err != nil {
		logger.Errorln("health samples: list:", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to list health samples"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"total":   total,
		"count":   len(samples),
		"offset":  queryOptions.Offset,
		"samples": samples,
	}})
}

// parseMetricTypes accepts both repeated parameters and comma-separated lists, so
// ?metric_type=heart_rate&metric_type=step_count and ?metric_type=heart_rate,step_count agree.
func parseMetricTypes(raw []string) []string {
	metricTypes := make([]string, 0, len(raw))
	for _, entry := range raw {
		for _, part := range strings.Split(entry, ",") {
			if part = strings.TrimSpace(part); part != "" {
				metricTypes = append(metricTypes, part)
			}
		}
	}
	return metricTypes
}

// GetHealthSyncState returns the stored resume points, so a reinstalled app can continue where its
// predecessor stopped instead of re-uploading the user's history.
func GetHealthSyncState(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	states, err := databaseRepo.GetHealthSyncStates(c, strings.TrimSpace(c.Query("device_id")))
	if err != nil {
		logger.Errorln("health samples: get sync state:", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to get health sync state"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": states})
}
