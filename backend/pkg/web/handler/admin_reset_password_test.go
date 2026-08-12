package handler_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/handler"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An admin sets another user's password (#511) — the family case, somebody forgot theirs.
//
// Admin-gating is enforced in the handler, so the non-admin case is asserted by DRIVING the handler
// rather than by trusting the route: a disabled button is not a control, and this endpoint hands out
// a working credential for somebody else's health record.
func adminResetContext(t *testing.T, db *mock_database.MockDatabaseRepository, userID string) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	appConfig, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, appConfig.Init())

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set(pkg.ContextKeyTypeDatabase, db)
	c.Set(pkg.ContextKeyTypeConfig, appConfig)
	c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
	c.Params = gin.Params{{Key: "id", Value: userID}}
	c.Request, _ = http.NewRequest(http.MethodPost, "/secure/users/"+userID+"/password", bytes.NewBuffer([]byte("{}")))
	c.Request.Header.Set("Content-Type", "application/json")
	return c, w
}

func TestAdminResetUserPassword(t *testing.T) {
	t.Run("sets a generated password, returns it once, and revokes sessions", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		db := mock_database.NewMockDatabaseRepository(ctrl)

		var storedHash string
		var updatedFor string
		db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "admin", Role: pkg.UserRoleAdmin}, nil)
		db.EXPECT().GetUserByID(gomock.Any(), "user-123").Return(&models.User{Username: "kid", Role: pkg.UserRoleUser}, nil)
		db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).DoAndReturn(
			func(ctx interface{ Value(any) any }, hashed string) error {
				storedHash = hashed
				if u, ok := ctx.Value(pkg.ContextKeyTypeAuthUsername).(string); ok {
					updatedFor = u
				}
				return nil
			})
		// #508: a reset is often a response to a compromised account, so the sessions it already had
		// must not survive.
		db.EXPECT().BumpUserTokenGeneration(gomock.Any(), "kid").Return(nil)

		c, w := adminResetContext(t, db, "user-123")
		handler.AdminResetUserPassword(c)

		require.Equal(t, http.StatusOK, w.Code)

		var body struct {
			Data struct {
				Username string `json:"username"`
				Password string `json:"password"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		assert.Equal(t, "kid", body.Data.Username)
		require.Len(t, body.Data.Password, 32, "24 random bytes, base64url")

		// The password must be updated on the TARGET, not on the admin who happens to be signed in —
		// UpdateUserPassword resolves its user from the context.
		assert.Equal(t, "kid", updatedFor)

		// What is stored is a HASH of what was returned. Storing the plaintext, or hashing a hash,
		// are the two ways this goes wrong (#504).
		assert.NotEqual(t, body.Data.Password, storedHash)
		check := &models.User{Password: storedHash}
		assert.NoError(t, check.CheckPassword(body.Data.Password), "the user must be able to sign in with what was returned")
	})

	// The load-bearing authorization test. This endpoint returns a working credential for another
	// person's health record, so "admin only" has to hold at the handler.
	t.Run("refuses a non-admin", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		db := mock_database.NewMockDatabaseRepository(ctrl)

		db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "kid", Role: pkg.UserRoleUser}, nil)
		db.EXPECT().GetUserByID(gomock.Any(), gomock.Any()).Times(0)
		db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Times(0)

		c, w := adminResetContext(t, db, "user-123")
		handler.AdminResetUserPassword(c)

		assert.Equal(t, http.StatusUnauthorized, w.Code)
		assert.NotContains(t, w.Body.String(), "password")
	})

	t.Run("404s for an unknown user without touching anything", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		db := mock_database.NewMockDatabaseRepository(ctrl)

		db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "admin", Role: pkg.UserRoleAdmin}, nil)
		db.EXPECT().GetUserByID(gomock.Any(), "missing").Return(nil, errors.New("record not found"))
		db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Times(0)
		db.EXPECT().BumpUserTokenGeneration(gomock.Any(), gomock.Any()).Times(0)

		c, w := adminResetContext(t, db, "missing")
		handler.AdminResetUserPassword(c)

		assert.Equal(t, http.StatusNotFound, w.Code)
	})

	// The password is already changed by the time the bump runs, so a revocation failure must not
	// report failure and send an admin round the loop again — but it must be logged.
	t.Run("still returns the password when the session bump fails", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		db := mock_database.NewMockDatabaseRepository(ctrl)

		db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "admin", Role: pkg.UserRoleAdmin}, nil)
		db.EXPECT().GetUserByID(gomock.Any(), "user-123").Return(&models.User{Username: "kid"}, nil)
		db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
		db.EXPECT().BumpUserTokenGeneration(gomock.Any(), "kid").Return(errors.New("database is locked"))

		c, w := adminResetContext(t, db, "user-123")
		handler.AdminResetUserPassword(c)

		assert.Equal(t, http.StatusOK, w.Code)
	})
}

// The generated value exists in exactly one place — the response. A log line carrying it would put
// another person's credential into every sink the instance ships to.
func TestAdminResetUserPasswordNeverLogsTheValue(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	db := mock_database.NewMockDatabaseRepository(ctrl)

	db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "admin", Role: pkg.UserRoleAdmin}, nil)
	db.EXPECT().GetUserByID(gomock.Any(), "user-123").Return(&models.User{Username: "kid"}, nil)
	db.EXPECT().UpdateUserPassword(gomock.Any(), gomock.Any()).Return(nil)
	db.EXPECT().BumpUserTokenGeneration(gomock.Any(), "kid").Return(nil)

	captured := &adminResetCaptureHook{}
	log := logrus.New()
	log.AddHook(captured)
	log.SetLevel(logrus.DebugLevel)

	c, w := adminResetContext(t, db, "user-123")
	c.Set(pkg.ContextKeyTypeLogger, logrus.NewEntry(log))
	handler.AdminResetUserPassword(c)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			Password string `json:"password"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.Password)

	for _, line := range captured.lines {
		require.NotContains(t, line, body.Data.Password)
	}
}

type adminResetCaptureHook struct{ lines []string }

func (h *adminResetCaptureHook) Levels() []logrus.Level { return logrus.AllLevels }
func (h *adminResetCaptureHook) Fire(entry *logrus.Entry) error {
	h.lines = append(h.lines, entry.Message)
	return nil
}
