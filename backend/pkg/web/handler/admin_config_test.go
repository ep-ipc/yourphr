package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/event_bus"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
	"github.com/stretchr/testify/suite"
)

// AdminConfigHandlerTestSuite uses a REAL config rather than the mock the other admin suite uses:
// these handlers read the shipped catalogue, the custom overlay and the public array, so a mock
// would be all expectation and no coverage.
type AdminConfigHandlerTestSuite struct {
	suite.Suite
	AppConfig     config.Interface
	AppRepository database.DatabaseRepository
	DataDir       string
}

func (suite *AdminConfigHandlerTestSuite) SetupTest() {
	t := suite.T()
	dir := t.TempDir()
	suite.DataDir = dir

	appConfig, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, appConfig.Init())
	appConfig.Set("database.location", filepath.Join(dir, "fasten.db"))
	appConfig.Set("storage.data_dir", dir)
	// Encryption defaults ON (#470) and requires a key, so an unencrypted test database has to opt
	// out — exactly as the reference deployment does.
	appConfig.Set("database.encryption.enabled", false)
	suite.AppConfig = appConfig

	repo, err := database.NewRepository(appConfig, logrus.WithField("test", t.Name()), event_bus.NewNoopEventBusServer())
	require.NoError(t, err)
	suite.AppRepository = repo

	require.NoError(t, repo.CreateUser(context.Background(), &models.User{Username: "admin_user", Password: "p", Role: pkg.UserRoleAdmin}))
	require.NoError(t, repo.CreateUser(context.Background(), &models.User{Username: "reg_user", Password: "p", Role: pkg.UserRoleUser}))
}

func (suite *AdminConfigHandlerTestSuite) ctxFor(username string, w *httptest.ResponseRecorder, req *http.Request) *gin.Context {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(w)
	ctx.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", suite.T().Name()))
	ctx.Set(pkg.ContextKeyTypeDatabase, suite.AppRepository)
	ctx.Set(pkg.ContextKeyTypeConfig, suite.AppConfig)
	ctx.Set(pkg.ContextKeyTypeAuthUsername, username)
	ctx.Request = req
	return ctx
}

func (suite *AdminConfigHandlerTestSuite) listConfig() AdminConfigResponse {
	w := httptest.NewRecorder()
	GetAdminConfig(suite.ctxFor("admin_user", w, httptest.NewRequest("GET", "/admin/config", nil)))
	require.Equal(suite.T(), http.StatusOK, w.Code)

	var resp struct {
		Success bool                `json:"success"`
		Data    AdminConfigResponse `json:"data"`
	}
	require.NoError(suite.T(), json.Unmarshal(w.Body.Bytes(), &resp))
	require.True(suite.T(), resp.Success)
	return resp.Data
}

func (suite *AdminConfigHandlerTestSuite) entry(key string) ConfigEntry {
	for _, e := range suite.listConfig().Entries {
		if e.Key == key {
			return e
		}
	}
	suite.T().Fatalf("key %q missing from the admin config listing", key)
	return ConfigEntry{}
}

// --- access control ---------------------------------------------------------------------------

func (suite *AdminConfigHandlerTestSuite) TestNonAdminForbiddenEverywhere() {
	for name, call := range map[string]func(*gin.Context){
		"list":   GetAdminConfig,
		"reveal": RevealAdminConfigValue,
		"set":    SetAdminConfigValue,
		"reset":  ResetAdminConfigValue,
	} {
		w := httptest.NewRecorder()
		call(suite.ctxFor("reg_user", w, httptest.NewRequest("GET", "/admin/config", nil)))
		require.Equalf(suite.T(), http.StatusForbidden, w.Code, "%s must be admin-only", name)
	}
}

// --- masking: the load-bearing behaviour -------------------------------------------------------

// A masked value must not be IN the response at all. Cosmetic masking would leave the secret in
// the page for devtools, view-source, a screenshot of the network tab, or any XSS.
func (suite *AdminConfigHandlerTestSuite) TestSecretsAreNeverInTheListResponse() {
	suite.AppConfig.Set("jwt.issuer.key", "super-secret-signing-key")
	suite.AppConfig.Set("relay.secret", "super-secret-relay-secret")

	w := httptest.NewRecorder()
	GetAdminConfig(suite.ctxFor("admin_user", w, httptest.NewRequest("GET", "/admin/config", nil)))

	body := w.Body.String()
	require.NotContains(suite.T(), body, "super-secret-signing-key")
	require.NotContains(suite.T(), body, "super-secret-relay-secret")

	jwt := suite.entry("jwt.issuer.key")
	require.True(suite.T(), jwt.Masked)
	require.Equal(suite.T(), maskedValue, jwt.Value)
	require.Equal(suite.T(), maskedValue, jwt.Default, "the default must be masked on the same rule")
}

// Public keys are shown outright — a value safe to serve anonymously is safe to print here.
func (suite *AdminConfigHandlerTestSuite) TestPublicValuesAreNotMasked() {
	suite.AppConfig.Set("operator.name", "Nerds by the Hour")

	entry := suite.entry("operator.name")
	require.False(suite.T(), entry.Masked)
	require.Equal(suite.T(), "Nerds by the Hour", entry.Value)
	require.True(suite.T(), entry.Public)
}

