package handler_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
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

		c, w := changePasswordContext(t, mockDB, gin.H{"current_password": "oldpass", "new_password": "newpass123"})
		handler.ChangePassword(c)

		assert.Equal(t, http.StatusOK, w.Code)
	})

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
