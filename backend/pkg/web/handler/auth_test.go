package handler_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
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
				Password: "testpass",
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
		mockDB.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Do(func(_ interface{}, user *models.User) {
			assert.Equal(t, pkg.UserRoleUser, user.Role)
		}).Return(nil)
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
				Password: "testpass2",
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
