package models

import (
	"time"

	"github.com/google/uuid"
)

// AccessEvent is one row of the patient-visible access log (#563): who accessed which category of a
// user's records on which day, and how many times. It exists so a patient can answer "who has looked
// at my record?" — for a PHR that is patient-facing value, not ops logging, and it is what lets the
// Epic Data Use Questionnaire answer "users can obtain a complete record of who has accessed their
// data" truthfully.
//
// Aggregated per (owner, actor, category, day) rather than one row per request: the count and the
// first/last timestamps answer the patient's question completely, while the table stays bounded at
// actors x categories x days instead of growing with every page load.
//
// Privacy stance (the #507/#512 decision carried forward): DELIBERATELY NO IP ADDRESS AND NO
// USER-AGENT. Identity and time answer the question; logging the family's own addresses on a product
// whose pitch is that nobody else holds your data would need a retention policy and a deliberate
// privacy decision. Retention of these rows: indefinite — they are the patient's own audit trail,
// they contain no clinical data, and deleting the account deletes them with everything else.
type AccessEvent struct {
	ModelBase
	// UserID is the OWNER of the records that were accessed.
	UserID uuid.UUID `json:"-" gorm:"type:uuid;uniqueIndex:idx_access_event_bucket;not null"`
	// ActorUsername is who accessed them. Today every access is the owner (or the same account on
	// another device); the column exists so proxy/family access can be attributed when it arrives.
	ActorUsername string `json:"actor_username" gorm:"uniqueIndex:idx_access_event_bucket;not null"`
	// Category is the legible kind of access ("Conditions", "Documents", "Full export", ...) derived
	// from the route — see middleware.AccessLogCategory.
	Category string `json:"category" gorm:"uniqueIndex:idx_access_event_bucket;not null"`
	// Day is the UTC calendar day, "2006-01-02". A string so the unique index is portable across
	// SQLite and Postgres.
	Day     string    `json:"day" gorm:"uniqueIndex:idx_access_event_bucket;not null"`
	Count   int64     `json:"count"`
	FirstAt time.Time `json:"first_at"`
	LastAt  time.Time `json:"last_at"`
}

func (AccessEvent) TableName() string { return "access_events" }
