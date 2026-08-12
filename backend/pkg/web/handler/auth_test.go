package handler_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	mock_config "github.com/fastenhealth/fasten-onprem/backend/pkg/config/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/handler"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthSignup(t *testing.T) {
	// Setup
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()

	t.Run("First user should be assigned admin role", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)

		mockDB.EXPECT().GetUserCount(gomock.Any()).Return(0, nil)
		mockDB.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Do(func(_ interface{}, user *models.User) {
			assert.Equal(t, pkg.UserRoleAdmin, user.Role)
		}).Return(nil)
		// #506: the policy is read on every signup. Shipped values, so the tests exercise what an
		// instance actually enforces.
		mockConfig.EXPECT().GetInt("password.min_length").Return(8).AnyTimes()
		mockConfig.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_common").Return(true).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_username").Return(true).AnyTimes()
		mockConfig.EXPECT().GetInt("username.min_length").Return(3).AnyTimes()
		mockConfig.EXPECT().GetString("jwt.issuer.key").Return("test_key")
		// setSessionCookie → SessionPolicyFromConfig (#445)
		mockConfig.EXPECT().GetInt("jwt.session_ttl_minutes").Return(60).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_absolute_hours").Return(12).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_renew_if_remaining_minutes").Return(30).AnyTimes()
		mockConfig.EXPECT().GetBool("web.listen.https.enabled").Return(false) // setSessionCookie (#103)

		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, mockConfig)

		userWizard := handler.UserWizard{
			User: &models.User{
				Username: "testuser",
				Password: "correct-horse-battery",
			},
		}
		jsonData, _ := json.Marshal(userWizard)
		c.Request, _ = http.NewRequest(http.MethodPost, "/signup", bytes.NewBuffer(jsonData))
		c.Request.Header.Set("Content-Type", "application/json")

		handler.AuthSignup(c)

		assert.Equal(t, http.StatusOK, w.Code)
		var response map[string]interface{}
		err := json.Unmarshal(w.Body.Bytes(), &response)
		assert.NoError(t, err)
		assert.True(t, response["success"].(bool))
	})

	t.Run("Subsequent user should be assigned user role", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)

		mockDB.EXPECT().GetUserCount(gomock.Any()).Return(1, nil)
		mockConfig.EXPECT().GetBool("signup.enabled").Return(true) // #498
		mockDB.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Do(func(_ interface{}, user *models.User) {
			assert.Equal(t, pkg.UserRoleUser, user.Role)
		}).Return(nil)
		// #506: the policy is read on every signup. Shipped values, so the tests exercise what an
		// instance actually enforces.
		mockConfig.EXPECT().GetInt("password.min_length").Return(8).AnyTimes()
		mockConfig.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_common").Return(true).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_username").Return(true).AnyTimes()
		mockConfig.EXPECT().GetInt("username.min_length").Return(3).AnyTimes()
		mockConfig.EXPECT().GetString("jwt.issuer.key").Return("test_key")
		// setSessionCookie → SessionPolicyFromConfig (#445)
		mockConfig.EXPECT().GetInt("jwt.session_ttl_minutes").Return(60).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_absolute_hours").Return(12).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_renew_if_remaining_minutes").Return(30).AnyTimes()
		mockConfig.EXPECT().GetBool("web.listen.https.enabled").Return(false) // setSessionCookie (#103)

		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, mockConfig)

		userWizard := handler.UserWizard{
			User: &models.User{
				Username: "testuser2",
				Password: "correct-horse-battery-2",
			},
		}
		jsonData, _ := json.Marshal(userWizard)
		c.Request, _ = http.NewRequest(http.MethodPost, "/signup", bytes.NewBuffer(jsonData))
		c.Request.Header.Set("Content-Type", "application/json")

		handler.AuthSignup(c)

		assert.Equal(t, http.StatusOK, w.Code)
		var response map[string]interface{}
		err := json.Unmarshal(w.Body.Bytes(), &response)
		assert.NoError(t, err)
		assert.True(t, response["success"].(bool))
	})

	// A reserved name is the CALLER's input being wrong. This answered 500, which the sign-up page
	// renders as "an unknown error occurred during sign-up" — so the one case with a clear
	// explanation was the one case nobody got told about, and `admin` is what everybody types first.
	t.Run("A reserved username is a 400 that says why, not a 500", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)

		mockDB.EXPECT().GetUserCount(gomock.Any()).Return(0, nil)
		// #506 policy is read before CreateUser; "admin" satisfies it, so the reserved-name refusal
		// from the repository is what this test is actually about.
		mockConfig.EXPECT().GetInt("password.min_length").Return(8).AnyTimes()
		mockConfig.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_common").Return(false).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_username").Return(true).AnyTimes()
		mockConfig.EXPECT().GetInt("username.min_length").Return(3).AnyTimes()
		mockDB.EXPECT().CreateUser(gomock.Any(), gomock.Any()).
			Return(fmt.Errorf("%w: %q", database.ErrReservedUsername, "admin"))

		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, mockConfig)

		jsonData, _ := json.Marshal(handler.UserWizard{
			User: &models.User{Username: "admin", Password: "correct-horse-battery"},
		})
		c.Request, _ = http.NewRequest(http.MethodPost, "/signup", bytes.NewBuffer(jsonData))
		c.Request.Header.Set("Content-Type", "application/json")

		handler.AuthSignup(c)

		assert.Equal(t, http.StatusBadRequest, w.Code)
		var response map[string]interface{}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
		assert.False(t, response["success"].(bool))
		assert.Contains(t, response["error"], "reserved", "the response must carry the reason, not just a status")
	})

	// THE point of #506: the rule is enforced by the API, not only by the browser. A form-only policy
	// is one the rest of the system can violate — which is exactly how the demo seed ended up with a
	// password our own sign-in page refused (#505).
	t.Run("rejects a password the policy refuses, at the API", func(t *testing.T) {
		for _, tc := range []struct{ name, username, password, wants string }{
			{"too short", "testuser", "short1", "at least 8"},
			{"contains the username", "testuser", "testuser-phrase", "username"},
			{"commonly breached", "someone", "password123", "commonly used"},
			{"over the byte ceiling", "someone", strings.Repeat("a", 100), "bytes or fewer"},
			{"username too short", "ab", "correct-horse-battery", "at least 3"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				ctrl := gomock.NewController(t)
				defer ctrl.Finish()

				mockDB := mock_database.NewMockDatabaseRepository(ctrl)
				mockConfig := mock_config.NewMockInterface(ctrl)

				mockConfig.EXPECT().GetInt("password.min_length").Return(8).AnyTimes()
				mockConfig.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
				mockConfig.EXPECT().GetBool("password.deny_common").Return(true).AnyTimes()
				mockConfig.EXPECT().GetBool("password.deny_username").Return(true).AnyTimes()
				mockConfig.EXPECT().GetInt("username.min_length").Return(3).AnyTimes()
				mockDB.EXPECT().GetUserCount(gomock.Any()).Return(0, nil)
				// The account must never be created — a 400 that still writes the user would be worse
				// than no policy at all.
				mockDB.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)

				w := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(w)
				c.Set(pkg.ContextKeyTypeDatabase, mockDB)
				c.Set(pkg.ContextKeyTypeConfig, mockConfig)

				jsonData, _ := json.Marshal(handler.UserWizard{
					User: &models.User{Username: tc.username, Password: tc.password},
				})
				c.Request, _ = http.NewRequest(http.MethodPost, "/signup", bytes.NewBuffer(jsonData))
				c.Request.Header.Set("Content-Type", "application/json")

				handler.AuthSignup(c)

				assert.Equal(t, http.StatusBadRequest, w.Code)
				var response map[string]interface{}
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
				assert.Contains(t, response["error"], tc.wants, "the message must name the rule that was broken")
			})
		}
	})

	// An operator who lowers the minimum gets what they configured — nothing is hardcoded.
	t.Run("honours a policy the operator relaxed", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()

		mockDB := mock_database.NewMockDatabaseRepository(ctrl)
		mockConfig := mock_config.NewMockInterface(ctrl)

		mockConfig.EXPECT().GetInt("password.min_length").Return(4).AnyTimes()
		mockConfig.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_common").Return(false).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_username").Return(false).AnyTimes()
		mockConfig.EXPECT().GetInt("username.min_length").Return(2).AnyTimes()
		mockConfig.EXPECT().GetString("jwt.issuer.key").Return("test_key")
		mockConfig.EXPECT().GetInt("jwt.session_ttl_minutes").Return(60).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_absolute_hours").Return(12).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_renew_if_remaining_minutes").Return(30).AnyTimes()
		mockConfig.EXPECT().GetBool("web.listen.https.enabled").Return(false)
		mockDB.EXPECT().GetUserCount(gomock.Any()).Return(0, nil)
		mockDB.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Return(nil)

		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, mockConfig)

		jsonData, _ := json.Marshal(handler.UserWizard{
			User: &models.User{Username: "ab", Password: "abcd"},
		})
		c.Request, _ = http.NewRequest(http.MethodPost, "/signup", bytes.NewBuffer(jsonData))
		c.Request.Header.Set("Content-Type", "application/json")

		handler.AuthSignup(c)

		assert.Equal(t, http.StatusOK, w.Code, "a shorter minimum is the operator's call to make")
	})
}

