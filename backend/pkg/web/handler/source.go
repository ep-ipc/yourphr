package handler

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/event_bus"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/relay"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/ssrf"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/sources/clients/factory"
	sourceModels "github.com/fastenhealth/fasten-onprem/backend/pkg/sources/clients/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/sources/clients/smart"
	sourceDefinitions "github.com/fastenhealth/fasten-onprem/backend/pkg/sources/definitions"
	sourcePkg "github.com/fastenhealth/fasten-onprem/backend/pkg/sources/pkg"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

// validatePublicHTTPSURL guards the user-supplied FHIR base URL against SSRF before the backend
// fetches it. It is a package var so tests can point discovery at an httptest loopback server.
// (The SMART client carries its own deeper SSRF guard, #302; loopback tests relax it via
// smart.AllowInternalHostsForTest, which also covers factory-built clients in the background sync.)
var validatePublicHTTPSURL = ssrf.ValidatePublicHTTPSURL

// SmartConnectRequest is the payload to complete a SMART on FHIR connection: the self-describing
// provider config plus the authorization code (and its PKCE verifier).
//
// The code can arrive two ways: supplied directly in Code, or fetched by the backend from the
// relay (#50) by State. Exactly one of Code/State is required; State is preferred (the code never
// touches the browser).
type SmartConnectRequest struct {
	ApiEndpointBaseUrl string `json:"api_endpoint_base_url"`
	ClientId           string `json:"client_id"`
	ClientSecret       string `json:"client_secret"` // optional — confidential-client secret (#286)
	Scopes             string `json:"scopes"`
	RedirectUri        string `json:"redirect_uri"`
	Code               string `json:"code"`
	State              string `json:"state"`
	CodeVerifier       string `json:"code_verifier"`
	Display            string `json:"display"`
}

