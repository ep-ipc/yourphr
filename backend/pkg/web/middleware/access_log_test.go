package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// accessLogRouter registers a route the way server.go does — auth context stubbed, repo injected —
// so the middleware sees realistic FullPath values.
func accessLogRouter(mockDB *mock_database.MockDatabaseRepository) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(pkg.ContextKeyTypeDatabase, mockDB)
		c.Set(pkg.ContextKeyTypeAuthUsername, "testuser")
	})
	router.Use(AccessLog())
	ok := func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"success": true}) }
	router.GET("/api/secure/conditions/classified", ok)
	router.GET("/api/secure/source/:sourceId/export", ok)
	router.GET("/api/secure/account/me", ok)
	router.PATCH("/api/secure/resource/fhir/:resourceType/:resourceId", ok)
	router.POST("/api/secure/summary/ips/email", ok)
	return router
}

func perform(router *gin.Engine, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	router.ServeHTTP(w, req)
	return w
}

// A record-reading route is logged under its legible category.
func TestAccessLog_RecordsListedReads(t *testing.T) {
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
	mockDB.EXPECT().RecordAccessEvent(gomock.Any(), "Conditions").Return(nil)
	mockDB.EXPECT().RecordAccessEvent(gomock.Any(), "Full export").Return(nil)

	router := accessLogRouter(mockDB)
	require.Equal(t, http.StatusOK, perform(router, http.MethodGet, "/api/secure/conditions/classified").Code)
	require.Equal(t, http.StatusOK, perform(router, http.MethodGet, "/api/secure/source/abc/export").Code)
}

// Account settings are not an access of the patient's record; writes are the user's own acts. The
// IPS email share is the deliberate non-GET exception because it sends the summary out.
func TestAccessLog_SkipsUnlistedAndWrites(t *testing.T) {
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
	mockDB.EXPECT().RecordAccessEvent(gomock.Any(), "Summary shared by email").Return(nil)

	router := accessLogRouter(mockDB)
	require.Equal(t, http.StatusOK, perform(router, http.MethodGet, "/api/secure/account/me").Code)
	require.Equal(t, http.StatusOK, perform(router, http.MethodPatch, "/api/secure/resource/fhir/Condition/abc").Code)
	require.Equal(t, http.StatusOK, perform(router, http.MethodPost, "/api/secure/summary/ips/email").Code)
}

// A failing log write must never break the read it is logging.
func TestAccessLog_LoggingFailureDoesNotBreakTheRead(t *testing.T) {
	mockCtrl := gomock.NewController(t)
	defer mockCtrl.Finish()
	mockDB := mock_database.NewMockDatabaseRepository(mockCtrl)
	mockDB.EXPECT().RecordAccessEvent(gomock.Any(), "Conditions").Return(errors.New("database is down"))

	router := accessLogRouter(mockDB)
	require.Equal(t, http.StatusOK, perform(router, http.MethodGet, "/api/secure/conditions/classified").Code)
}