// Per-account sign-in throttle (#509). The per-IP limiter never sees a slow distributed attempt — a
// few tries from each of many addresses stays under every bucket while hammering one username — so
// these drive the handler directly with DIFFERENT client addresses, which is the case that matters.
//
// The limiter is package-level and built once from configuration, so these subtests share one
// budget; they are written to be order-independent by using a distinct username each.
func TestAuthSignin_PerAccountThrottle(t *testing.T) {
	gin.SetMode(gin.TestMode)

	attempt := func(t *testing.T, mockCtrl *gomock.Controller, username, password, clientIP string, found *models.User) *httptest.ResponseRecorder {
		t.Helper()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		appConfig, err := config.Create()
		require.NoError(t, err)
		require.NoError(t, appConfig.Init())
		appConfig.Set("jwt.issuer.key", "test-signing-key-that-is-long-enough")

		if found != nil {
			mockDB.EXPECT().GetUserByUsername(gomock.Any(), username).Return(found, nil).AnyTimes()
		} else {
			mockDB.EXPECT().GetUserByUsername(gomock.Any(), username).Return(nil, errors.New("record not found")).AnyTimes()
		}

		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, appConfig)
		body, _ := json.Marshal(models.User{Username: username, Password: password})
		c.Request, _ = http.NewRequest(http.MethodPost, "/signin", bytes.NewBuffer(body))
		c.Request.Header.Set("Content-Type", "application/json")
		// A different source address every time: the point is that this limit does not depend on it.
		c.Request.RemoteAddr = clientIP + ":12345"
		c.Request.Header.Set("X-Forwarded-For", clientIP)

		handler.AuthSignin(c)
		return w
	}

	t.Run("throttles one account across many source addresses", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()

		const username = "throttle-target"
		var last *httptest.ResponseRecorder
		// Shipped default is 10 per window; the 11th must be refused even though every attempt came
		// from a different address.
		for i := 0; i < 11; i++ {
			last = attempt(t, mockCtrl, username, "wrong-password", fmt.Sprintf("203.0.113.%d", i), nil)
		}

		require.Equal(t, http.StatusTooManyRequests, last.Code,
			"a distributed attempt against one account is exactly what the per-IP limit cannot see")
		require.NotEmpty(t, last.Header().Get("Retry-After"))
		require.Contains(t, last.Body.String(), "too many requests")
		require.NotContains(t, last.Body.String(), username,
			"the refusal must not echo the account name")
	})

	// Enumeration guard: the throttled answer has to look the same whether or not the account is
	// real, or "this one is being throttled" becomes the oracle #104 closed.
	t.Run("refusal is identical for a non-existent account", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()

		var real, fake *httptest.ResponseRecorder
		for i := 0; i < 11; i++ {
			real = attempt(t, mockCtrl, "real-account", "wrong", "198.51.100.1", userWithHashedPassword(t, "real-account", "correct-horse-battery"))
		}
		for i := 0; i < 11; i++ {
			fake = attempt(t, mockCtrl, "no-such-account", "wrong", "198.51.100.2", nil)
		}

		require.Equal(t, real.Code, fake.Code)
		require.Equal(t, real.Body.String(), fake.Body.String())
	})

	// A busy account must not throttle itself. Successes clear the counter, so somebody who fumbles
	// twice and then succeeds does not carry those failures for the rest of the window.
	t.Run("a successful sign-in clears the budget", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()

		const username = "busy-account"
		user := userWithHashedPassword(t, username, "correct-horse-battery")

		for i := 0; i < 9; i++ {
			attempt(t, mockCtrl, username, "wrong", "192.0.2.9", user)
		}
		ok := attempt(t, mockCtrl, username, "correct-horse-battery", "192.0.2.9", user)
		require.Equal(t, http.StatusOK, ok.Code)

		// Nine failures then a success: the counter is cleared, so this is attempt 1 of a new budget
		// rather than 11 of 10.
		for i := 0; i < 9; i++ {
			attempt(t, mockCtrl, username, "wrong", "192.0.2.9", user)
		}
		still := attempt(t, mockCtrl, username, "correct-horse-battery", "192.0.2.9", user)
		require.Equal(t, http.StatusOK, still.Code, "a legitimately busy account must not be throttled for being busy")
	})
}