// ConnectSource completes a SMART on FHIR connection entirely in the backend (EPIC #20, #51):
// it discovers the provider endpoints, exchanges the authorization code (with PKCE verifier) for
// tokens, stores a self-describing SourceCredential, and kicks off the initial sync. The browser
// never handles tokens. The authorization code is obtained via the relay (#50); how it arrives
// (relay poll vs direct) is the caller's concern.
func ConnectSource(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	var req SmartConnectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": fmt.Sprintf("invalid request: %s", err)})
		return
	}
	if req.ApiEndpointBaseUrl == "" || req.ClientId == "" || req.CodeVerifier == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "api_endpoint_base_url, client_id, and code_verifier are required"})
		return
	}
	// SSRF guard: the backend fetches this user-supplied URL (discovery + token exchange).
	// Reject non-public targets (metadata/loopback/LAN) before any server-side request. (#51)
	if err := validatePublicHTTPSURL(req.ApiEndpointBaseUrl); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": fmt.Sprintf("invalid api_endpoint_base_url: %s", err)})
		return
	}
	if req.Code == "" && req.State == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "one of code or state is required"})
		return
	}
	// Same server-side default as AuthorizeSource — the two must produce an identical redirect_uri
	// or the token exchange fails (#399).
	if strings.TrimSpace(req.RedirectUri) == "" {
		req.RedirectUri = relay.CallbackURL(appConfig)
	}

	// When no code is supplied directly, fetch it from the relay (#50) by state. The relay holds
	// the code for ~60s; poll for relay_poll_seconds (default 55) to absorb the redirect→connect race (#406).
	if req.Code == "" {
		relayClient, err := relay.FromConfig(appConfig)
		if err != nil {
			logger.Errorln(err)
			respondRelayNotConfigured(c, err)
			return
		}
		code, err := relayClient.PollUntil(c, req.State, time.Second, relayPollTimeout(appConfig))
		if err != nil {
			logger.Errorln(err)
			respondRelayCodeError(c, err)
			return
		}
		req.Code = code
	}

	cfg := smart.Config{
		FHIRBaseURL:  req.ApiEndpointBaseUrl,
		ClientID:     req.ClientId,
		ClientSecret: req.ClientSecret,
		Scopes:       strings.Fields(req.Scopes),
		RedirectURI:  req.RedirectUri,
	}
	ep, err := cfg.Discover(c)
	if err != nil {
		logger.Errorln(err)
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "error": fmt.Sprintf("SMART discovery failed: %s", err)})
		return
	}
	tok, err := cfg.ExchangeCode(c, ep, req.Code, req.CodeVerifier)
	if err != nil {
		logger.Errorln(err)
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "error": fmt.Sprintf("token exchange failed: %s", err)})
		return
	}
	patientId, _ := tok.Extra("patient").(string)
	if patientId == "" {
		// Some SMART servers (notably CMS Blue Button 2.0) omit the `patient` launch context from the
		// initial token response — it only appears on refresh. Resolve it from the FHIR API instead
		// (Coverage/ExplanationOfBenefit references, then /Patient).
		patientId, err = cfg.DiscoverPatientID(c, ep, tok)
		if err != nil {
			logger.Errorln(err)
			c.JSON(http.StatusBadGateway, gin.H{"success": false, "error": fmt.Sprintf("token had no patient id and could not resolve one from the FHIR API: %s", err)})
			return
		}
	}
	if patientId == "" {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "error": "could not determine patient id (no launch/patient context and /Patient returned no Patient)"})
		return
	}

	sourceCred := models.SourceCredential{
		PlatformType:       sourcePkg.PlatformTypeEhr,
		Display:            req.Display,
		ApiEndpointBaseUrl: req.ApiEndpointBaseUrl,
		ClientId:           req.ClientId,
		ClientSecret:       config.Secret(req.ClientSecret), // confidential client; persisted (json:"-") + DB-encrypted (#286)
		Scopes:             req.Scopes,
		Patient:            patientId,
		AccessToken:        config.Secret(tok.AccessToken),
		RefreshToken:       config.Secret(tok.RefreshToken),
		ExpiresAt:          tok.Expiry.Unix(),
	}
	if err := databaseRepo.CreateSource(c, &sourceCred); err != nil {
		err = fmt.Errorf("an error occurred while storing source credential: %w", err)
		logger.Errorln(err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Run the initial sync in the background so the connect request returns promptly. A large import
	// (e.g. CMS Blue Button claims for a synthetic beneficiary) can outlast a reverse-proxy read
	// timeout and surface as a 502/504 even though the detached import keeps running. The context is
	// already detached from the request; progress and errors surface on the Connected Sources list.
	bgCtx := GetBackgroundContext(c)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.Errorf("recovered from panic during initial sync of source %s: %v", sourceCred.ID, r)
			}
		}()
		if _, err := BackgroundJobSyncResources(bgCtx, logger, databaseRepo, &sourceCred); err != nil {
			logger.Errorf("initial sync failed for source %s: %v", sourceCred.ID, err)
		}
	}()
	c.JSON(http.StatusOK, gin.H{"success": true, "source": sourceCred, "data": gin.H{"status": "import_started"}})
}

// GetRelayConfig reports this deployment's effective SMART OAuth relay settings so the Connect UI
// can show the operator exactly which callback URL to register with their FHIR vendor (#399).
// It exposes only non-secret, already-public values — the callback URL is handed to every provider
// anyway. The shared secret is never returned; only whether one is configured.
func GetRelayConfig(c *gin.Context) {
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	// Describe adds PROVENANCE for each value (#402): whether it was configured, inherited from
	// relay.url, or silently fell back to the built-in default — and which config key / env var to
	// change. "My configuration is not being read at all" and "the value is wrong" look identical
	// otherwise, which is what made #399 and #397 hard to diagnose. The secret is never echoed.
	desc := relay.Describe(appConfig)

	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"callback_url": desc.CallbackURL,
		// Retained under its original name for compatibility with existing callers (#399).
		"configured": desc.SecretSet,
		"ready":      desc.Ready,
		"public_url": desc.PublicURL,
		"poll_url":   desc.PollURL,
		"secret":     desc.SecretHint,
	}})
}

