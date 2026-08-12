package handler_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	mock_config "github.com/fastenhealth/fasten-onprem/backend/pkg/config/mock"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/handler"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func changePasswordContext(t *testing.T, mockDB *mock_database.MockDatabaseRepository, body interface{}) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", "account"))
	c.Set(pkg.ContextKeyTypeDatabase, mockDB)
	// A NEW password must satisfy the instance policy (#506), so the handler reads config. Real
	// values rather than a permissive stub, so these tests exercise what an instance enforces.
	appConfig, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, appConfig.Init())
	// A real signing key: ChangePassword re-issues the caller's session after bumping the generation
	// (#508), and without a key that re-issue silently fails to the no-token branch.
	appConfig.Set("jwt.issuer.key", "test-signing-key-that-is-long-enough")
	c.Set(pkg.ContextKeyTypeConfig, appConfig)
	jsonData, _ := json.Marshal(body)
	c.Request, _ = http.NewRequest(http.MethodPost, "/account/password", bytes.NewBuffer(jsonData))
	c.Request.Header.Set("Content-Type", "application/json")
	return c, w
}

// userWithPassword builds a User whose stored hash matches the given plaintext.
func userWithPassword(t *testing.T, plaintext string) *models.User {
	t.Helper()
	u := &models.User{Username: "testuser"}
	assert.NoError(t, u.HashPassword(plaintext))
	return u
}