// userWithHashedPassword builds a user whose stored hash matches plaintext, the way the repository
// stores it.
func userWithHashedPassword(t *testing.T, username, plaintext string) *models.User {
	t.Helper()
	u := &models.User{Username: username, Role: pkg.UserRoleUser}
	require.NoError(t, u.HashPassword(plaintext))
	return u
}

// TestAuthDemoSignin covers the gate, not the happy path alone: the whole value of this endpoint
// is that it is inert unless an operator deliberately enabled demo mode AND supplied a password
// that matches a real account (#495). Each refusal below is a way an instance could otherwise
// hand out a session it never meant to.
func TestAuthDemoSignin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()

	// newDemoContext wires the context every case needs, and returns the recorder to assert on.
	newDemoContext := func(mockDB *mock_database.MockDatabaseRepository, mockConfig *mock_config.MockInterface) (*httptest.ResponseRecorder, *gin.Context) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, mockConfig)
		c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
		c.Request, _ = http.NewRequest(http.MethodPost, "/auth/demo-signin", nil)
		return w, c
	}

	// demoUser builds a user whose stored hash really is `password`, so CheckPassword exercises
	// bcrypt rather than a stubbed comparison.
	demoUser := func(t *testing.T, username, password string) *models.User {
		user := &models.User{Username: username}
		require.NoError(t, user.HashPassword(password))
		return user
	}

	t.Run("refuses with 403 when demo mode is disabled", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockConfig.EXPECT().GetBool("demo.enabled").Return(false)

		w, c := newDemoContext(mockDB, mockConfig)
		handler.AuthDemoSignin(c)

		assert.Equal(t, http.StatusForbidden, w.Code)
		assert.NotContains(t, w.Body.String(), "success\":true")
	})

	t.Run("refuses when enabled but demo.password is empty", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockConfig.EXPECT().GetBool("demo.enabled").Return(true)
		mockConfig.EXPECT().GetString("demo.username").Return("demo")
		mockConfig.EXPECT().GetString("demo.password").Return("")

		w, c := newDemoContext(mockDB, mockConfig)
		handler.AuthDemoSignin(c)

		// An empty password must never read as "no password required".
		assert.Equal(t, http.StatusForbidden, w.Code)
	})

	t.Run("refuses when the configured demo account does not exist", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockConfig.EXPECT().GetBool("demo.enabled").Return(true)
		mockConfig.EXPECT().GetString("demo.username").Return("demo")
		mockConfig.EXPECT().GetString("demo.password").Return("demo123")
		mockDB.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(nil, nil)

		w, c := newDemoContext(mockDB, mockConfig)
		handler.AuthDemoSignin(c)

		assert.Equal(t, http.StatusForbidden, w.Code)
	})

	t.Run("refuses when demo.password does not match the stored hash", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockConfig.EXPECT().GetBool("demo.enabled").Return(true)
		mockConfig.EXPECT().GetString("demo.username").Return("demo")
		mockConfig.EXPECT().GetString("demo.password").Return("wrong-password")
		mockDB.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(demoUser(t, "demo", "demo123"), nil)

		w, c := newDemoContext(mockDB, mockConfig)
		handler.AuthDemoSignin(c)

		// This is what keeps the endpoint an ordinary signin rather than an auth bypass.
		assert.Equal(t, http.StatusForbidden, w.Code)
	})

	t.Run("issues a session when enabled and the password matches", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockConfig.EXPECT().GetBool("demo.enabled").Return(true)
		mockConfig.EXPECT().GetString("demo.username").Return("demo")
		mockConfig.EXPECT().GetString("demo.password").Return("demo123")
		mockDB.EXPECT().GetUserByUsername(gomock.Any(), "demo").Return(demoUser(t, "demo", "demo123"), nil)
		// #506: the policy is read on every signup. Shipped values, so the tests exercise what an
		// instance actually enforces.
		mockConfig.EXPECT().GetInt("password.min_length").Return(8).AnyTimes()
		mockConfig.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_common").Return(true).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_username").Return(true).AnyTimes()
		mockConfig.EXPECT().GetInt("username.min_length").Return(3).AnyTimes()
		mockConfig.EXPECT().GetString("jwt.issuer.key").Return("test_key")
		mockConfig.EXPECT().GetInt("jwt.session_ttl_minutes").Return(60).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_absolute_hours").Return(12).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_renew_if_remaining_minutes").Return(30).AnyTimes()
		mockConfig.EXPECT().GetBool("web.listen.https.enabled").Return(false)

		w, c := newDemoContext(mockDB, mockConfig)
		handler.AuthDemoSignin(c)

		assert.Equal(t, http.StatusOK, w.Code)
		var response map[string]interface{}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
		assert.True(t, response["success"].(bool))
		assert.NotEmpty(t, response["data"])
	})
}

