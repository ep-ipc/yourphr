package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	mock_database "github.com/fastenhealth/fasten-onprem/backend/pkg/database/mock"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/middleware"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// Session revocation (#508). Session JWTs are stateless, so before token_generation a stolen session
// survived the password change made to evict it — the one action a user takes after a compromise did
// nothing, which is why this was filed as a bug rather than a feature.
//
// The tests that matter here are the two extremes: a token from before a bump must stop working, and
// a token that predates the FEATURE (no claim at all) must keep working, or deploying it would sign
// out every user on every instance.
func revocationRouter(t *testing.T, db *mock_database.MockDatabaseRepository, signingKey string) (*gin.Engine, *bool) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	appConfig, err := config.Create()
	require.NoError(t, err)
	require.NoError(t, appConfig.Init())
	appConfig.Set("jwt.issuer.key", signingKey)

	handled := false
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(pkg.ContextKeyTypeConfig, appConfig)
		c.Set(pkg.ContextKeyTypeDatabase, db)
		c.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", t.Name()))
		c.Next()
	})
	r.GET("/api/secure/summary", middleware.RequireAuth(), func(c *gin.Context) {
		handled = true
		c.JSON(http.StatusOK, gin.H{"success": true})
	})
	return r, &handled
}

func requestWithToken(r *gin.Engine, token string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/secure/summary", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	return w
}

func TestRequireAuth_RevokesSessionsBelowTheUsersGeneration(t *testing.T) {
	const key = "test-signing-key-that-is-long-enough"

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	db := mock_database.NewMockDatabaseRepository(ctrl)

	// The token was issued while the user was at generation 1...
	token, err := auth.JwtGenerateFastenTokenFromUser(
		models.User{Username: "jim", Role: pkg.UserRoleUser, TokenGeneration: 1}, key)
	require.NoError(t, err)

	// ...and the account has since been bumped to 2 by a password change.
	db.EXPECT().GetUserByUsername(gomock.Any(), "jim").
		Return(&models.User{Username: "jim", Role: pkg.UserRoleUser, TokenGeneration: 2}, nil)

	r, handled := revocationRouter(t, db, key)
	w := requestWithToken(r, token)

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.False(t, *handled, "the handler must not run — this is the stolen session")
	require.NotContains(t, w.Body.String(), "revoke",
		"the message stays generic: telling the holder of a stolen token that the owner noticed is a courtesy to the thief")
}

func TestRequireAuth_AcceptsATokenAtTheCurrentGeneration(t *testing.T) {
	const key = "test-signing-key-that-is-long-enough"

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	db := mock_database.NewMockDatabaseRepository(ctrl)

	token, err := auth.JwtGenerateFastenTokenFromUser(
		models.User{Username: "jim", Role: pkg.UserRoleUser, TokenGeneration: 3}, key)
	require.NoError(t, err)

	db.EXPECT().GetUserByUsername(gomock.Any(), "jim").
		Return(&models.User{Username: "jim", Role: pkg.UserRoleUser, TokenGeneration: 3}, nil)

	r, handled := revocationRouter(t, db, key)
	w := requestWithToken(r, token)

	require.Equal(t, http.StatusOK, w.Code)
	require.True(t, *handled)
}

// THE upgrade test. A token minted before this release carries no token_generation claim, so it
// decodes as 0 and matches a user whose column defaults to 0. If this ever fails, deploying the
// release signs out every logged-in user on every instance.
func TestRequireAuth_TokensWithoutTheClaimStillWork(t *testing.T) {
	const key = "test-signing-key-that-is-long-enough"

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	db := mock_database.NewMockDatabaseRepository(ctrl)

	// A user built without the field at all — exactly what an old token encodes.
	token, err := auth.JwtGenerateFastenTokenFromUser(
		models.User{Username: "jim", Role: pkg.UserRoleUser}, key)
	require.NoError(t, err)
	require.NotContains(t, token, "token_generation",
		"omitempty must keep the claim off a generation-0 token, which is what makes old tokens indistinguishable")

	db.EXPECT().GetUserByUsername(gomock.Any(), "jim").
		Return(&models.User{Username: "jim", Role: pkg.UserRoleUser}, nil)

	r, handled := revocationRouter(t, db, key)
	w := requestWithToken(r, token)

	require.Equal(t, http.StatusOK, w.Code, "deploying #508 must not sign anybody out")
	require.True(t, *handled)
}

// A session for an account that no longer exists is not a session. This is also the state a demo
// reset (#518) leaves old tokens in, since the restored database has different user IDs.
func TestRequireAuth_RejectsASessionForADeletedAccount(t *testing.T) {
	const key = "test-signing-key-that-is-long-enough"

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	db := mock_database.NewMockDatabaseRepository(ctrl)

	token, err := auth.JwtGenerateFastenTokenFromUser(models.User{Username: "gone", Role: pkg.UserRoleUser}, key)
	require.NoError(t, err)

	db.EXPECT().GetUserByUsername(gomock.Any(), "gone").Return(nil, gorm.ErrRecordNotFound)

	r, handled := revocationRouter(t, db, key)
	w := requestWithToken(r, token)

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.False(t, *handled)
}
