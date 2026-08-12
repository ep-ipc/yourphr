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

// demoAdminRouter mounts the guard on a /api/secure group the way server.go does, so the tests
// exercise real route matching — c.FullPath() is what the guard reads, and it only means anything on
// a registered route.
func demoAdminRouter(
	t *testing.T,
	cfg *mock_config.MockInterface,
	db *mock_database.MockDatabaseRepository,
	handled *bool,
	routes ...struct{ method, path string },
) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(pkg.ContextKeyTypeConfig, cfg)
		c.Set(pkg.ContextKeyTypeDatabase, db)
		c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
		c.Next()
	})
	secure := r.Group("/api/secure").Use(middleware.RestrictDemoAdmin())
	for _, route := range routes {
		secure.Handle(route.method, route.path, func(c *gin.Context) {
			*handled = true
			c.JSON(http.StatusOK, gin.H{"success": true})
		})
	}
	return r
}

func asDemoAdmin(cfg *mock_config.MockInterface, db *mock_database.MockDatabaseRepository) {
	cfg.EXPECT().GetBool("demo.enabled").Return(true).AnyTimes()
	cfg.EXPECT().GetBool("demo.admin.enabled").Return(true).AnyTimes()
	cfg.EXPECT().GetString("demo.admin.username").Return("demoadmin").AnyTimes()
	db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "demoadmin", Role: pkg.UserRoleAdmin}, nil).AnyTimes()
}