// TestAuthSignup_SignupEnabledGate covers #498. The gate itself is one line; the exemption below
// it is the part that must never regress, so it gets its own case with an explicit explanation.
func TestAuthSignup_SignupEnabledGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()

	newSignupRequest := func(mockDB *mock_database.MockDatabaseRepository, mockConfig *mock_config.MockInterface, username string) (*httptest.ResponseRecorder, *gin.Context) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, mockConfig)
		body, _ := json.Marshal(handler.UserWizard{User: &models.User{Username: username, Password: "testpass"}})
		c.Request, _ = http.NewRequest(http.MethodPost, "/signup", bytes.NewBuffer(body))
		c.Request.Header.Set("Content-Type", "application/json")
		return w, c
	}

	t.Run("refuses a new account when signup is closed and users already exist", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockDB.EXPECT().GetUserCount(gomock.Any()).Return(1, nil)
		mockConfig.EXPECT().GetBool("signup.enabled").Return(false)
		// The refusal must happen before any account is written.
		mockDB.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)

		w, c := newSignupRequest(mockDB, mockConfig, "stranger")
		handler.AuthSignup(c)

		assert.Equal(t, http.StatusForbidden, w.Code)
	})

	// THE exemption. The first account on an empty database is the instance owner and the only
	// path to an admin — no seeded admin, no CLI user-create, no password reset. If this test
	// fails, a fresh deployment shipping with signup closed cannot be administered at all, and the
	// only way in is editing the database by hand. Deleting the userCount check in AuthSignup is
	// what this catches.
	t.Run("allows the FIRST user even when signup is closed, and makes them admin", func(t *testing.T) {
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockDB.EXPECT().GetUserCount(gomock.Any()).Return(0, nil)
		mockDB.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Do(func(_ interface{}, user *models.User) {
			assert.Equal(t, pkg.UserRoleAdmin, user.Role, "the first user owns the instance")
		}).Return(nil)
		// #506: the policy is read on every signup. Shipped values, so the tests exercise what an
		// instance actually enforces.
		mockConfig.EXPECT().GetInt("password.min_length").Return(8).AnyTimes()
		mockConfig.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_common").Return(true).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_username").Return(true).AnyTimes()
		mockConfig.EXPECT().GetInt("username.min_length").Return(3).AnyTimes()
		mockConfig.EXPECT().GetString("jwt.issuer.key").Return("test_key")
		mockConfig.EXPECT().GetInt("jwt.session_ttl_minutes").Return(60).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_absolute_hours").Return(12).AnyTimes()
		mockConfig.EXPECT().GetInt("jwt.session_renew_if_remaining_minutes").Return(30).AnyTimes()
		mockConfig.EXPECT().GetBool("web.listen.https.enabled").Return(false)

		w, c := newSignupRequest(mockDB, mockConfig, "owner")
		handler.AuthSignup(c)

		assert.Equal(t, http.StatusOK, w.Code)
	})
}

