package database

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Apple Health / HealthKit ingestion from the iPhone companion app.

// healthSampleInsertBatchSize keeps each INSERT under SQLite's variable limit (SQLITE_MAX_VARIABLE_NUMBER
// defaults to 32766 in modern builds, 999 in older ones). HealthSample has ~17 columns, so 250 rows per
// statement stays clear of both.
const healthSampleInsertBatchSize = 250

// CreateHealthSamples stores samples for the authenticated user and returns how many rows were actually
// inserted. Samples already present are skipped on their (user_id, external_uuid) unique index, so a
// retried push, or one whose window overlaps the previous push, is a no-op rather than a duplicate.
// This is the property the FHIR patient-entry path lacks: it mints a fresh server-side UUID per call,
// so a client that retries gets two rows for one reading.
func (gr *GormRepository) CreateHealthSamples(ctx context.Context, samples []models.HealthSample) (int64, error) {
	currentUser, currentUserErr := gr.GetCurrentUser(ctx)
	if currentUserErr != nil {
		return 0, currentUserErr
	}

	if len(samples) == 0 {
		return 0, nil
	}

	//SECURITY: overwrite any user_id the caller supplied; ownership comes from the session, not the body.
	for i := range samples {
		samples[i].UserID = currentUser.ID
	}

	var stored int64
	err := gr.GormClient.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.
			Clauses(clause.OnConflict{DoNothing: true}).
			CreateInBatches(samples, healthSampleInsertBatchSize)
		if result.Error != nil {
			return result.Error
		}
		stored = result.RowsAffected
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("failed to store health samples: %w", err)
	}

	return stored, nil
}

// ListHealthSamples returns a bounded page of the authenticated user's samples plus the total number
// matching the filter. The limit is always clamped: this table gains a row every few minutes, so the
// unbounded read that GetVitalsRecognized performs over Observations is not an option here.
func (gr *GormRepository) ListHealthSamples(ctx context.Context, queryOptions models.HealthSampleQueryOptions) ([]models.HealthSample, int64, error) {
	currentUser, currentUserErr := gr.GetCurrentUser(ctx)
	if currentUserErr != nil {
		return nil, 0, currentUserErr
	}

	var total int64
	if err := gr.healthSampleQuery(ctx, currentUser.ID, queryOptions).Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("failed to count health samples: %w", err)
	}

	limit := queryOptions.Limit
	if limit <= 0 {
		limit = models.HealthSampleDefaultLimit
	}
	if limit > models.HealthSampleMaxLimit {
		limit = models.HealthSampleMaxLimit
	}
	offset := queryOptions.Offset
	if offset < 0 {
		offset = 0
	}

	order := "start_time DESC"
	if queryOptions.SortAscending {
		order = "start_time ASC"
	}

	var samples []models.HealthSample
	result := gr.healthSampleQuery(ctx, currentUser.ID, queryOptions).
		Order(order).
		Limit(limit).
		Offset(offset).
		Find(&samples)
	if result.Error != nil {
		return nil, 0, fmt.Errorf("failed to list health samples: %w", result.Error)
	}

	return samples, total, nil
}

type healthMetricAggRow struct {
	MetricKey string
	Latest    string
	Earliest  string
	Cnt       int64
}

