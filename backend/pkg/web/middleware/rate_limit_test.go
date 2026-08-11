package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func Test_RateLimitMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RateLimitMiddleware(2, time.Minute))
	r.GET("/", func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	do := func(ip string) (int, string) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = ip + ":1111"
		r.ServeHTTP(w, req)
		return w.Code, w.Header().Get("Retry-After")
	}

	// first two requests from an IP are allowed, the third is throttled
	code, _ := do("203.0.113.5")
	require.Equal(t, http.StatusOK, code)
	code, _ = do("203.0.113.5")
	require.Equal(t, http.StatusOK, code)
	code, retryAfter := do("203.0.113.5")
	require.Equal(t, http.StatusTooManyRequests, code)
	require.NotEmpty(t, retryAfter, "429 should advertise Retry-After")

	// a different IP has its own independent bucket
	code, _ = do("198.51.100.9")
	require.Equal(t, http.StatusOK, code)
}

// The auth limiter counts every request through the group it guards, including ones that carry no
// credential. That is what made the E2E suite intermittently "fail" login (#481): ~16 auth calls
// from one IP against a cap of 10, and the sign-in page renders any error as "username or password
// is incorrect", so a throttle read as a login regression.
//
// This pins the arithmetic that surprised us: SIGNUP SHARES THE BUCKET, so a suite that creates an
// account then signs in N times gets throttled on its (cap - 1)th sign-in, not its cap-th.
func Test_RateLimitMiddleware_SignupSharesTheBucketWithSignin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	group := r.Group("/auth")
	group.Use(RateLimitMiddleware(10, time.Minute))
	group.POST("/signup", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	group.POST("/signin", func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	post := func(path string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.RemoteAddr = "203.0.113.7:2222"
		r.ServeHTTP(w, req)
		return w.Code
	}

	require.Equal(t, http.StatusOK, post("/auth/signup"), "the account creation itself counts")
	for i := 1; i <= 9; i++ {
		require.Equalf(t, http.StatusOK, post("/auth/signin"), "sign-in %d should be within the cap", i)
	}
	require.Equal(t, http.StatusTooManyRequests, post("/auth/signin"),
		"the 10th request from this IP is throttled — with correct credentials, which is why it "+
			"presented as an authentication failure rather than a throttle")
}