// Every case here is the same question from a different angle: can a stranger who clicked "explore
// the admin" change anything, or read anything they should not?
func TestRestrictDemoAdmin(t *testing.T) {
	gin.SetMode(gin.TestMode)

	type route = struct{ method, path string }

	t.Run("allows reads", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		cfg, db := mock_config.NewMockInterface(ctrl), mock_database.NewMockDatabaseRepository(ctrl)
		asDemoAdmin(cfg, db)

		handled := false
		r := demoAdminRouter(t, cfg, db, &handled, route{http.MethodGet, "/admin/config"})

		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/secure/admin/config", nil))

		require.Equal(t, http.StatusOK, w.Code)
		require.True(t, handled, "the whole point is that the demo admin can LOOK")
	})

	// Fasten queries records over POST, so a plain GET-only rule would show a demo admin empty
	// screens and teach nobody anything about the product.
	t.Run("allows the read-only POST routes the UI needs", func(t *testing.T) {
		for _, r := range []route{
			{http.MethodPost, "/query"},
			{http.MethodPost, "/resource/graph/:graphType"},
		} {
			ctrl := gomock.NewController(t)
			cfg, db := mock_config.NewMockInterface(ctrl), mock_database.NewMockDatabaseRepository(ctrl)
			asDemoAdmin(cfg, db)

			handled := false
			router := demoAdminRouter(t, cfg, db, &handled, r)
			path := "/api/secure/query"
			if r.path != "/query" {
				path = "/api/secure/resource/graph/AllergyIntolerance"
			}

			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, nil))

			require.Equal(t, http.StatusOK, w.Code, r.path)
			require.True(t, handled, r.path)
			ctrl.Finish()
		}
	})

	// DEFAULT-DENY is the property under test. #514 happened because a guard enumerated the
	// dangerous routes and two were missed, so what matters is that an ARBITRARY mutation — including
	// one nobody thought of when the guard was written — is refused without being named.
	t.Run("refuses every mutation, including routes the guard does not know about", func(t *testing.T) {
		for _, r := range []route{
			{http.MethodPut, "/admin/config"},
			{http.MethodDelete, "/admin/config/:key"},
			{http.MethodPost, "/admin/database/restore"},
			{http.MethodPut, "/admin/log-level"},
			{http.MethodPost, "/users"},
			{http.MethodDelete, "/account/me"},
			{http.MethodPost, "/account/password"},
			{http.MethodPatch, "/resource/fhir/:resourceType/:resourceId"},
			{http.MethodPost, "/some/route/invented/next/year"},
		} {
			ctrl := gomock.NewController(t)
			cfg, db := mock_config.NewMockInterface(ctrl), mock_database.NewMockDatabaseRepository(ctrl)
			asDemoAdmin(cfg, db)

			handled := false
			router := demoAdminRouter(t, cfg, db, &handled, r)

			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(r.method, "/api/secure"+r.path, nil))

			require.Equal(t, http.StatusForbidden, w.Code, r.path)
			require.False(t, handled, "%s %s: the handler must not run", r.method, r.path)
			require.Contains(t, w.Body.String(), middleware.DemoErrorCode, r.path)
			ctrl.Finish()
		}
	})

	// Read-only is not the same as harmless. One hands out configured secrets; the other enumerates
	// directories on the machine the instance runs on.
	t.Run("refuses reads that leak secrets or the filesystem", func(t *testing.T) {
		for _, r := range []struct{ registered, request string }{
			{"/admin/config/reveal/:key", "/api/secure/admin/config/reveal/relay.secret"},
			{"/admin/database/browse", "/api/secure/admin/database/browse"},
		} {
			ctrl := gomock.NewController(t)
			cfg, db := mock_config.NewMockInterface(ctrl), mock_database.NewMockDatabaseRepository(ctrl)
			asDemoAdmin(cfg, db)

			handled := false
			router := demoAdminRouter(t, cfg, db, &handled, route{http.MethodGet, r.registered})

			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, r.request, nil))

			require.Equal(t, http.StatusForbidden, w.Code, r.registered)
			require.False(t, handled, "%s: the handler must not run", r.registered)
			ctrl.Finish()
		}
	})

	// The operator administers the demo host through the same API. If this fired on them, enabling
	// the demo admin would cost the operator their own instance.
	t.Run("leaves the operator's own admin alone", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		cfg, db := mock_config.NewMockInterface(ctrl), mock_database.NewMockDatabaseRepository(ctrl)
		cfg.EXPECT().GetBool("demo.enabled").Return(true).AnyTimes()
		cfg.EXPECT().GetBool("demo.admin.enabled").Return(true).AnyTimes()
		cfg.EXPECT().GetString("demo.admin.username").Return("demoadmin").AnyTimes()
		db.EXPECT().GetCurrentUser(gomock.Any()).Return(&models.User{Username: "admindemo", Role: pkg.UserRoleAdmin}, nil)

		handled := false
		r := demoAdminRouter(t, cfg, db, &handled, route{http.MethodPut, "/admin/config"})

		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/secure/admin/config", nil))

		require.Equal(t, http.StatusOK, w.Code)
		require.True(t, handled)
	})

	// On an ordinary install this middleware sits on every authenticated request, so it must cost
	// nothing: no user lookup, no behaviour change.
	t.Run("does nothing on an ordinary install", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		cfg, db := mock_config.NewMockInterface(ctrl), mock_database.NewMockDatabaseRepository(ctrl)
		cfg.EXPECT().GetBool("demo.enabled").Return(false)
		db.EXPECT().GetCurrentUser(gomock.Any()).Times(0)

		handled := false
		r := demoAdminRouter(t, cfg, db, &handled, route{http.MethodPut, "/admin/config"})

		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/secure/admin/config", nil))

		require.Equal(t, http.StatusOK, w.Code)
		require.True(t, handled)
	})

	// A demo running only the patient tour has no read-only account to restrict, and restricting
	// nothing must not restrict everyone.
	t.Run("does nothing when the demo admin is not enabled", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		cfg, db := mock_config.NewMockInterface(ctrl), mock_database.NewMockDatabaseRepository(ctrl)
		cfg.EXPECT().GetBool("demo.enabled").Return(true)
		cfg.EXPECT().GetBool("demo.admin.enabled").Return(false)
		db.EXPECT().GetCurrentUser(gomock.Any()).Times(0)

		handled := false
		r := demoAdminRouter(t, cfg, db, &handled, route{http.MethodPut, "/admin/config"})

		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/secure/admin/config", nil))

		require.Equal(t, http.StatusOK, w.Code)
	})

	t.Run("fails closed when the caller cannot be identified", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		cfg, db := mock_config.NewMockInterface(ctrl), mock_database.NewMockDatabaseRepository(ctrl)
		cfg.EXPECT().GetBool("demo.enabled").Return(true).AnyTimes()
		cfg.EXPECT().GetBool("demo.admin.enabled").Return(true).AnyTimes()
		cfg.EXPECT().GetString("demo.admin.username").Return("demoadmin").AnyTimes()
		db.EXPECT().GetCurrentUser(gomock.Any()).Return(nil, errors.New("boom"))

		handled := false
		r := demoAdminRouter(t, cfg, db, &handled, route{http.MethodGet, "/admin/config"})

		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/secure/admin/config", nil))

		require.Equal(t, http.StatusForbidden, w.Code)
		require.False(t, handled)
	})
}
