package models

import (
	"strings"
	"time"

	sourceModels "github.com/fastenhealth/fasten-sources/clients/models"
)

// SyncJobOutcome is the operator-facing result of a background SMART/sync job (#441).
type SyncJobOutcome string

const (
	SyncJobOutcomeSuccess SyncJobOutcome = "success"
	SyncJobOutcomePartial SyncJobOutcome = "partial" // resources imported, but SyncAll returned an error
	SyncJobOutcomeFailed  SyncJobOutcome = "failed"  // no usable progress (or empty + error)
)

// SyncJobSummary is durable structured metrics stored on BackgroundJobSyncData when a sync finishes.
// Keep labels low-cardinality; do not store every resource id here (#441).
type SyncJobSummary struct {
	Outcome        SyncJobOutcome  `json:"outcome"`
	DurationMs     int64           `json:"duration_ms"`
	TotalResources int             `json:"total_resources"`
	ByType         map[string]int  `json:"by_type,omitempty"`
	Environment    string          `json:"environment,omitempty"`
	PlatformType   string          `json:"platform_type,omitempty"`
	ErrorMessage   string          `json:"error_message,omitempty"`
}

// CountResourcesByType tallies UpsertSummary.UpdatedResources entries of the form "Type/id".
func CountResourcesByType(updated []string) map[string]int {
	if len(updated) == 0 {
		return nil
	}
	byType := make(map[string]int)
	for _, entry := range updated {
		typ, _, ok := strings.Cut(entry, "/")
		if !ok || typ == "" {
			continue
		}
		byType[typ]++
	}
	if len(byType) == 0 {
		return nil
	}
	return byType
}

// BuildSyncJobSummary builds the job summary from source + SyncAll result + wall clock.
// started should be LockedTime (or CreatedAt) when the job began.
func BuildSyncJobSummary(
	source *SourceCredential,
	summary sourceModels.UpsertSummary,
	started *time.Time,
	ended time.Time,
	syncErr error,
) SyncJobSummary {
	out := SyncJobSummary{
		TotalResources: summary.TotalResources,
		ByType:         CountResourcesByType(summary.UpdatedResources),
	}
	if started != nil && !started.IsZero() {
		out.DurationMs = ended.Sub(*started).Milliseconds()
		if out.DurationMs < 0 {
			out.DurationMs = 0
		}
	}
	if source != nil {
		out.Environment = source.Environment
		if out.Environment == "" {
			out.Environment = "production"
		}
		out.PlatformType = string(source.PlatformType)
	}
	if syncErr != nil {
		out.ErrorMessage = syncErr.Error()
		if summary.TotalResources > 0 {
			out.Outcome = SyncJobOutcomePartial
		} else {
			out.Outcome = SyncJobOutcomeFailed
		}
	} else {
		out.Outcome = SyncJobOutcomeSuccess
	}
	return out
}
