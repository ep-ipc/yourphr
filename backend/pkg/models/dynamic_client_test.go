package models_test

import (
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// Pins the INTENT, not the current implementation.
//
// Dynamic client registration is unavailable in YourPHR because provider definitions are a
// commercial dependency (fastenhealth/fasten-onprem#629), and YourPHR is bring-your-own client_id
// instead. That is a deliberate product position, and until yourphr#476 it was enforced by nothing
// more than a stub happening to return an error, which IsDynamicClient silently swallowed.
//
// This test exists so folding the module into the main one (yourphr#288) cannot quietly flip the
// answer. If dynamic registration ever becomes supported, this test should fail and be rewritten —
// that is the point.
func TestIsDynamicClient_IsAlwaysFalse(t *testing.T) {
	cases := []struct {
		name string
		cred models.SourceCredential
	}{
		{"zero value", models.SourceCredential{}},
		{"with an endpoint id", models.SourceCredential{EndpointID: uuid.New()}},
		{"with credentials populated", models.SourceCredential{
			EndpointID:   uuid.New(),
			ClientId:     "some-client-id",
			AccessToken:  "some-access-token",
			RefreshToken: "some-refresh-token",
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.False(t, tc.cred.IsDynamicClient(),
				"dynamic client registration is unsupported in YourPHR; see yourphr#476")
		})
	}
}

// RegisterDynamicClient is kept as working code behind that constant-false guard, so it must still
// refuse rather than half-run: it would otherwise generate a keypair and mutate the credential
// before discovering it has nowhere to send the registration.
func TestRegisterDynamicClient_RefusesWithoutMutatingTheCredential(t *testing.T) {
	cred := models.SourceCredential{EndpointID: uuid.New(), ClientId: "some-client-id"}

	err := cred.RegisterDynamicClient()

	require.Error(t, err, "there are no provider definitions to register against")
	require.Empty(t, cred.DynamicClientJWKS,
		"must fail before generating a keypair, or a failed call leaves half-written state")
	require.Empty(t, cred.DynamicClientId)
}