// SummarizeHealthMetrics returns one row per metric the user has ever stored: the latest sample,
// the earliest, and the count. Unrecognized HealthKit types (empty metric_type) group on hk_type so
// they still appear in the catalog.
func (gr *GormRepository) SummarizeHealthMetrics(ctx context.Context) ([]models.HealthMetricSummary, error) {
	currentUser, currentUserErr := gr.GetCurrentUser(ctx)
	if currentUserErr != nil {
		return nil, currentUserErr
	}

	var aggs []healthMetricAggRow
	aggQuery := gr.GormClient.WithContext(ctx).
		Model(&models.HealthSample{}).
		Select(`CASE WHEN metric_type = '' OR metric_type IS NULL THEN hk_type ELSE metric_type END as metric_key, MAX(start_time) as latest, MIN(start_time) as earliest, COUNT(*) as cnt`).
		Where("user_id = ?", currentUser.ID).
		Group("metric_key").
		Order("latest DESC")
	if err := aggQuery.Scan(&aggs).Error; err != nil {
		return nil, fmt.Errorf("failed to summarize health metrics: %w", err)
	}

	summaries := make([]models.HealthMetricSummary, 0, len(aggs))
	for _, agg := range aggs {
		var sample models.HealthSample
		latestQuery := gr.GormClient.WithContext(ctx).
			Where("user_id = ? AND start_time = ?", currentUser.ID, agg.Latest)
		if strings.HasPrefix(agg.MetricKey, "HK") {
			latestQuery = latestQuery.Where("hk_type = ?", agg.MetricKey)
		} else {
			latestQuery = latestQuery.Where("metric_type = ?", agg.MetricKey)
		}
		if err := latestQuery.Order("id DESC").First(&sample).Error; err != nil {
			return nil, fmt.Errorf("failed to load latest sample for %s: %w", agg.MetricKey, err)
		}
		summaries = append(summaries, models.HealthMetricSummary{
			MetricType:  sample.MetricType,
			HKType:      sample.HKType,
			Unit:        sample.Unit,
			ValueNum:    sample.ValueNum,
			ValueText:   sample.ValueText,
			LatestAt:    sample.StartTime,
			EarliestAt:  parseSQLiteTime(agg.Earliest),
			SampleCount: agg.Cnt,
			SourceName:  sample.SourceName,
			DeviceName:  sample.DeviceName,
		})
	}
	return summaries, nil
}

type healthSeriesBucketRow struct {
	Bucket int64
	AvgV   float64
}

type healthStageRow struct {
	Date  string
	Stage string
	Hours float64
}

type healthStatsRow struct {
	Min *float64
	Max *float64
	Avg *float64
	N   int64
}

// QueryHealthSeries returns a chart-sized read of one metric in a time window. Mode is chosen by the
// UI registry (points / day / stages); unknown types use points and still chart if they have value_num.
func (gr *GormRepository) QueryHealthSeries(ctx context.Context, queryOptions models.HealthSeriesQueryOptions) (models.HealthSeries, error) {
	currentUser, currentUserErr := gr.GetCurrentUser(ctx)
	if currentUserErr != nil {
		return models.HealthSeries{}, currentUserErr
	}

	maxPoints := queryOptions.MaxPoints
	if maxPoints <= 0 {
		maxPoints = models.HealthSeriesDefaultPoints
	}
	if maxPoints > models.HealthSeriesMaxPoints {
		maxPoints = models.HealthSeriesMaxPoints
	}

	mode := queryOptions.Mode
	if mode == "" {
		mode = models.HealthSeriesModePoints
	}

	query := gr.healthSeriesQuery(ctx, currentUser.ID, queryOptions)

	series := models.HealthSeries{
		HKType: queryOptions.HKType,
	}
	if len(queryOptions.MetricTypes) > 0 {
		series.MetricType = queryOptions.MetricTypes[0]
	}

	switch mode {
	case models.HealthSeriesModeDay:
		return gr.queryHealthSeriesDay(query, series)
	case models.HealthSeriesModeStages:
		return gr.queryHealthSeriesStages(query, series)
	case models.HealthSeriesModePoints:
		return gr.queryHealthSeriesPoints(query, series, maxPoints)
	default:
		return models.HealthSeries{}, fmt.Errorf("unknown health series mode %q", mode)
	}
}

func (gr *GormRepository) healthSeriesQuery(ctx context.Context, userID uuid.UUID, queryOptions models.HealthSeriesQueryOptions) *gorm.DB {
	query := gr.GormClient.WithContext(ctx).
		Model(&models.HealthSample{}).
		Where("user_id = ?", userID)

	if queryOptions.HKType != "" {
		query = query.Where("hk_type = ?", queryOptions.HKType)
	} else if len(queryOptions.MetricTypes) > 0 {
		query = query.Where("metric_type IN ?", queryOptions.MetricTypes)
	}
	if queryOptions.StartTimeAfter != nil {
		query = query.Where("start_time >= ?", *queryOptions.StartTimeAfter)
	}
	if queryOptions.StartTimeBefore != nil {
		query = query.Where("start_time < ?", *queryOptions.StartTimeBefore)
	}
	return query
}

