package models

import "strings"

// Legal consent for Privacy Policy + Terms of Service (#427).
// Stored per user as user_settings key LegalConsentSettingKey (RFC3339 timestamp when accepted; empty = not accepted).

const (
	LegalConsentSettingKey         = "tos_privacy_accepted_at"
	LegalConsentSettingDescription = "When the user actively accepted the Privacy Policy and Terms of Service (RFC3339 UTC); empty if revoked or never accepted"
	// Instance-relative (#463). The documents are served by this instance — an offline
	// deployment must still show its own policy, and the operator (who is the data controller)
	// may have published their own text. An absolute yourphr.org URL would point a user at a
	// document the party holding their records did not write.
	LegalPrivacyPolicyURL  = "/privacy"
	LegalTermsOfServiceURL = "/terms"
)

// LegalConsentStatus is the API payload for GET /account/legal-consent.
type LegalConsentStatus struct {
	Accepted          bool   `json:"accepted"`
	AcceptedAt        string `json:"accepted_at,omitempty"` // RFC3339 UTC when accepted
	PrivacyPolicyURL  string `json:"privacy_policy_url"`
	TermsOfServiceURL string `json:"terms_of_service_url"`
}

// PatientFacingMedicareLabel is the CMS-required name for Blue Button-class sources on patient
// multi-source pickers (#429). Architecture is still Blue Button / CARIN / FHIR; enrollee list says Medicare.
const PatientFacingMedicareLabel = "Medicare"

// ProviderRequiresLegalConsent reports whether connecting this catalog/source needs active PP/ToS opt-in
// (Medicare / CMS Blue Button and similar). Case-insensitive match on display, FHIR base URL, platform.
func ProviderRequiresLegalConsent(display, apiEndpointBaseURL, platformType string) bool {
	blob := strings.ToLower(display + "\n" + apiEndpointBaseURL + "\n" + platformType)
	markers := []string{
		"medicare",
		"blue button",
		"bluebutton",
		"blue-button",
		"cms.gov",
		"cms.hhs.gov",
	}
	for _, m := range markers {
		if strings.Contains(blob, m) {
			return true
		}
	}
	return false
}

// PatientFacingSourceDisplay returns the label enrollees see for a catalog entry.
// Production Blue Button-class sources are forced to "Medicare" (CMS production-access rule).
// Sandbox / admin paths keep the operator-configured display (e.g. "Medicare — Blue Button 2.0 (Sandbox)").
func PatientFacingSourceDisplay(environment, display, apiEndpointBaseURL, platformType string) string {
	if environment == ProviderEnvironmentSandbox {
		return display
	}
	// Empty environment = production (legacy rows).
	if ProviderRequiresLegalConsent(display, apiEndpointBaseURL, platformType) {
		return PatientFacingMedicareLabel
	}
	return display
}
