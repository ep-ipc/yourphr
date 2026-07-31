package models

import "testing"

func TestProviderRequiresLegalConsent(t *testing.T) {
	cases := []struct {
		display, url, platform string
		want                   bool
	}{
		{"Medicare", "", "", true},
		{"Connect to Blue Button", "", "", true},
		{"CMS Blue Button 2.0", "https://sandbox.bluebutton.cms.gov/v2/fhir", "", true},
		{"Epic MyChart", "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4", "epic", false},
		{"", "https://api.bluebutton.cms.gov/v2/fhir", "", true},
	}
	for _, tc := range cases {
		got := ProviderRequiresLegalConsent(tc.display, tc.url, tc.platform)
		if got != tc.want {
			t.Errorf("ProviderRequiresLegalConsent(%q,%q,%q)=%v want %v", tc.display, tc.url, tc.platform, got, tc.want)
		}
	}
}