// SmartAuthorizeRequest initiates a SMART on FHIR standalone-launch connection: given the
// self-describing provider config, the backend discovers the endpoints and builds the PKCE
// authorization URL. The browser opens that URL; the provider redirects to the relay's
// /callback (#50). The caller must hold the returned state + code_verifier and pass them back
// to /source/connect, which polls the relay for the code and completes the exchange (#51).
type SmartAuthorizeRequest struct {
	ApiEndpointBaseUrl string `json:"api_endpoint_base_url"`
	ClientId           string `json:"client_id"`
	Scopes             string `json:"scopes"`
	RedirectUri        string `json:"redirect_uri"`
}

// AuthorizeSource performs SMART discovery, generates a PKCE verifier + state, and returns the
// provider authorization URL (with code_challenge/state/aud) for the browser to open. It holds
// no server-side state; the caller round-trips state + code_verifier back to ConnectSource.
func AuthorizeSource(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	var req SmartAuthorizeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": fmt.Sprintf("invalid request: %s", err)})
		return
	}
	if req.ApiEndpointBaseUrl == "" || req.ClientId == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "api_endpoint_base_url and client_id are required"})
		return
	}
	// redirect_uri is a deployment fact (which relay this instance owns), not a browser choice:
	// derive it server-side so a self-hosted relay works without a frontend rebuild (#399). An
	// explicit value is still honored for callers that front their own relay per-connection.
	if strings.TrimSpace(req.RedirectUri) == "" {
		req.RedirectUri = relay.CallbackURL(appConfig)
	}
	// SSRF guard: the backend is about to fetch this user-supplied URL (discovery). Reject
	// non-public targets (metadata/loopback/LAN) before any server-side request. (#51)
	if err := validatePublicHTTPSURL(req.ApiEndpointBaseUrl); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": fmt.Sprintf("invalid api_endpoint_base_url: %s", err)})
		return
	}

	cfg := smart.Config{
		FHIRBaseURL: req.ApiEndpointBaseUrl,
		ClientID:    req.ClientId,
		Scopes:      strings.Fields(req.Scopes),
		RedirectURI: req.RedirectUri,
	}
	ep, err := cfg.Discover(c)
	if err != nil {
		logger.Errorln(err)
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "error": fmt.Sprintf("SMART discovery failed: %s", err)})
		return
	}
	verifier, err := smart.GenerateVerifier()
	if err != nil {
		logger.Errorln(err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not generate PKCE verifier"})
		return
	}
	state := uuid.New().String()

	c.JSON(http.StatusOK, gin.H{
		"success":       true,
		"authorize_url": cfg.AuthCodeURL(ep, state, verifier),
		"state":         state,
		"code_verifier": verifier,
		// The effective redirect_uri, so the caller round-trips the SAME value to /source/connect
		// (the token exchange requires an exact match) without knowing the relay config.
		"redirect_uri": req.RedirectUri,
		// How long the client should keep retrying connect while the user logs in (operator-tunable).
		"login_wait_seconds": appConfig.GetInt("web.smart_connect.login_wait_seconds"),
		// How long one connect request polls the relay (frontend sizes retry attempts from this) (#406).
		"relay_poll_seconds": relayPollSeconds(appConfig),
	})
}

