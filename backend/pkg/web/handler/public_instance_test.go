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
	"operator.name", "operator.contact_url", "theme.name",
	// demo.enabled — the sign-in page decides whether to offer one-click entry to the shared demo
	// account before anyone has logged in, so the flag has to be readable anonymously (#495). It
	// is a boolean, and it is the only published key that is not a string; note demo.password is
	// deliberately NOT here and is verified server-side instead.
	"demo.enabled",
	// demo.admin.enabled — the sign-in page offers the read-only admin tour beside the patient one
	// (#516), and that decision is made before anyone has logged in. Also a boolean. Publishing it
	// reveals only that the tour exists: the account's credential is generated and verified
	// server-side like demo.password, and the account itself cannot change anything.
	"demo.admin.enabled",
	// signup.enabled — the sign-in page decides whether to offer "Create an Account" before login
	// (#498). Also a boolean. The backend enforces the gate regardless of what the UI shows.
	"signup.enabled",
	// The password policy (#506). The sign-up form builds its validators from these rather than
	// hardcoding numbers, which is what let the form and the server disagree. Sizes and booleans —
	// no secret is disclosed by saying how long a password has to be.
	"password.min_length", "password.max_length", "password.deny_common", "password.deny_username",
	"username.min_length",
}

// publicInstanceStringKeys are the published keys whose unset value is the empty string. Kept
// apart from the list above because demo.enabled is a boolean, so "unset" is false, not "".
var publicInstanceStringKeys = []string{
	"operator.name", "operator.contact_url", "theme.name",
}

func newPublicInstanceRequest(t *testing.T, configure func(config.Interface), h ...gin.HandlerFunc) *httptest.ResponseRecorder {
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

	target := handler.GetPublicInstanceInfo
	if len(h) > 0 {
		target = h[0]
	}
	target(ctx)
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
	require.Equal(t, "https://example.org/help", data["operator.contact_url"])
	require.Equal(t, "flatly", data["theme.name"])
	require.NotContains(t, data, "operator.contact_email",
		"the operator address must not reach an anonymous caller (#459)")
}

// Unset values are empty strings, not omitted and not defaulted — the frontend renders nothing
// rather than inventing a fallback contact.
func TestGetPublicInstanceInfo_UnsetValuesAreEmpty(t *testing.T) {
	recorder := newPublicInstanceRequest(t, nil)

	data := decodePublicInstanceData(t, recorder)
	for _, key := range publicInstanceStringKeys {
		require.Contains(t, data, key)
		require.Equal(t, "", data[key], "%s should be empty when unset", key)
	}

	// The demo flag ships false, and it must arrive as a real boolean — the frontend treats
	// anything that is not literally true as "not a demo", so a stringified "false" would be
	// safe but a stringified "true" would not (#495).
	require.Contains(t, data, "demo.enabled")
	require.Equal(t, false, data["demo.enabled"], "demo mode must ship off")

	// Opposite default, for the opposite reason: signup has always been open, and shipping it
	// closed would change behaviour for every existing install on upgrade (#498).
	require.Contains(t, data, "signup.enabled")
	require.Equal(t, true, data["signup.enabled"], "signup must ship open")
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

// --- #459: the address is withheld from anonymous callers, not from users --------------------

func TestGetInstanceInfoForUser_IncludesTheOperatorEmail(t *testing.T) {
	recorder := newPublicInstanceRequest(t, func(c config.Interface) {
		c.Set("operator.name", "Nerds by the Hour")
		c.Set("operator.contact_email", "help@example.org")
	}, handler.GetInstanceInfoForUser)

	data := decodePublicInstanceData(t, recorder)
	require.Equal(t, "help@example.org", data["operator.contact_email"])
	require.Equal(t, "Nerds by the Hour", data["operator.name"])
}

// Even the signed-in view is a named set, not "everything except secrets".
func TestGetInstanceInfoForUser_StillExcludesSecrets(t *testing.T) {
	recorder := newPublicInstanceRequest(t, func(c config.Interface) {
		c.Set("jwt.issuer.key", "super-secret-signing-key")
		c.Set("relay.secret", "super-secret-relay-secret")
	}, handler.GetInstanceInfoForUser)

	body := recorder.Body.String()
	require.NotContains(t, body, "super-secret-signing-key")
	require.NotContains(t, body, "super-secret-relay-secret")
}

// Boolean public keys must arrive as booleans however they were set. Environment variables are
// strings, so before this was coerced an env-configured instance served "true"/"false" and every
// client comparing against a real boolean got the wrong answer — silently, and in the dangerous
// direction for signup.enabled: "false" is not false, so a closed instance still advertised
// sign-up. Reproduced here by setting the string form the way viper receives it from the
// environment (#505).
func TestGetPublicInstanceInfo_BooleansStayBooleans(t *testing.T) {
	recorder := newPublicInstanceRequest(t, func(c config.Interface) {
		c.Set("demo.enabled", "true")
		c.Set("signup.enabled", "false")
	})

	data := decodePublicInstanceData(t, recorder)

	require.Equal(t, true, data["demo.enabled"],
		`a demo instance configured via the environment must still render its one-click sign-in`)
	require.Equal(t, false, data["signup.enabled"],
		`an instance with signup closed must not advertise sign-up; "false" as a string reads as truthy`)
}
