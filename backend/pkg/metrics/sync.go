// Package metrics holds process-level observability for the main YourPHR app (#441).
// Prometheus text exposition is hand-rolled (stdlib only), matching the OAuth relay.
// The scrape server is opt-in via config (metrics.enabled); bind is cluster-internal only.
package metrics

import (
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
)

// SyncRegistry accumulates counters/histograms for completed background sync jobs.
type SyncRegistry struct {
	mu sync.Mutex

	// jobsTotal[outcome][platform][environment]
	jobsTotal map[string]map[string]map[string]int64
	// resourcesTotal[resource_type]
	resourcesTotal map[string]int64
	// duration histogram (seconds) — fixed buckets
	durationBuckets []float64
	durationCounts  []int64
	durationSum     float64
	durationCount   int64
}

// DefaultDurationBuckets is a coarse histogram suitable for multi-minute Cerner imports.
var DefaultDurationBuckets = []float64{1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200}

// Global is the process-wide registry (nil-safe record helpers).
var Global = NewSyncRegistry()

func NewSyncRegistry() *SyncRegistry {
	buckets := append([]float64(nil), DefaultDurationBuckets...)
	return &SyncRegistry{
		jobsTotal:       map[string]map[string]map[string]int64{},
		resourcesTotal:  map[string]int64{},
		durationBuckets: buckets,
		durationCounts:  make([]int64, len(buckets)+1), // +1 for +Inf
	}
}

// RecordSyncJob updates Prometheus series from a finished job summary.
func (r *SyncRegistry) RecordSyncJob(s models.SyncJobSummary) {
	if r == nil {
		return
	}
	outcome := string(s.Outcome)
	if outcome == "" {
		outcome = "unknown"
	}
	platform := s.PlatformType
	if platform == "" {
		platform = "unknown"
	}
	env := s.Environment
	if env == "" {
		env = "production"
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.jobsTotal[outcome] == nil {
		r.jobsTotal[outcome] = map[string]map[string]int64{}
	}
	if r.jobsTotal[outcome][platform] == nil {
		r.jobsTotal[outcome][platform] = map[string]int64{}
	}
	r.jobsTotal[outcome][platform][env]++

	for typ, n := range s.ByType {
		if typ == "" || n <= 0 {
			continue
		}
		r.resourcesTotal[typ] += int64(n)
	}

	sec := float64(s.DurationMs) / 1000.0
	if sec < 0 {
		sec = 0
	}
	r.durationSum += sec
	r.durationCount++
	placed := false
	for i, bound := range r.durationBuckets {
		if sec <= bound {
			r.durationCounts[i]++
			placed = true
			break
		}
	}
	if !placed {
		r.durationCounts[len(r.durationBuckets)]++ // +Inf
	}
}

// WritePrometheus emits Prometheus text exposition v0.0.4.
func (r *SyncRegistry) WritePrometheus(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	fmt.Fprintf(w, "# HELP yourphr_sync_jobs_total Completed background sync jobs by outcome, platform, and environment.\n")
	fmt.Fprintf(w, "# TYPE yourphr_sync_jobs_total counter\n")
	for outcome, byPlat := range r.jobsTotal {
		for platform, byEnv := range byPlat {
			for env, n := range byEnv {
				fmt.Fprintf(w, "yourphr_sync_jobs_total{status=%q,platform=%q,environment=%q} %d\n",
					outcome, platform, env, n)
			}
		}
	}

	fmt.Fprintf(w, "# HELP yourphr_sync_resources_total Resources imported by FHIR type (sum across completed jobs).\n")
	fmt.Fprintf(w, "# TYPE yourphr_sync_resources_total counter\n")
	types := make([]string, 0, len(r.resourcesTotal))
	for typ := range r.resourcesTotal {
		types = append(types, typ)
	}
	sort.Strings(types)
	for _, typ := range types {
		fmt.Fprintf(w, "yourphr_sync_resources_total{resource_type=%q} %d\n", typ, r.resourcesTotal[typ])
	}

	fmt.Fprintf(w, "# HELP yourphr_sync_duration_seconds Sync job wall time in seconds.\n")
	fmt.Fprintf(w, "# TYPE yourphr_sync_duration_seconds histogram\n")
	var cum int64
	for i, bound := range r.durationBuckets {
		cum += r.durationCounts[i]
		fmt.Fprintf(w, "yourphr_sync_duration_seconds_bucket{le=%q} %d\n", formatLE(bound), cum)
	}
	cum += r.durationCounts[len(r.durationBuckets)]
	fmt.Fprintf(w, "yourphr_sync_duration_seconds_bucket{le=\"+Inf\"} %d\n", cum)
	fmt.Fprintf(w, "yourphr_sync_duration_seconds_sum %g\n", r.durationSum)
	fmt.Fprintf(w, "yourphr_sync_duration_seconds_count %d\n", r.durationCount)
}

func formatLE(v float64) string {
	// Prometheus prefers simple decimal forms
	s := fmt.Sprintf("%g", v)
	return s
}

// StartServer listens on addr (e.g. ":9091" or "127.0.0.1:0") and serves GET /metrics and GET /healthz.
// Intended for cluster-internal scrapes only. Returns the server (Addr may be updated to the bound address).
func StartServer(addr string, reg *SyncRegistry) (*http.Server, error) {
	if reg == nil {
		reg = Global
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		reg.WritePrometheus(w)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("YourPHR metrics (internal). Scrape GET /metrics\n"))
	})
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	srv := &http.Server{
		Addr:              ln.Addr().String(),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		_ = srv.Serve(ln)
	}()
	metricsServerStarted.Store(true)
	return srv, nil
}

// metricsServerStarted is set when StartServer successfully binds (diagnostics / tests).
var metricsServerStarted atomic.Bool

// ServerStarted reports whether a metrics scrape server has been started in this process.
func ServerStarted() bool { return metricsServerStarted.Load() }

// SanitizePromLabel is a tiny helper for tests.
func SanitizePromLabel(s string) string {
	return strings.ReplaceAll(s, "\"", "")
}