func CreateReconnectSource(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	sourceCred := models.SourceCredential{}
	if err := c.ShouldBindJSON(&sourceCred); err != nil {
		err = fmt.Errorf("an error occurred while parsing posted source credential: %s", err)
		logger.Errorln(err)
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Log identifiers only. This printed the whole SourceCredential with %v, which includes
	// ClientSecret, AccessToken and RefreshToken as plain strings — and %v ignores the `json:"-"`
	// tag that keeps ClientSecret out of API responses. The Admin Dashboard serves this log over
	// HTTP (yourphr#476).
	logger.Infof("Parsed Create SourceCredential payload for endpoint %s", sourceCred.EndpointID)

	//get the endpoint definition
	endpointDefinition, err := sourceDefinitions.GetSourceDefinition(sourceDefinitions.GetSourceConfigOptions{
		EndpointId: sourceCred.EndpointID.String(),
	})

	if err != nil {
		// 501, not 400. This lookup needs the upstream provider definitions, which are a
		// commercial dependency YourPHR does not have (fastenhealth/fasten-onprem#629), so it
		// fails for EVERY request regardless of what was posted. A 400 blames the caller for a
		// payload that was never the problem and invites them to keep retrying variations of it.
		//
		// Connect a source through the Provider Catalog or SMART connect instead; those paths do
		// not depend on the upstream definitions. See yourphr#476.
		logger.Errorf("source definitions are unavailable, so %s cannot be served: %s", c.Request.URL.Path, err)
		c.JSON(http.StatusNotImplemented, gin.H{
			"success": false,
			"error": "this endpoint requires the upstream provider source definitions, which are not " +
				"available in YourPHR. Connect a source from the Provider Catalog or with SMART connect instead",
		})
		return
	}

	if endpointDefinition.DynamicClientRegistrationMode == "user-authenticated" {
		logger.Warnf("This client requires a dynamic client registration, starting registration process")

		if len(endpointDefinition.RegistrationEndpoint) == 0 {
			err := fmt.Errorf("this client requires dynamic registration, but does not provide a registration endpoint: %s", endpointDefinition.DynamicClientRegistrationMode)
			logger.Errorln(err)
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
			return
		}

		err := sourceCred.RegisterDynamicClient()
		if err != nil {
			err = fmt.Errorf("an error occurred while registering dynamic client: %w", err)
			logger.Errorln(err)
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
			return
		}
		//generate a JWT token and then use it to get an access token for the dynamic client
		err = sourceCred.RefreshDynamicClientAccessToken()
		if err != nil {
			err = fmt.Errorf("an error occurred while retrieving access token for dynamic client: %w", err)
			logger.Errorln(err)
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
			return
		}
	}

	if sourceCred.ID != uuid.Nil {
		//reconnect
		err := databaseRepo.UpdateSource(c, &sourceCred)
		if err != nil {
			err = fmt.Errorf("an error occurred while reconnecting source credential: %w", err)
			logger.Errorln(err)
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
			return
		}
	} else {
		//create source for the first time
		err := databaseRepo.CreateSource(c, &sourceCred)
		if err != nil {
			err = fmt.Errorf("an error occurred while storing source credential: %w", err)
			logger.Errorln(err)
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
			return
		}
	}

	// after creating the source, we should do a bulk import (in the background)

	summary, err := BackgroundJobSyncResources(GetBackgroundContext(c), logger, databaseRepo, &sourceCred)
	if err != nil {
		logger.Errorln(err)
		//errors from the background job will be wrapped and stored in the database, lets just return a generic error
		// this is also important because these errors:
		// 1. are not user facing - longer/scarier for users, and may show information that they are not equipped to resolve themselves.
		// 2. lots of duplicate text ("an error occurred while...") due to wrapping as the error bubbles up the codebase.
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "initial record sync failed. See background jobs page for more details"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "source": sourceCred, "data": summary})
}

