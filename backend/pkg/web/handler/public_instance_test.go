package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/handler"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// allowedPublicInstanceKeys mirrors the `public` array shipped in app-default-config.json.
// Written out by hand rather than read from the config: a test that loaded the same array it is
// checking would pass automatically the moment somebody added a key, and forcing that edit to be
// deliberate is the entire point. Widening it is a security decision (#457).
var allowedPublicInstanceKeys = []string{
	"operator.name", "operator.contact_email", "operator.contact_url", "theme.name",
}

func newPublicInstanceRequest(t *testing.T, configure func(config.Interface)) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)

	appConfig, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, appConfig.Init())
	appConfig.Set("database.location", t.TempDir()+"/fasten.db")
	if configure != nil {
		configure(appConfig)
	}

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set(pkg.ContextKeyTypeConfig, appConfig)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/instance/public", nil)

	handler.GetPublicInstanceInfo(ctx)
	return recorder
}

func decodePublicInstanceData(t *testing.T, recorder *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var body struct {
		Success bool                   `json:"success"`
		Data    map[string]interface{} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.True(t, body.Success)
	return body.Data
}

func TestGetPublicInstanceInfo_ServesConfiguredValues(t *testing.T) {
	recorder := newPublicInstanceRequest(t, func(c config.Interface) {
		c.Set("operator.name", "Nerds by the Hour")
		c.Set("operator.contact_email", "help@example.org")
		c.Set("operator.contact_url", "https://example.org/help")
		c.Set("theme.name", "flatly")
	})

	require.Equal(t, http.StatusOK, recorder.Code)
	data := decodePublicInstanceData(t, recorder)
	require.Equal(t, "Nerds by the Hour", data["operator.name"])
	require.Equal(t, "help@example.org", data["operator.contact_email"])
	require.Equal(t, "https://example.org/help", data["operator.contact_url"])
	require.Equal(t, "flatly", data["theme.name"])
}

// Unset values are empty strings, not omitted and not defaulted — the frontend renders nothing
// rather than inventing a fallback contact.
func TestGetPublicInstanceInfo_UnsetValuesAreEmpty(t *testing.T) {
	recorder := newPublicInstanceRequest(t, nil)

	data := decodePublicInstanceData(t, recorder)
	for _, key := range allowedPublicInstanceKeys {
		require.Contains(t, data, key)
		require.Equal(t, "", data[key], "%s should be empty when unset", key)
	}
}

// THE load-bearing test for #453. The merged configuration holds jwt.issuer.key, relay.secret
// and Blue Button client secrets; if this endpoint ever serves config state rather than the
// named allowlist, it becomes a credential disclosure. Setting real-looking secrets and
// asserting the response contains no key outside the allowlist catches that at the response
// boundary, whatever the implementation does upstream.
func TestGetPublicInstanceInfo_ExposesNothingOutsideTheAllowlist(t *testing.T) {
	recorder := newPublicInstanceRequest(t, func(c config.Interface) {
		c.Set("jwt.issuer.key", "super-secret-signing-key")
		c.Set("relay.secret", "super-secret-relay-secret")
		c.Set("database.encryption.key", "super-secret-db-key")
		c.Set("operator.name", "Nerds by the Hour")
	})

	data := decodePublicInstanceData(t, recorder)

	for key := range data {
		require.Contains(t, allowedPublicInstanceKeys, key,
			"%q is not in the shipped `public` array — adding a key there publishes it to anonymous callers", key)
	}

	body := recorder.Body.String()
	require.NotContains(t, body, "super-secret-signing-key")
	require.NotContains(t, body, "super-secret-relay-secret")
	require.NotContains(t, body, "super-secret-db-key")
}

// The endpoint serves whatever the `public` array says, so an operator hiding a key actually
// removes it from the wire rather than merely hiding it in the UI.
func TestGetPublicInstanceInfo_HonoursANarrowedPublicArray(t *testing.T) {
	recorder := newPublicInstanceRequest(t, func(c config.Interface) {
		c.Set("operator.name", "Nerds by the Hour")
		c.Set("operator.contact_email", "help@example.org")
		c.Set("public", []string{"operator.name"})
	})

	data := decodePublicInstanceData(t, recorder)
	require.Equal(t, "Nerds by the Hour", data["operator.name"])
	require.NotContains(t, data, "operator.contact_email",
		"a key removed from the public array must not be on the wire at all")
}

// Widening is permitted (operator decision) — this pins that the endpoint really does follow the
// array, which is also why the startup warning exists.
func TestGetPublicInstanceInfo_HonoursAWidenedPublicArray(t *testing.T) {
	recorder := newPublicInstanceRequest(t, func(c config.Interface) {
		c.Set("web.environment_name", "demo")
		c.Set("public", []string{"web.environment_name"})
	})

	data := decodePublicInstanceData(t, recorder)
	require.Equal(t, "demo", data["web.environment_name"])
}