func TestChangePassword(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("succeeds with the correct current password", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

		mockDB.EXPECT().GetCurrentUser(gomock.Any()).Return(userWithPassword(t, "oldpass"), nil)
		mockDB.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
		// #508: changing a password must end every other session, or a stolen one survives the very
		// action taken to evict it.
		mockDB.EXPECT().BumpUserTokenGeneration(gomock.Any(), "testuser").Return(nil)

		c, w := changePasswordContext(t, mockDB, gin.H{"current_password": "oldpass", "new_password": "newpass123"})
		handler.ChangePassword(c)

		assert.Equal(t, http.StatusOK, w.Code)
	})

	// The caller who just changed their own password must NOT be signed out by their own action, so a
	// fresh token at the new generation is issued back.
	t.Run("re-issues a session for the caller at the new generation", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

		user := userWithPassword(t, "oldpass")
		user.TokenGeneration = 4
		mockDB.EXPECT().GetCurrentUser(gomock.Any()).Return(user, nil)
		mockDB.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
		mockDB.EXPECT().BumpUserTokenGeneration(gomock.Any(), "testuser").Return(nil)

		c, w := changePasswordContext(t, mockDB, gin.H{"current_password": "oldpass", "new_password": "newpass123"})
		handler.ChangePassword(c)

		assert.Equal(t, http.StatusOK, w.Code)

		var body struct {
			Data string `json:"data"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		require.NotEmpty(t, body.Data, "a replacement session token must come back")

		claims, err := auth.JwtValidateFastenToken(c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface).GetString("jwt.issuer.key"), body.Data)
		require.NoError(t, err)
		assert.Equal(t, 5, claims.TokenGeneration,
			"the new token must carry the BUMPED generation, or the caller's own session is stale immediately")
	})

	// The password is already changed by this point, so the request did not fail — but leaving other
	// sessions alive is exactly what the user was trying to prevent, so it must not report success.
	t.Run("reports failure when sessions cannot be revoked", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

		mockDB.EXPECT().GetCurrentUser(gomock.Any()).Return(userWithPassword(t, "oldpass"), nil)
		mockDB.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
		mockDB.EXPECT().BumpUserTokenGeneration(gomock.Any(), "testuser").Return(errors.New("database is locked"))

		c, w := changePasswordContext(t, mockDB, gin.H{"current_password": "oldpass", "new_password": "newpass123"})
		handler.ChangePassword(c)

		assert.Equal(t, http.StatusInternalServerError, w.Code)
		assert.Contains(t, w.Body.String(), "sign out everywhere",
			"the user must be told what to do about the sessions that are still alive")
	})
}

// SignOutEverywhere ends the caller's own session too — that is what "everywhere" means to somebody
// who believes their sessions are not trustworthy.
func TestSignOutEverywhere(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("bumps the generation and clears the cookie", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

		mockDB.EXPECT().GetCurrentUser(gomock.Any()).Return(userWithPassword(t, "oldpass"), nil)
		mockDB.EXPECT().BumpUserTokenGeneration(gomock.Any(), "testuser").Return(nil)

		c, w := changePasswordContext(t, mockDB, gin.H{})
		handler.SignOutEverywhere(c)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Header().Get("Set-Cookie"), pkg.SessionCookieName)
		assert.Contains(t, w.Header().Get("Set-Cookie"), "Max-Age=0",
			"the caller's own cookie is cleared — they asked to be signed out everywhere")
	})

	t.Run("reports failure when the bump fails", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

		mockDB.EXPECT().GetCurrentUser(gomock.Any()).Return(userWithPassword(t, "oldpass"), nil)
		mockDB.EXPECT().BumpUserTokenGeneration(gomock.Any(), "testuser").Return(errors.New("boom"))

		c, w := changePasswordContext(t, mockDB, gin.H{})
		handler.SignOutEverywhere(c)

		assert.Equal(t, http.StatusInternalServerError, w.Code)
	})
}

// The remaining change-password cases: current-password verification and the empty-password guard.
func TestChangePassword_Rejections(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("rejects an incorrect current password (no DB write)", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

		mockDB.EXPECT().GetCurrentUser(gomock.Any()).Return(userWithPassword(t, "oldpass"), nil)
		// UpdateUserPassword must NOT be called — gomock fails the test if it is.

		c, w := changePasswordContext(t, mockDB, gin.H{"current_password": "wrongpass", "new_password": "newpass123"})
		handler.ChangePassword(c)

		assert.Equal(t, http.StatusUnauthorized, w.Code)
	})

	t.Run("rejects an empty new password", func(t *testing.T) {
		mockCtrl := gomock.NewController(t)
		defer mockCtrl.Finish()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)

		mockDB.EXPECT().GetCurrentUser(gomock.Any()).Return(userWithPassword(t, "oldpass"), nil)

		c, w := changePasswordContext(t, mockDB, gin.H{"current_password": "oldpass", "new_password": "   "})
		handler.ChangePassword(c)

		assert.Equal(t, http.StatusBadRequest, w.Code)
	})
}

// GetCurrentUser carries demo_account so the UI can render the connect affordances as disabled
// instead of offering actions the server will refuse (#496). Derived server-side on purpose:
// demo.username is NOT published, because naming the shared demo account hands out half a
// credential. These cases pin that the flag is true ONLY for the configured demo account.
func TestGetCurrentUser_DemoAccountFlag(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()

	call := func(t *testing.T, demoEnabled bool, demoUsername, currentUsername string) map[string]interface{} {
		t.Helper()
		mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
		mockConfig := mock_config.NewMockInterface(mockCtrl)
		mockDB.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: currentUsername}, nil)
		mockConfig.EXPECT().GetBool("demo.enabled").Return(demoEnabled).AnyTimes()
		mockConfig.EXPECT().GetString("demo.username").Return(demoUsername).AnyTimes()

		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeConfig, mockConfig)
		c.Request, _ = http.NewRequest(http.MethodGet, "/account/me", nil)

		handler.GetCurrentUser(c)
		assert.Equal(t, http.StatusOK, w.Code)
		var resp map[string]interface{}
		assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
		return resp["data"].(map[string]interface{})
	}

	t.Run("false on an ordinary install", func(t *testing.T) {
		assert.Equal(t, false, call(t, false, "demo", "demo")["demo_account"],
			"demo mode off means no account is the demo account, whatever it is called")
	})

	t.Run("true for the configured demo account", func(t *testing.T) {
		assert.Equal(t, true, call(t, true, "demo", "demo")["demo_account"])
	})

	t.Run("false for another user on the same demo instance", func(t *testing.T) {
		assert.Equal(t, false, call(t, true, "demo", "admindemo")["demo_account"],
			"the operator's own account keeps full function on a demo instance")
	})

	t.Run("never leaks demo.username", func(t *testing.T) {
		data := call(t, true, "demo", "admindemo")
		assert.NotContains(t, data, "demo_username")
	})
}