func SourceSync(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	eventBus := c.MustGet(pkg.ContextKeyTypeEventBusServer).(event_bus.Interface)

	logger.Infof("Get SourceCredential Credentials: %v", c.Param("sourceId"))

	sourceCred, err := databaseRepo.GetSource(c, c.Param("sourceId"))
	if err != nil {
		err = fmt.Errorf("an error occurred while retrieving source credential: %w", err)
		logger.Errorln(err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	// after creating the source, we should do a bulk import (in the background)
	summary, err := BackgroundJobSyncResources(GetBackgroundContext(c), logger, databaseRepo, sourceCred)
	if err != nil {
		err := fmt.Errorf("an error occurred while syncing resources: %w", err)
		logger.Errorln(err)
		//errors from the background job will be wrapped and stored in the database, lets just return a generic error
		// this is also important because these errors:
		// 1. are not user facing - longer/scarier for users, and may show information that they are not equipped to resolve themselves.
		// 2. lots of duplicate text ("an error occurred while...") due to wrapping as the error bubbles up the codebase.
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "record sync failed. See background jobs page for more details"})
		return
	}

	//publish event
	currentUser, _ := databaseRepo.GetCurrentUser(c)
	err = eventBus.PublishMessage(
		models.NewEventSourceComplete(
			currentUser.ID.String(),
			sourceCred.ID.String(),
		),
	)
	if err != nil {
		logger.Warnf("ignoring: an error occurred while publishing sync complete event: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "source": sourceCred, "data": summary})
}

// mimics functionality in CreateRelatedResources
// mimics functionality in SourceSync
func CreateManualSource(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	eventBus := c.MustGet(pkg.ContextKeyTypeEventBusServer).(event_bus.Interface)

	// The import must survive the client disconnecting mid-upload — closing the tab, navigating
	// away, or a reverse-proxy read-timeout. The import runs inline here (the request still blocks
	// until it finishes), but Go does not kill the handler goroutine on client disconnect; it only
	// cancels the *request* context. So every DB write below — the source upsert and the import
	// itself — runs under a context detached from the request (GetBackgroundContext is rooted at
	// context.Background() and carries only the auth username), so a cancelled request context can
	// no longer abort an in-flight import and leave partial data. (#196 link repair and #201 sort
	// titles are computed during the import, so a half-finished import would be visibly broken.)
	// Only the upload read (storeFileLocally → temp file on disk) and the final JSON response use
	// the request context.
	backgroundContext := GetBackgroundContext(c)

	// store the bundle file locally
	bundleFile, err := storeFileLocally(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	// If the upload is a C-CDA / CCD document, convert it to a FHIR R4 bundle first (#254).
	// FHIR JSON/NDJSON uploads pass through unchanged. A conversion failure (sidecar disabled or
	// unreachable) is surfaced to the client and leaves the rest of the import untouched.
	bundleFile, err = maybeConvertCDA(c, logger, bundleFile)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// If the upload is a raw binary (PDF/DICOM/image), wrap it as a DocumentReference + Binary so it
	// is stored, viewable, and linkable without being interpreted (#255). FHIR/NDJSON pass through.
	bundleFile, err = maybeWrapBinary(c, logger, bundleFile)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// We cannot save the "SourceCredential" object yet, as we do not know the patientID

	// create a "manual" client, which we can use to parse the
	manualSourceCredential := models.SourceCredential{
		PlatformType: sourcePkg.PlatformTypeManual,
	}
	tempSourceClient, err := factory.GetSourceClient("", backgroundContext, logger, &manualSourceCredential)
	if err != nil {
		err = fmt.Errorf("an error occurred while initializing hub client using manual source without credentials: %w", err)
		logger.Errorln(err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	patientId, bundleType, err := tempSourceClient.ExtractPatientId(bundleFile)
	if err != nil {
		err = fmt.Errorf("an error occurred while extracting patient id: %w", err)
		logger.Errorln(err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	manualSourceCredential.Patient = patientId

	//store the manualSourceCredential
	err = databaseRepo.CreateSource(backgroundContext, &manualSourceCredential)
	if err != nil {
		err = fmt.Errorf("an error occurred while creating manual source: %w", err)
		logger.Errorln(err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	summary, err := BackgroundJobSyncResourcesWrapper(
		backgroundContext,
		logger,
		databaseRepo,
		&manualSourceCredential,
		func(
			_backgroundJobContext context.Context,
			_logger *logrus.Entry,
			_databaseRepo database.DatabaseRepository,
			_sourceCred *models.SourceCredential,
		) (sourceModels.SourceClient, sourceModels.UpsertSummary, error) {
			manualSourceClient, err := factory.GetSourceClient("", _backgroundJobContext, _logger, _sourceCred)
			if err != nil {
				resultErr := fmt.Errorf("an error occurred while initializing hub client using manual source with credential: %w", err)
				logger.Errorln(resultErr)
				return manualSourceClient, sourceModels.UpsertSummary{}, resultErr
			}

			summary, err := manualSourceClient.SyncAllBundle(_databaseRepo, bundleFile, bundleType)
			if err != nil {
				resultErr := fmt.Errorf("an error occurred while processing bundle: %w", err)
				logger.Errorln(resultErr)
				return manualSourceClient, sourceModels.UpsertSummary{}, resultErr
			}
			return manualSourceClient, summary, nil
		})

	if err != nil {
		err = fmt.Errorf("an error occurred while storing manual source resources: %w", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	//publish event (use the detached context so completion still records if the client has gone)
	currentUser, _ := databaseRepo.GetCurrentUser(backgroundContext)
	err = eventBus.PublishMessage(
		models.NewEventSourceComplete(
			currentUser.ID.String(),
			manualSourceCredential.ID.String(),
		),
	)
	if err != nil {
		logger.Warnf("ignoring: an error occurred while publishing sync complete event: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": summary, "source": manualSourceCredential})

}

func GetSource(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	sourceCred, err := databaseRepo.GetSource(c, c.Param("sourceId"))
	if err != nil {
		logger.Errorln("An error occurred while retrieving source credential", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": sourceCred})
}

func GetSourceSummary(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	sourceSummary, err := databaseRepo.GetSourceSummary(c, c.Param("sourceId"))
	if err != nil {
		logger.Errorln("An error occurred while retrieving source summary", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": sourceSummary})
}

func ListSource(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	sourceCreds, err := databaseRepo.GetSources(c)
	if err != nil {
		logger.Errorln("An error occurred while listing source credentials", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": sourceCreds})
}

// DisconnectSource clears OAuth tokens for a source but keeps imported records (#437).
func DisconnectSource(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	if err := databaseRepo.DisconnectSource(c, c.Param("sourceId")); err != nil {
		logger.Errorln("An error occurred while disconnecting source", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not disconnect source"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"disconnected": true}})
}

// RemoveSourceData deletes FHIR resources for a source; credentials remain (#437).
func RemoveSourceData(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	rowsEffected, err := databaseRepo.RemoveSourceData(c, c.Param("sourceId"))
	if err != nil {
		logger.Errorln("An error occurred while removing source data", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not remove source data"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": rowsEffected})
}

// DeleteSource full teardown: imported records + soft-delete credential (#437 combined action).
func DeleteSource(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	rowsEffected, err := databaseRepo.DeleteSource(c, c.Param("sourceId"))
	if err != nil {
		logger.Errorln("An error occurred while deleting source credential", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not delete source"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": rowsEffected})
}

// Helpers
func storeFileLocally(c *gin.Context) (*os.File, error) {
	// single file
	file, err := c.FormFile("file")
	if err != nil {
		//c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not extract file from form"})
		return nil, fmt.Errorf("could not extract file from form")
	}
	fmt.Printf("Uploaded filename: %s", file.Filename)

	// create a temporary file to store this uploaded file. Use a fixed "*" pattern (clean,
	// unique) rather than the client-supplied file.Filename — a filename with path separators
	// or odd characters would make the temp-file creation fail.
	bundleFile, err := os.CreateTemp("", "fasten-manual-upload-*.json")
	if err != nil {
		return nil, fmt.Errorf("could not create temp file: %w", err)
	}

	// Stream the upload into the temp file ourselves rather than gin.SaveUploadedFile (#148):
	// SaveUploadedFile chmod()s the destination, which fails with "chmod /tmp: operation not
	// permitted" on sandboxed runners (CI) where our uid can't chmod the temp dir. os.CreateTemp
	// already created the file with safe 0600 perms, so an io.Copy is sufficient and portable.
	src, err := file.Open()
	if err != nil {
		bundleFile.Close()
		return nil, fmt.Errorf("could not open uploaded file: %w", err)
	}
	defer src.Close()

	if _, err = io.Copy(bundleFile, src); err != nil {
		bundleFile.Close()
		return nil, fmt.Errorf("could not write uploaded file to %q: %w", bundleFile.Name(), err)
	}

	// rewind so the caller reads the bundle from the start
	if _, err = bundleFile.Seek(0, io.SeekStart); err != nil {
		bundleFile.Close()
		return nil, fmt.Errorf("could not rewind temp file %q: %w", bundleFile.Name(), err)
	}
	return bundleFile, nil
}