// The generated password sits in a 0600 file inside the data root, which is by definition what a
// backup contains (#466/#504). Signin deletes it once the credential has actually been used, so it
// stops riding along in every later archive.
//
// KEYED ON THE VALUE, not the username (#510). It used to fire only for bootstrap.admin.username,
// which meant the file written by `fasten reset-password` — for any account, on an instance that may
// never have used bootstrap provisioning — sat there forever while the command claimed otherwise.
// Comparing what was typed against the file deletes it exactly when the credential demonstrably
// reached its owner, whichever path wrote it.
func TestAuthSignin_ClearsBootstrapPasswordFile(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()

	signin := func(t *testing.T, dataDir, bootstrapUsername string, user *models.User) *httptest.ResponseRecorder {
		t.Helper()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockDB.EXPECT().GetUserByUsername(gomock.Any(), user.Username).Return(user, nil)
		mockConfig.EXPECT().GetString("bootstrap.admin.username").Return(bootstrapUsername).AnyTimes()
		mockConfig.EXPECT().GetString("storage.data_dir").Return(dataDir).AnyTimes()
		mockConfig.EXPECT().GetString("database.location").Return(filepath.Join(dataDir, "fasten.db")).AnyTimes()
		// #506: the policy is read on every signup. Shipped values, so the tests exercise what an
		// instance actually enforces.
		mockConfig.EXPECT().GetInt("password.min_length").Return(8).AnyTimes()
		mockConfig.EXPECT().GetInt("password.max_length").Return(69).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_common").Return(true).AnyTimes()
		mockConfig.EXPECT().GetBool("password.deny_username").Return(true).AnyTimes()
		mockConfig.EXPECT().GetInt("username.min_length").Return(3).AnyTimes()
		mockConfig.EXPECT().GetString("jwt.issuer.key").Return("test_key")
		mockConfig.EXPECT().GetInt(gomock.Any()).Return(60).AnyTimes()
		mockConfig.EXPECT().GetBool("web.listen.https.enabled").Return(false)

		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, mockConfig)
		c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
		body, _ := json.Marshal(models.User{Username: user.Username, Password: "correct-horse"})
		c.Request, _ = http.NewRequest(http.MethodPost, "/auth/signin", bytes.NewBuffer(body))
		c.Request.Header.Set("Content-Type", "application/json")

		handler.AuthSignin(c)
		return w
	}

	adminUser := func(t *testing.T, username string) *models.User {
		u := &models.User{Username: username, Role: pkg.UserRoleAdmin}
		require.NoError(t, u.HashPassword("correct-horse"))
		return u
	}

	t.Run("removes the file when the provisioned admin signs in with it", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, handler.BootstrapAdminPasswordFile)
		require.NoError(t, os.WriteFile(path, []byte("correct-horse"), 0o600))

		w := signin(t, dir, "admindemo", adminUser(t, "admindemo"))

		assert.Equal(t, http.StatusOK, w.Code)
		_, err := os.Stat(path)
		assert.True(t, os.IsNotExist(err), "the credential should not outlive its first use")
	})

	// The #510 case: `fasten reset-password --username jim` writes the same file for an ordinary
	// account on an instance where bootstrap.admin.username is empty. Under the old username-keyed
	// rule the file survived forever and the command's own output was wrong about it.
	t.Run("removes the file after a CLI reset, for a non-admin with no bootstrap admin configured", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, handler.BootstrapAdminPasswordFile)
		require.NoError(t, os.WriteFile(path, []byte("correct-horse"), 0o600))

		ordinary := &models.User{Username: "jim", Role: pkg.UserRoleUser}
		require.NoError(t, ordinary.HashPassword("correct-horse"))

		w := signin(t, dir, "", ordinary)

		assert.Equal(t, http.StatusOK, w.Code)
		_, err := os.Stat(path)
		assert.True(t, os.IsNotExist(err), "a reset credential must not outlive its first use either")
	})

	// Somebody else signing in with their OWN password must not consume a credential written for a
	// different account — the file is still waiting for the person it was generated for.
	t.Run("leaves it alone when a different password is used", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, handler.BootstrapAdminPasswordFile)
		require.NoError(t, os.WriteFile(path, []byte("a-different-generated-value"), 0o600))

		w := signin(t, dir, "admindemo", adminUser(t, "someone-else"))

		assert.Equal(t, http.StatusOK, w.Code)
		_, err := os.Stat(path)
		assert.NoError(t, err, "the file belongs to whoever it was generated for, not to the next person who signs in")
	})
}