func (gr *GormRepository) queryHealthSeriesPoints(query *gorm.DB, series models.HealthSeries, maxPoints int) (models.HealthSeries, error) {
	var stats healthStatsRow
	if err := query.Session(&gorm.Session{}).
		Select("MIN(value_num) as min, MAX(value_num) as max, AVG(value_num) as avg, COUNT(*) as n").
		Scan(&stats).Error; err != nil {
		return models.HealthSeries{}, fmt.Errorf("failed to summarize health series: %w", err)
	}
	series.Total = stats.N
	if stats.N > 0 && (stats.Min != nil || stats.Max != nil || stats.Avg != nil) {
		series.Stats = &models.HealthSeriesStats{Min: stats.Min, Max: stats.Max, Avg: stats.Avg}
	}

	if stats.N == 0 {
		return series, nil
	}

	var unitRow models.HealthSample
	if err := query.Session(&gorm.Session{}).Select("unit").Limit(1).Find(&unitRow).Error; err == nil {
		series.Unit = unitRow.Unit
	}

	if stats.N <= int64(maxPoints) {
		var samples []models.HealthSample
		if err := query.Session(&gorm.Session{}).
			Where("value_num IS NOT NULL").
			Order("start_time ASC").
			Limit(maxPoints).
			Find(&samples).Error; err != nil {
			return models.HealthSeries{}, fmt.Errorf("failed to list health series: %w", err)
		}
		series.Points = make([]models.HealthSeriesPoint, 0, len(samples))
		for _, sample := range samples {
			if sample.ValueNum == nil {
				continue
			}
			series.Points = append(series.Points, models.HealthSeriesPoint{T: sample.StartTime, V: *sample.ValueNum})
		}
		return series, nil
	}

	// Bucket by unix seconds so a 90-day heart-rate series stays at MaxPoints. strftime is SQLite;
	// this is the only working backend.
	var span struct {
		First string
		Last  string
	}
	if err := query.Session(&gorm.Session{}).
		Select("MIN(start_time) as first, MAX(start_time) as last").
		Scan(&span).Error; err != nil {
		return models.HealthSeries{}, fmt.Errorf("failed to bound health series: %w", err)
	}
	first := parseSQLiteTime(span.First)
	last := parseSQLiteTime(span.Last)
	if first.IsZero() || last.IsZero() {
		return models.HealthSeries{}, fmt.Errorf("failed to bound health series: unparsed window %q – %q", span.First, span.Last)
	}
	duration := last.Sub(first)
	if duration <= 0 {
		duration = time.Second
	}
	bucketSeconds := int64(duration / time.Duration(maxPoints) / time.Second)
	if bucketSeconds < 1 {
		bucketSeconds = 1
	}

	var buckets []healthSeriesBucketRow
	if err := query.Session(&gorm.Session{}).
		Select("CAST(strftime('%s', start_time) / ? AS INTEGER) * ? as bucket, AVG(value_num) as avg_v", bucketSeconds, bucketSeconds).
		Where("value_num IS NOT NULL").
		Group("bucket").
		Order("bucket ASC").
		Scan(&buckets).Error; err != nil {
		return models.HealthSeries{}, fmt.Errorf("failed to downsample health series: %w", err)
	}
	series.Downsampled = true
	series.Points = make([]models.HealthSeriesPoint, 0, len(buckets))
	for _, bucket := range buckets {
		series.Points = append(series.Points, models.HealthSeriesPoint{
			T: time.Unix(bucket.Bucket, 0).UTC(),
			V: bucket.AvgV,
		})
	}
	return series, nil
}

func (gr *GormRepository) queryHealthSeriesDay(query *gorm.DB, series models.HealthSeries) (models.HealthSeries, error) {
	var rows []models.HealthDailyBucket
	if err := query.Session(&gorm.Session{}).
		Select("date(start_time) as date, COALESCE(SUM(value_num), 0) as value").
		Group("date(start_time)").
		Order("date ASC").
		Scan(&rows).Error; err != nil {
		return models.HealthSeries{}, fmt.Errorf("failed to sum daily health series: %w", err)
	}

	var total int64
	if err := query.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		return models.HealthSeries{}, fmt.Errorf("failed to count daily health series: %w", err)
	}
	series.Total = total

	var unitRow models.HealthSample
	if err := query.Session(&gorm.Session{}).Select("unit").Limit(1).Find(&unitRow).Error; err == nil {
		series.Unit = unitRow.Unit
	}

	series.Daily = rows
	return series, nil
}