// REGRESSION. Masking everything outside `public` hid 47 of 51 settings — the listen port, the
// log level — which protects nothing and trains an operator to click reveal without reading.
// Only the short `secret` list is masked.
func (suite *AdminConfigHandlerTestSuite) TestOrdinarySettingsAreNotMasked() {
	for _, key := range []string{
		"web.listen.port",
		"log.level",
		"metrics.port",
		"database.type",
		"cda_converter.enabled",
	} {
		require.Falsef(suite.T(), suite.entry(key).Masked,
			"%s is not a secret and must be readable without a click", key)
	}
}

func (suite *AdminConfigHandlerTestSuite) TestMaskingIsRareRatherThanTheDefault() {
	entries := suite.listConfig().Entries
	masked := 0
	for _, e := range entries {
		if e.Masked {
			masked++
		}
	}

	require.NotZero(suite.T(), masked, "the genuinely secret keys must still be masked")
	require.Lessf(suite.T(), masked, len(entries)/4,
		"masked %d of %d settings — masking should be the exception, not the rule", masked, len(entries))
}

// A key that is both secret and public is served to anonymous callers, which defeats masking it.
func (suite *AdminConfigHandlerTestSuite) TestSecretAlsoPublicIsFlagged() {
	suite.AppConfig.Set("public", []string{"relay.secret"})

	listing := suite.listConfig()
	joined := ""
	for _, w := range listing.Warnings {
		joined += w + "\n"
	}
	require.Contains(suite.T(), joined, "relay.secret")
	require.Contains(suite.T(), joined, "NO login")
}

// --- source, so an operator can tell chosen from defaulted -------------------------------------

func (suite *AdminConfigHandlerTestSuite) TestSourceDistinguishesCustomFromDefault() {
	require.Equal(suite.T(), "default", suite.entry("operator.name").Source)

	require.NoError(suite.T(), config.SetCustomValues(suite.AppConfig,
		map[string]interface{}{"operator.name": "NBTH"}))

	entry := suite.entry("operator.name")
	require.Equal(suite.T(), "custom", entry.Source)
	require.Equal(suite.T(), "NBTH", entry.Value)
	require.Equal(suite.T(), "", entry.Default, "the shipped value is shown so reset is predictable")
}

func (suite *AdminConfigHandlerTestSuite) TestListingIncludesTheCustomConfigPath() {
	require.Equal(suite.T(),
		filepath.Join(suite.DataDir, "config", config.CustomConfigFileName),
		suite.listConfig().CustomConfigPath)
}

// --- reveal -----------------------------------------------------------------------------------

func (suite *AdminConfigHandlerTestSuite) TestRevealReturnsTheRealValue() {
	suite.AppConfig.Set("relay.secret", "super-secret-relay-secret")

	w := httptest.NewRecorder()
	ctx := suite.ctxFor("admin_user", w, httptest.NewRequest("GET", "/admin/config/reveal/relay.secret", nil))
	ctx.Params = gin.Params{{Key: "key", Value: "relay.secret"}}
	RevealAdminConfigValue(ctx)

	require.Equal(suite.T(), http.StatusOK, w.Code)
	require.Contains(suite.T(), w.Body.String(), "super-secret-relay-secret")
}

func (suite *AdminConfigHandlerTestSuite) TestRevealRejectsAnUnknownKey() {
	w := httptest.NewRecorder()
	ctx := suite.ctxFor("admin_user", w, httptest.NewRequest("GET", "/admin/config/reveal/nope", nil))
	ctx.Params = gin.Params{{Key: "key", Value: "not.a.real.key"}}
	RevealAdminConfigValue(ctx)

	require.Equal(suite.T(), http.StatusNotFound, w.Code)
}

// --- set --------------------------------------------------------------------------------------

