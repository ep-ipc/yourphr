package database

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
)

// BackupHealthStatus is durable status for the last scheduled (or recorded) backup attempt (#434).
// Written by the backup worker; read by Admin Database / dashboard so operators see failures
// without tailing logs.
type BackupHealthStatus struct {
	// OK is true when the last completed attempt succeeded (or no failure has been recorded yet
	// and a success exists). Computed for the API from consecutive failures + last success.
	OK bool `json:"ok"`

	ScheduleEnabled bool   `json:"schedule_enabled"`
	Destination     string `json:"destination,omitempty"`

	LastSuccessAt    string `json:"last_success_at,omitempty"`   // RFC3339 UTC
	LastSuccessPath  string `json:"last_success_path,omitempty"` // full path of last good file
	LastAttemptAt    string `json:"last_attempt_at,omitempty"`   // RFC3339 UTC
	LastError        string `json:"last_error,omitempty"`        // empty after a success
	ConsecutiveFails int    `json:"consecutive_failures"`
	DaysSinceSuccess *int   `json:"days_since_success,omitempty"` // nil if never succeeded
	FailingStale     bool   `json:"failing_stale"`                // enabled schedule and overdue
	// HealthySummary is a short operator string for badges/banners.
	HealthySummary string `json:"summary"`
}

// backupHealth is the on-disk shape (subset of API fields).
type backupHealth struct {
	LastSuccessAt    string `json:"last_success_at,omitempty"`
	LastSuccessPath  string `json:"last_success_path,omitempty"`
	LastAttemptAt    string `json:"last_attempt_at,omitempty"`
	LastError        string `json:"last_error,omitempty"`
	ConsecutiveFails int    `json:"consecutive_failures"`
}

func backupHealthPath(appConfig config.Interface) string {
	return filepath.Join(dbDirFromConfig(appConfig), ".backup_health.json")
}

func loadBackupHealthRaw(appConfig config.Interface) backupHealth {
	var h backupHealth
	if b, err := os.ReadFile(backupHealthPath(appConfig)); err == nil {
		_ = json.Unmarshal(b, &h)
	}
	return h
}

func saveBackupHealthRaw(appConfig config.Interface, h backupHealth) error {
	b, err := json.MarshalIndent(h, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(backupHealthPath(appConfig), b, 0o600)
}

// RecordBackupSuccess updates durable health after a successful backup (scheduled or manual).
func RecordBackupSuccess(appConfig config.Interface, fullPath string) {
	now := time.Now().UTC().Format(time.RFC3339)
	h := loadBackupHealthRaw(appConfig)
	h.LastSuccessAt = now
	h.LastSuccessPath = fullPath
	h.LastAttemptAt = now
	h.LastError = ""
	h.ConsecutiveFails = 0
	_ = saveBackupHealthRaw(appConfig, h)
}

// RecordBackupFailure updates durable health after a failed attempt. Returns the new consecutive
// count so the worker can rate-limit log lines (#434).
func RecordBackupFailure(appConfig config.Interface, errMsg string) int {
	now := time.Now().UTC().Format(time.RFC3339)
	h := loadBackupHealthRaw(appConfig)
	h.LastAttemptAt = now
	h.LastError = errMsg
	h.ConsecutiveFails++
	_ = saveBackupHealthRaw(appConfig, h)
	return h.ConsecutiveFails
}

// LoadBackupHealthStatus builds the API-facing health snapshot for Admin UI.
func LoadBackupHealthStatus(appConfig config.Interface) BackupHealthStatus {
	s := LoadBackupSettings(appConfig)
	dest := ResolveDestination(appConfig, s)
	h := loadBackupHealthRaw(appConfig)

	// Prefer newest file on disk as success evidence when health file is empty (pre-#434 installs).
	if h.LastSuccessAt == "" {
		if files := ListBackups(dest); len(files) > 0 {
			h.LastSuccessAt = files[0].Modified
			h.LastSuccessPath = filepath.Join(dest, files[0].Name)
		}
	}

	out := BackupHealthStatus{
		ScheduleEnabled:  s.Enabled,
		Destination:      dest,
		LastSuccessAt:    h.LastSuccessAt,
		LastSuccessPath:  h.LastSuccessPath,
		LastAttemptAt:    h.LastAttemptAt,
		LastError:        h.LastError,
		ConsecutiveFails: h.ConsecutiveFails,
	}

	if h.LastSuccessAt != "" {
		if t, err := time.Parse(time.RFC3339, h.LastSuccessAt); err == nil {
			days := int(time.Since(t).Hours() / 24)
			out.DaysSinceSuccess = &days
		}
	}

	// Overdue: schedule on, and no success within ~2 days (daily) or ~8 days (weekly).
	overdueDays := 2
	if strings.EqualFold(s.Days, "weekly") {
		overdueDays = 8
	}
	out.FailingStale = s.Enabled && (out.DaysSinceSuccess == nil ||
		*out.DaysSinceSuccess >= overdueDays ||
		(h.ConsecutiveFails > 0 && h.LastError != ""))

	switch {
	case h.ConsecutiveFails > 0 && h.LastError != "":
		out.OK = false
		out.HealthySummary = "Scheduled backup failing"
	case s.Enabled && out.DaysSinceSuccess == nil:
		out.OK = false
		out.HealthySummary = "No successful backup yet"
	case s.Enabled && out.DaysSinceSuccess != nil && *out.DaysSinceSuccess >= overdueDays:
		out.OK = false
		out.HealthySummary = "Backup overdue"
	case !s.Enabled:
		out.OK = true
		out.HealthySummary = "Scheduled backups disabled"
	default:
		out.OK = true
		out.HealthySummary = "Backup healthy"
	}
	return out
}
