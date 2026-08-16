package database

import (
	"context"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	sourcesPkg "github.com/fastenhealth/fasten-onprem/backend/pkg/sources/pkg"
	"github.com/sirupsen/logrus"
)

// SeedSandboxProviders upserts the known test-sandbox providers (Blue Button, Epic, …) into the
// provider catalog as `sandbox` entries, taking their credentials from `YOURPHR_SANDBOX_*` env vars
// — so the /sandbox buttons connect with zero typing and the client_secret never reaches the browser
// (#291). The env contract is deployment-agnostic: populate it however your deployment supplies env
// (docker `environment:`/`env_file:`, a bare-metal `.env_custom`, a k8s Secret, …). A provider whose
// client_id env value is empty is skipped (not configured). Idempotent — runs at every startup and
// refreshes creds from env. getenv is injectable for tests (pass os.Getenv in prod).
func SeedSandboxProviders(ctx context.Context, repo DatabaseRepository, logger *logrus.Entry, getenv func(string) string) {
	for _, s := range models.SandboxProviderSeeds() {
		// Open sandboxes (e.g. SMART Health IT) carry a fixed literal client_id and are always seeded;
		// everyone else takes their client_id from env (however the deployment supplies it) and is
		// skipped when unset.
		clientID := strings.TrimSpace(s.ClientIDLiteral)
		if clientID == "" && s.ClientIDEnv != "" {
			clientID = strings.TrimSpace(getenv(s.ClientIDEnv))
		}
		if clientID == "" {
			continue // not configured in this deployment
		}
		secret := ""
		if s.ClientSecretEnv != "" {
			secret = strings.TrimSpace(getenv(s.ClientSecretEnv))
		}
		entry := models.ProviderCatalogEntry{
			Display:              s.Display,
			Environment:          models.ProviderEnvironmentSandbox,
			ApiEndpointBaseUrl:   s.ApiEndpointBaseUrl,
			Scopes:               s.Scopes,
			PlatformType:         sourcesPkg.PlatformTypeEhr,
			ClientId:             clientID,
			ClientSecret:         secret,
			Enabled:              true,
			AuthorizeUrlOverride: s.AuthorizeUrlOverride,
		}
		if err := repo.UpsertProviderCatalogEntryByDisplay(ctx, &entry); err != nil {
			if logger != nil {
				logger.Errorf("sandbox seed: could not upsert %q: %v", s.Display, err)
			}
			continue
		}
		if logger != nil {
			logger.Infof("sandbox provider configured from env: %q", s.Display)
		}
	}
}

// SeedProductionMedicareProvider upserts the production Medicare (CMS Blue Button) catalog entry
// when YOURPHR_PROD_BLUEBUTTON_CLIENT_ID is set (#432). Secret from YOURPHR_PROD_BLUEBUTTON_CLIENT_SECRET.
// Enables the entry so patients see "Medicare" on /sources without a code change. No-op when client id
// is empty — operators can instead fill the disabled template via Admin Provider Catalog.
//
// Env names:
//   YOURPHR_PROD_BLUEBUTTON_CLIENT_ID
//   YOURPHR_PROD_BLUEBUTTON_CLIENT_SECRET
func SeedProductionMedicareProvider(ctx context.Context, repo DatabaseRepository, logger *logrus.Entry, getenv func(string) string) {
	clientID := strings.TrimSpace(getenv("YOURPHR_PROD_BLUEBUTTON_CLIENT_ID"))
	if clientID == "" {
		return
	}
	secret := strings.TrimSpace(getenv("YOURPHR_PROD_BLUEBUTTON_CLIENT_SECRET"))
	tmpl := models.ProductionMedicareCatalogTemplate()
	tmpl.ClientId = clientID
	tmpl.ClientSecret = secret
	tmpl.Enabled = true
	if err := repo.UpsertProviderCatalogEntryByDisplay(ctx, &tmpl); err != nil {
		if logger != nil {
			logger.Errorf("production Medicare seed: could not upsert: %v", err)
		}
		return
	}
	if logger != nil {
		logger.Infof("production Medicare catalog entry configured from env (display %q, patient label Medicare)", tmpl.Display)
	}
}