func (suite *AdminConfigHandlerTestSuite) putValue(key string, value interface{}) *httptest.ResponseRecorder {
	body, err := json.Marshal(SetAdminConfigRequest{Key: key, Value: value})
	require.NoError(suite.T(), err)
	req := httptest.NewRequest("PUT", "/admin/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	SetAdminConfigValue(suite.ctxFor("admin_user", w, req))
	return w
}

func (suite *AdminConfigHandlerTestSuite) TestSetWritesAnOverrideAndAppliesItLive() {
	require.Equal(suite.T(), http.StatusOK, suite.putValue("operator.name", "NBTH").Code)

	require.Equal(suite.T(), "NBTH", suite.AppConfig.GetString("operator.name"))
	require.Equal(suite.T(), "custom", suite.entry("operator.name").Source)
}

// A free-form "add any property" form would make a typo permanent: the key would sit in the file
// forever, look configured, and do nothing. The catalogue is complete (#456), so rejecting
// unknown keys costs nothing.
func (suite *AdminConfigHandlerTestSuite) TestSetRejectsAnUnknownKey() {
	w := suite.putValue("operator.nmae", "typo")

	require.Equal(suite.T(), http.StatusBadRequest, w.Code)
	require.Contains(suite.T(), w.Body.String(), "unknown configuration key")
}

// Silently turning "false" into a truthy string is how a disabled feature turns itself on.
func (suite *AdminConfigHandlerTestSuite) TestSetRejectsAMismatchedType() {
	require.Equal(suite.T(), http.StatusBadRequest, suite.putValue("metrics.enabled", "yes please").Code)
	require.Equal(suite.T(), http.StatusBadRequest, suite.putValue("metrics.port", "nine thousand").Code)
	require.Equal(suite.T(), http.StatusBadRequest, suite.putValue("metrics.port", 90.5).Code)
	require.Equal(suite.T(), http.StatusBadRequest, suite.putValue("operator.name", 42).Code)
}

// JSON numbers arrive as float64; an int setting must come back out as an int, or it surfaces as
// 9.091e+03 wherever it is displayed.
func (suite *AdminConfigHandlerTestSuite) TestSetKeepsIntegersIntegral() {
	require.Equal(suite.T(), http.StatusOK, suite.putValue("metrics.port", 9999).Code)
	require.Equal(suite.T(), 9999, suite.AppConfig.GetInt("metrics.port"))

	values, err := config.CustomConfigValues(suite.AppConfig)
	require.NoError(suite.T(), err)
	require.EqualValues(suite.T(), 9999, values["metrics.port"])
}

// Widening the public array is allowed, but must be surfaced where an operator will actually see
// it — a startup log line is read approximately never.
func (suite *AdminConfigHandlerTestSuite) TestWideningThePublicArrayIsFlaggedInline() {
	require.Equal(suite.T(), http.StatusOK,
		suite.putValue("public", []interface{}{"operator.name", "web.environment_name"}).Code)

	listing := suite.listConfig()
	require.NotEmpty(suite.T(), listing.Warnings, "promoting a key must produce a warning")
	require.Contains(suite.T(), listing.Warnings[0], "web.environment_name")

	var promoted ConfigEntry
	for _, e := range listing.Entries {
		if e.Key == "web.environment_name" {
			promoted = e
		}
	}
	require.True(suite.T(), promoted.Promoted, "and be flagged on the key itself")
	require.True(suite.T(), promoted.Public)
}

// --- reset ------------------------------------------------------------------------------------

func (suite *AdminConfigHandlerTestSuite) TestResetRestoresTheShippedDefault() {
	require.Equal(suite.T(), http.StatusOK, suite.putValue("log.level", "DEBUG").Code)
	require.Equal(suite.T(), "DEBUG", suite.AppConfig.GetString("log.level"))

	w := httptest.NewRecorder()
	ctx := suite.ctxFor("admin_user", w, httptest.NewRequest("DELETE", "/admin/config/log.level", nil))
	ctx.Params = gin.Params{{Key: "key", Value: "log.level"}}
	ResetAdminConfigValue(ctx)

	require.Equal(suite.T(), http.StatusOK, w.Code)
	require.Equal(suite.T(), "INFO", suite.AppConfig.GetString("log.level"))
	require.Equal(suite.T(), "default", suite.entry("log.level").Source)
}

// --- environment-governed keys ----------------------------------------------------------------

// REGRESSION. Env outranks the custom store on restart, so writing such a key used to take effect
// immediately and silently revert on the next boot — an edit that appears to work and quietly
// undoes itself. Refuse it and name the variable instead.
func (suite *AdminConfigHandlerTestSuite) TestSetRefusesAKeyGovernedByTheEnvironment() {
	suite.T().Setenv("YOURPHR_LOG_LEVEL", "DEBUG")

	w := suite.putValue("log.level", "WARN")

	require.Equal(suite.T(), http.StatusConflict, w.Code)
	require.Contains(suite.T(), w.Body.String(), "YOURPHR_LOG_LEVEL")
	require.Contains(suite.T(), w.Body.String(), "deployment configuration")
}

func (suite *AdminConfigHandlerTestSuite) TestListingFlagsEnvironmentGovernedKeys() {
	suite.T().Setenv("YOURPHR_LOG_LEVEL", "DEBUG")

	entry := suite.entry("log.level")
	require.True(suite.T(), entry.FromEnv)
	require.Equal(suite.T(), "environment", entry.Source,
		"the source must say where the value really comes from")
	require.Equal(suite.T(), "YOURPHR_LOG_LEVEL", entry.EnvVar)
}

// Every key advertises the variable that would govern it, so an operator can set one without
// working out the mapping by hand.
func (suite *AdminConfigHandlerTestSuite) TestEveryKeyNamesItsEnvironmentVariable() {
	require.Equal(suite.T(), "YOURPHR_OPERATOR_CONTACT_EMAIL", suite.entry("operator.contact_email").EnvVar)
	require.Equal(suite.T(), "YOURPHR_JWT_ISSUER_KEY", suite.entry("jwt.issuer.key").EnvVar)
	require.False(suite.T(), suite.entry("operator.contact_email").FromEnv,
		"unset variables must not be reported as governing")
}

func TestAdminConfigHandlerTestSuite(t *testing.T) {
	suite.Run(t, new(AdminConfigHandlerTestSuite))
}
