// Stub for github.com/fastenhealth/fasten-onprem/backend/pkg/sources/definitions
package definitions

import "fmt"

type GetSourceConfigOptions struct {
	EndpointId string
	BrandId    string
	PortalId   string
}

// LighthouseSourceDefinition mirrors the fields accessed by fasten-onprem.
type LighthouseSourceDefinition struct {
	Id                                string
	Name                              string
	TokenEndpoint                     string
	TokenEndpointAuthMethodsSupported []string
	DynamicClientRegistrationEndpoint string
	DynamicClientRegistrationMode     string
	RegistrationEndpoint              string
	Issuer                            string
	CORSRelayRequired                 bool
}

// GetSourceDefinition always returns an error. PERMANENTLY, on every build — this is not a TODO.
//
// Provider definitions live in the upstream fasten-sources module, which was made private when EHR
// integrations moved to Fasten Connect (fastenhealth/fasten-onprem#629). YourPHR has no access to
// them and does not plan to: it is bring-your-own client_id, where the operator registers with the
// vendor and enters the credentials themselves.
//
// Callers must therefore treat this as "unsupported", not "failed". Anything that reports the
// error to a user should say the feature is unavailable rather than implying a bad request — a 400
// or a 404 blames the caller for something that could never have succeeded. See yourphr#476 for
// the call sites and what each one does about it.
func GetSourceDefinition(opts GetSourceConfigOptions) (*LighthouseSourceDefinition, error) {
	return nil, fmt.Errorf("provider source definitions not available: fasten-sources is a commercial dependency (see fastenhealth/fasten-onprem#629)")
}
