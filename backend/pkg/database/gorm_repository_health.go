package database

import (
	"context"
	"fmt"
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

// healthSampleQuery builds a fresh filtered query. It is called once per statement rather than shared,
// because reusing one *gorm.DB for both the count and the page would accumulate the conditions twice.
func (gr *GormRepository) healthSampleQuery(ctx context.Context, userID uuid.UUID, queryOptions models.HealthSampleQueryOptions) *gorm.DB {
	query := gr.GormClient.WithContext(ctx).
		Model(&models.HealthSample{}).
		Where("user_id = ?", userID)

	if len(queryOptions.MetricTypes) > 0 {
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
