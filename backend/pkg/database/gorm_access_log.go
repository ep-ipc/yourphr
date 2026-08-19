package database

import (
	"context"
	"fmt"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// RecordAccessEvent increments the (current user, category, today) bucket of the patient-visible
// access log (#563). The actor is the current user — every access today is the account itself; when
// proxy/family access exists it will pass its own actor.
//
// One UPSERT per request, keyed on the unique index, so concurrent requests cannot race a
// read-modify-write. Failures are returned rather than swallowed; the CALLER decides that logging
// must never break the read it is logging (the middleware logs the error and continues).
func (gr *GormRepository) RecordAccessEvent(ctx context.Context, category string) error {
	if category == "" {
		return fmt.Errorf("access event category cannot be empty")
	}
	currentUser, err := gr.GetCurrentUser(ctx)
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	event := models.AccessEvent{
		UserID:        currentUser.ID,
		ActorUsername: currentUser.Username,
		Category:      category,
		Day:           now.Format("2006-01-02"),
		Count:         1,
		FirstAt:       now,
		LastAt:        now,
	}

	return gr.GormClient.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "user_id"}, {Name: "actor_username"}, {Name: "category"}, {Name: "day"},
			},
			DoUpdates: clause.Assignments(map[string]interface{}{
				"count":      gorm.Expr("count + 1"),
				"last_at":    now,
				"updated_at": now,
			}),
		}).
		Create(&event).Error
}

// ListAccessEvents returns the current user's access log, newest day first. It is the "complete
// record of who has accessed data about them" the patient sees — no filtering, no editing.
func (gr *GormRepository) ListAccessEvents(ctx context.Context) ([]models.AccessEvent, error) {
	currentUser, err := gr.GetCurrentUser(ctx)
	if err != nil {
		return nil, err
	}
	events := []models.AccessEvent{}
	result := gr.GormClient.WithContext(ctx).
		Where(models.AccessEvent{UserID: currentUser.ID}).
		Order("day DESC, category ASC").
		Find(&events)
	return events, result.Error
}
