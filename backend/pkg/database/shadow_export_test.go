package database

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/event_bus"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

// TestShadowExport dumps what the GO implementation answers, so it can be compared against the
// TypeScript spike's answers for the same records (yourphr-ts-spike).
//
// This is the "shadow read-only" step of the migration plan in
// docs/planning/typescript-stack-evaluation.md: run both stacks over one corpus and diff the
// responses BEFORE anything owns a surface. It reads through GormRepository — the same code path
// the HTTP handler uses — rather than over HTTP, so it needs no session and no credentials, and it
// opens a COPY of a snapshot rather than any live database.
//
// SKIPPED unless SHADOW_DB is set, so it never runs in CI and never touches real records there:
//
//	SHADOW_DB=/path/to/copy.db SHADOW_USER=jwilleke SHADOW_OUT=/path/to/go-ids.json \
//	  go test ./backend/pkg/database/ -run TestShadowExport -v
func TestShadowExport(t *testing.T) {
	dbPath := os.Getenv("SHADOW_DB")
	if dbPath == "" {
		t.Skip("SHADOW_DB not set — this is an on-demand comparison, not a CI test")
	}
	username := os.Getenv("SHADOW_USER")
	require.NotEmpty(t, username, "SHADOW_USER must name the account whose records to read")
	outPath := os.Getenv("SHADOW_OUT")
	require.NotEmpty(t, outPath, "SHADOW_OUT must name the file to write")

	testConfig, err := config.Create()
	require.NoError(t, err)
	testConfig.SetDefault("database.location", dbPath)
	testConfig.SetDefault("database.encryption.enabled", false)
	testConfig.SetDefault("log.level", "ERROR")

	repo, err := NewRepository(testConfig, logrus.WithField("test", t.Name()), event_bus.NewNoopEventBusServer())
	require.NoError(t, err)

	// Per-user isolation is enforced from the context, exactly as it is for a real request.
	ctx := context.WithValue(context.Background(), pkg.ContextKeyTypeAuthUsername, username)

	// Ask the summary which types exist rather than guessing: the point is to compare whatever the
	// records actually contain, including types nobody wrote code for.
	summary, err := repo.GetSummary(ctx)
	require.NoError(t, err)

	out := map[string][]string{}
	total := 0
	for _, typeCount := range summary.ResourceTypeCounts {
		// The summary keys this "resource_type"; reading "source_resource_type" here silently
		// produced an empty comparison, which looked like agreement.
		resourceType, _ := typeCount["resource_type"].(string)
		if resourceType == "" {
			continue
		}
		resources, err := repo.ListResources(ctx, models.ListResourceQueryOptions{SourceResourceType: resourceType})
		require.NoError(t, err, "listing %s", resourceType)

		ids := make([]string, 0, len(resources))
		for _, resource := range resources {
			// The SOURCE resource id, which is what the spike stores as the FHIR resource id — not
			// YourPHR's internal uuid, which the TypeScript side never sees.
			ids = append(ids, resource.SourceResourceID)
		}
		out[resourceType] = ids
		total += len(ids)
	}

	encoded, err := json.Marshal(out)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(outPath, encoded, 0600))

	t.Logf("go implementation answered with %d resources across %d types -> %s", total, len(out), outPath)
}
