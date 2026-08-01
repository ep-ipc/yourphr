package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
)

func TestWritePrometheus_ContainsSeries(t *testing.T) {
	reg := NewSyncRegistry()
	reg.RecordSyncJob(models.SyncJobSummary{
		Outcome:        models.SyncJobOutcomeSuccess,
		DurationMs:     2500,
		TotalResources: 3,
		ByType:         map[string]int{"Patient": 1, "Condition": 2},
		Environment:    "sandbox",
		PlatformType:   "cerner",
	})
	reg.RecordSyncJob(models.SyncJobSummary{
		Outcome:        models.SyncJobOutcomeFailed,
		DurationMs:     100,
		TotalResources: 0,
		Environment:    "production",
		PlatformType:   "epic",
		ErrorMessage:   "boom",
	})

	rec := httptest.NewRecorder()
	reg.WritePrometheus(rec)
	body := rec.Body.String()
	for _, want := range []string{
		"yourphr_sync_jobs_total",
		`status="success"`,
		`platform="cerner"`,
		`environment="sandbox"`,
		"yourphr_sync_resources_total",
		`resource_type="Condition"`,
		"yourphr_sync_duration_seconds_bucket",
		"yourphr_sync_duration_seconds_count",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics output missing %q\n---\n%s", want, body)
		}
	}
}

func TestStartServer_MetricsEndpoint(t *testing.T) {
	reg := NewSyncRegistry()
	reg.RecordSyncJob(models.SyncJobSummary{
		Outcome: models.SyncJobOutcomeSuccess, DurationMs: 10, TotalResources: 1,
		ByType: map[string]int{"Patient": 1}, PlatformType: "manual", Environment: "production",
	})
	srv, err := StartServer("127.0.0.1:0", reg)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	resp, err := http.Get("http://" + srv.Addr + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "yourphr_sync_jobs_total") {
		t.Fatalf("GET /metrics body: %s", b)
	}
	if !ServerStarted() {
		t.Fatal("expected ServerStarted after StartServer")
	}
	_ = time.Second
}