func (gr *GormRepository) queryHealthSeriesStages(query *gorm.DB, series models.HealthSeries) (models.HealthSeries, error) {
	var rows []healthStageRow
	if err := query.Session(&gorm.Session{}).
		Select("date(start_time, '-12 hours') as date, value_text as stage, SUM((julianday(end_time) - julianday(start_time)) * 24.0) as hours").
		Where("value_text != ''").
		Group("date(start_time, '-12 hours'), value_text").
		Order("date ASC").
		Scan(&rows).Error; err != nil {
		return models.HealthSeries{}, fmt.Errorf("failed to group sleep stages: %w", err)
	}

	var total int64
	if err := query.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		return models.HealthSeries{}, fmt.Errorf("failed to count sleep stages: %w", err)
	}
	series.Total = total

	byDate := map[string]*models.HealthStageNight{}
	order := make([]string, 0)
	for _, row := range rows {
		night, ok := byDate[row.Date]
		if !ok {
			night = &models.HealthStageNight{Date: row.Date, Stages: map[string]float64{}}
			byDate[row.Date] = night
			order = append(order, row.Date)
		}
		night.Stages[row.Stage] = row.Hours
	}
	series.Nights = make([]models.HealthStageNight, 0, len(order))
	for _, date := range order {
		series.Nights = append(series.Nights, *byDate[date])
	}
	return series, nil
}

// healthSampleQuery builds a fresh filtered query. It is called once per statement rather than shared,
// because reusing one *gorm.DB for both the count and the page would accumulate the conditions twice.
func (gr *GormRepository) healthSampleQuery(ctx context.Context, userID uuid.UUID, queryOptions models.HealthSampleQueryOptions) *gorm.DB {
	query := gr.GormClient.WithContext(ctx).
		Model(&models.HealthSample{}).
		Where("user_id = ?", userID)

	if len(queryOptions.MetricTypes) > 0 {
		query = query.Where("metric_type IN ?", queryOptions.MetricTypes)
	}
	if queryOptions.HKType != "" {
		query = query.Where("hk_type = ?", queryOptions.HKType)
	}
	if queryOptions.StartTimeAfter != nil {
		query = query.Where("start_time >= ?", *queryOptions.StartTimeAfter)
	}
	if queryOptions.StartTimeBefore != nil {
		query = query.Where("start_time < ?", *queryOptions.StartTimeBefore)
	}

	return query
}

// UpsertHealthSyncState records the client's resume point for one device and metric, replacing any
// previous row for that combination.
func (gr *GormRepository) UpsertHealthSyncState(ctx context.Context, state *models.HealthSyncState) error {
	currentUser, currentUserErr := gr.GetCurrentUser(ctx)
	if currentUserErr != nil {
		return currentUserErr
	}

	if state.DeviceID == "" || state.MetricType == "" {
		return fmt.Errorf("health sync state requires both a device id and a metric type")
	}

	//SECURITY: ownership comes from the session, not the body.
	state.UserID = currentUser.ID
	if state.LastSyncedAt.IsZero() {
		state.LastSyncedAt = time.Now()
	}

	result := gr.GormClient.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "user_id"},
				{Name: "device_id"},
				{Name: "metric_type"},
			},
			DoUpdates: clause.AssignmentColumns([]string{
				"anchor",
				"last_sample_end_time",
				"last_synced_at",
				"device_name",
				"updated_at",
			}),
		}).
		Create(state)
	if result.Error != nil {
		return fmt.Errorf("failed to store health sync state: %w", result.Error)
	}

	return nil
}

// GetHealthSyncStates returns the authenticated user's resume points, optionally narrowed to one
// device. An empty deviceID returns every device, which is how a new install discovers what its
// predecessor already uploaded.
func (gr *GormRepository) GetHealthSyncStates(ctx context.Context, deviceID string) ([]models.HealthSyncState, error) {
	currentUser, currentUserErr := gr.GetCurrentUser(ctx)
	if currentUserErr != nil {
		return nil, currentUserErr
	}

	query := gr.GormClient.WithContext(ctx).
		Where("user_id = ?", currentUser.ID)
	if deviceID != "" {
		query = query.Where("device_id = ?", deviceID)
	}

	var states []models.HealthSyncState
	result := query.Order("device_id ASC, metric_type ASC").Find(&states)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get health sync states: %w", result.Error)
	}

	return states, nil
}

// parseSQLiteTime reads a timestamp from a SQLite aggregate. GORM maps model columns onto time.Time
// itself; MAX/MIN into a DTO does not, so the driver hands back the stored string.
func parseSQLiteTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999+00:00",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05+00:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05Z",
		"2006-01-02 15:04:05.999999999-0700",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed.UTC()
		}
	}
	return time.Time{}
}
