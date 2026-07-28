package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// A YOURPHR_* env var overrides config (prefix + '.'/'-' -> '_' key mapping).
func TestEnvPrefix_Yourphr(t *testing.T) {
	t.Setenv("YOURPHR_LOG_LEVEL", "DEBUG")

	cfg := configuration{}
	require.NoError(t, cfg.Init())
	require.Equal(t, "DEBUG", cfg.GetString("log.level"))
}

// The relay keys must map to the env var names operators already use (#399). relay.public_url is
// two words, so this also pins the multi-word '.'->'_' mapping (NOT YOURPHR_RELAY_PUBLICURL).
func TestEnvPrefix_Relay(t *testing.T) {
	t.Setenv("YOURPHR_RELAY_URL", "http://yourphr-relay.yourphr.svc.cluster.local:8080")
	t.Setenv("YOURPHR_RELAY_PUBLIC_URL", "https://relay.example.org")
	t.Setenv("YOURPHR_RELAY_SECRET", "s3cret")

	cfg := configuration{}
	require.NoError(t, cfg.Init())
	require.Equal(t, "http://yourphr-relay.yourphr.svc.cluster.local:8080", cfg.GetString("relay.url"))
	require.Equal(t, "https://relay.example.org", cfg.GetString("relay.public_url"))
	require.Equal(t, "s3cret", cfg.GetString("relay.secret"))
}
