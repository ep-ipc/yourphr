// Package _20260819100000 creates access_events, the patient-visible access log (#563).
//
// A dated snapshot of the model rather than a reference to models.AccessEvent, following the
// convention in this directory: a migration must keep describing the schema as it was when it ran,
// even after the live model moves on.
package _20260819100000

import (
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/google/uuid"
)

type AccessEvent struct {
	models.ModelBase
	UserID        uuid.UUID `gorm:"type:uuid;uniqueIndex:idx_access_event_bucket;not null"`
	ActorUsername string    `gorm:"uniqueIndex:idx_access_event_bucket;not null"`
	Category      string    `gorm:"uniqueIndex:idx_access_event_bucket;not null"`
	Day           string    `gorm:"uniqueIndex:idx_access_event_bucket;not null"`
	Count         int64
	FirstAt       time.Time
	LastAt        time.Time
}

func (AccessEvent) TableName() string { return "access_events" }
