package middleware_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	mock_config "github.com/fastenhealth/fasten-onprem/backend/pkg/config/mock"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/middleware"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

// The guard's whole job is keeping a visitor's REAL provider data out of the shared public-demo
// account (#496). Each case below is a way that could go wrong, so each is pinned:
//   - it must not fire on ordinary installs (demo.enabled false is the shipped default)
//   - it must fire for the demo account, verified by calling the route, not by reading the UI
//   - it must NOT fire for the operator's own account on the same instance, or the demo's seed
//     data could never be refreshed
//   - it must fail CLOSED when the caller cannot be identified while demo mode is on
func TestBlockForDemoAccount(t *testing.T) {
	gin.SetMode(gin.TestMode)

	run := func(t *testing.T, setup func(*mock_config.MockInterface, *mock_database.MockDatabaseRepository)) *httptest.ResponseRecorder {
		t.Helper()
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()

		cfg := mock_config.NewMockInterface(ctrl)
		db := mock_database.NewMockDatabaseRepository(ctrl)
		setup(cfg, db)

		r := gin.New()
		r.Use(func(c *gin.Context) {
			c.Set(pkg.ContextKeyTypeConfig, cfg)
			c.Set(pkg.ContextKeyTypeDatabase, db)
			c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
			c.Next()
		})
		r.POST("/source/authorize", middleware.BlockForDemoAccount(), func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"success": true})
		})

		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/source/authorize", nil))
		return w
	}

	t.Run("does nothing on an ordinary install", func(t *testing.T) {
		w := run(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(false)
			// No user lookup at all — the guard must not add a database round-trip to every
			// connect on instances that will never run a demo.
			db.EXPECT().GetCurrentUser(gomock.Any()).Times(0)
		})
		require.Equal(t, http.StatusOK, w.Code)
	})

	t.Run("blocks the demo account with a machine-readable code", func(t *testing.T) {
		w := run(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("demo")
			db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "demo"}, nil)
		})
		require.Equal(t, http.StatusForbidden, w.Code)
		require.Contains(t, w.Body.String(), middleware.DemoErrorCode,
			"the frontend keys off this code rather than matching an English sentence")
	})

	// Without this, refreshing the demo's seed data would mean turning demo mode off and on again
	// on a live public instance — with a window where the guard is not running.
	t.Run("leaves the operator's own account alone on the same instance", func(t *testing.T) {
		w := run(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("demo")
			db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "admindemo"}, nil)
		})
		require.Equal(t, http.StatusOK, w.Code)
	})

	t.Run("fails closed when the caller cannot be identified", func(t *testing.T) {
		w := run(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("demo")
			db.EXPECT().GetCurrentUser(gomock.Any()).Return(nil, errors.New("boom"))
		})
		require.Equal(t, http.StatusForbidden, w.Code,
			"an unidentified caller on a public shared instance must not reach the connect routes")
	})

	// An operator who enables demo mode without naming an account has not configured a demo; the
	// guard has no account to protect and must not lock out every user on the instance.
	t.Run("does nothing when demo.username is unset", func(t *testing.T) {
		w := run(t, func(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
			cfg.EXPECT().GetBool("demo.enabled").Return(true)
			cfg.EXPECT().GetString("demo.username").Return("")
			db.EXPECT().GetCurrentUser(gomock.Any()).Times(0)
		})
		require.Equal(t, http.StatusOK, w.Code)
	})
}
