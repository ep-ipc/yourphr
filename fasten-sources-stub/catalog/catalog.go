// Stub for github.com/fastenhealth/fasten-sources/catalog
package catalog

import (
	"fmt"

	"github.com/fastenhealth/fasten-sources/pkg"
)

type Brand struct {
	Id   string
	Name string
}

type Portal struct {
	Id   string
	Name string
}

type Endpoint struct {
	Id           string
	Name         string
	PlatformType pkg.PlatformType
}

func (e Endpoint) GetPlatformType() pkg.PlatformType {
	return e.PlatformType
}

// GetPatientAccessInfoForLegacySourceType always returns an error. PERMANENTLY — see the note on
// definitions.GetSourceDefinition; the same commercial dependency (fastenhealth/fasten-onprem#629)
// applies. Its one caller is a legacy source-type migration, which treats the error as "this row
// has no catalog entry" and moves on. See yourphr#476.
func GetPatientAccessInfoForLegacySourceType(sourceType string, apiEndpointBaseUrl string) (Brand, Portal, Endpoint, pkg.FastenLighthouseEnvType, error) {
	return Brand{}, Portal{}, Endpoint{}, "", fmt.Errorf("source catalog not available: fasten-sources is a commercial dependency (see fastenhealth/fasten-onprem#629)")
}
