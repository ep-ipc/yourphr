package models

import (
	"errors"
	"testing"
	"time"

	sourceModels "github.com/fastenhealth/fasten-onprem/backend/pkg/sources/clients/models"
	sourcePkg "github.com/fastenhealth/fasten-onprem/backend/pkg/sources/pkg"
)

func TestCountResourcesByType(t *testing.T) {
	got := CountResourcesByType([]string{
		"Patient/p1",
		"Condition/c1",
		"Condition/c2",
		"DocumentReference/d1",
		"not-a-ref",
		"",
	})
	if got["Patient"] != 1 || got["Condition"] != 2 || got["DocumentReference"] != 1 {
		t.Fatalf("CountResourcesByType = %#v", got)
	}
	if CountResourcesByType(nil) != nil {
		t.Fatal("nil input should return nil map")
	}
}

func TestBuildSyncJobSummary_Success(t *testing.T) {
	started := time.Now().Add(-2 * time.Second)
	ended := time.Now()
	src := &SourceCredential{
		Environment:  "sandbox",
		PlatformType: sourcePkg.PlatformType("cerner"),
	}
	sum := sourceModels.UpsertSummary{
		TotalResources:   3,
		UpdatedResources: []string{"Patient/1", "Condition/a", "Condition/b"},
	}
	got := BuildSyncJobSummary(src, sum, &started, ended, nil)
	if got.Outcome != SyncJobOutcomeSuccess {
		t.Fatalf("outcome = %q", got.Outcome)
	}
	if got.TotalResources != 3 || got.ByType["Condition"] != 2 {
		t.Fatalf("counts = %#v", got)
	}
	if got.DurationMs < 1000 {
		t.Fatalf("duration_ms = %d, want ~2000+", got.DurationMs)
	}
	if got.Environment != "sandbox" || got.PlatformType != "cerner" {
		t.Fatalf("labels = %#v", got)
	}
	if got.ErrorMessage != "" {
		t.Fatalf("error_message should be empty on success")
	}
}

func TestBuildSyncJobSummary_PartialAndFailed(t *testing.T) {
	ended := time.Now()
	err := errors.New("fetching patient data failed after importing 5 resource(s): boom")

	partial := BuildSyncJobSummary(nil, sourceModels.UpsertSummary{TotalResources: 5}, nil, ended, err)
	if partial.Outcome != SyncJobOutcomePartial || partial.ErrorMessage == "" {
		t.Fatalf("partial = %#v", partial)
	}

	failed := BuildSyncJobSummary(nil, sourceModels.UpsertSummary{}, nil, ended, err)
	if failed.Outcome != SyncJobOutcomeFailed {
		t.Fatalf("failed outcome = %q", failed.Outcome)
	}

	// missing environment defaults to production
	src := &SourceCredential{}
	s := BuildSyncJobSummary(src, sourceModels.UpsertSummary{}, nil, ended, nil)
	if s.Environment != "production" {
		t.Fatalf("default environment = %q", s.Environment)
	}
}
