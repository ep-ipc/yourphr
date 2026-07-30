package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type fakeConfig map[string]interface{}

func (f fakeConfig) GetString(key string) string {
	if v, ok := f[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func (f fakeConfig) GetInt(key string) int {
	if v, ok := f[key]; ok {
		switch n := v.(type) {
		case int:
			return n
		case int64:
			return int(n)
		}
	}
	return 0
}

func TestRelayPollSecondsDefaultsAndClamps(t *testing.T) {
	require.Equal(t, 55, relayPollSeconds(fakeConfig{}))
	require.Equal(t, 55, relayPollSeconds(fakeConfig{"web.smart_connect.relay_poll_seconds": 0}))
	require.Equal(t, 40, relayPollSeconds(fakeConfig{"web.smart_connect.relay_poll_seconds": 40}))
	require.Equal(t, 60, relayPollSeconds(fakeConfig{"web.smart_connect.relay_poll_seconds": 120}))
	require.Equal(t, 55*time.Second, relayPollTimeout(fakeConfig{}))
}

func TestRespondRelayCodeErrorClassifies(t *testing.T) {
	gin.SetMode(gin.TestMode)

	cases := []struct {
		name string
		err  error
		code string
		sub  string
	}{
		{"timeout", errors.New("relay: timed out waiting for authorization code: context deadline exceeded"), ErrorCodeRelayPollTimeout, "finish sign-in"},
		{"unauthorized", errors.New("relay: unauthorized — the shared secret does not match the relay's"), ErrorCodeRelayUnauthorized, "shared secret"},
		{"other", errors.New("relay: unexpected status 500"), ErrorCodeRelayPollFailed, "could not retrieve"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			respondRelayCodeError(c, tc.err)
			require.Equal(t, http.StatusBadGateway, w.Code)
			var body map[string]interface{}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
			require.Equal(t, tc.code, body["error_code"])
			require.Contains(t, body["error"], tc.sub)
		})
	}
}

func TestRespondRelayNotConfigured(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	respondRelayNotConfigured(c, errors.New("relay: YOURPHR_RELAY_SECRET (relay.secret) is not set"))
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	var body map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, ErrorCodeRelayNotConfigured, body["error_code"])
	require.Contains(t, body["error"], "YOURPHR_RELAY_SECRET")
}
