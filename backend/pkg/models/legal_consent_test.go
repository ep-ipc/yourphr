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

func TestPatientFacingSourceDisplay_MedicareLabel(t *testing.T) {
	// Production (or empty env) Blue Button-class → always "Medicare" for enrollees (#429).
	if got := PatientFacingSourceDisplay("production", "CMS Blue Button 2.0", "https://api.bluebutton.cms.gov/v2/fhir", ""); got != PatientFacingMedicareLabel {
		t.Errorf("production BB = %q, want %q", got, PatientFacingMedicareLabel)
	}
	if got := PatientFacingSourceDisplay("", "Blue Button", "https://sandbox.bluebutton.cms.gov/v2/fhir", ""); got != PatientFacingMedicareLabel {
		t.Errorf("legacy env BB = %q, want %q", got, PatientFacingMedicareLabel)
	}
	// Sandbox keeps operator-explicit naming.
	sandbox := "Medicare — Blue Button 2.0 (Sandbox)"
	if got := PatientFacingSourceDisplay(ProviderEnvironmentSandbox, sandbox, "https://sandbox.bluebutton.cms.gov/v2/fhir", ""); got != sandbox {
		t.Errorf("sandbox = %q, want %q", got, sandbox)
	}
	// Unrelated production provider unchanged.
	if got := PatientFacingSourceDisplay("production", "Epic MyChart", "https://fhir.epic.com/x", "epic"); got != "Epic MyChart" {
		t.Errorf("epic = %q, want Epic MyChart", got)
	}
}
