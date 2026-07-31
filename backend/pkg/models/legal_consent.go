package models

import "strings"

// Legal consent for Privacy Policy + Terms of Service (#427).
// Stored per user as user_settings key LegalConsentSettingKey (RFC3339 timestamp when accepted; empty = not accepted).

const (
	LegalConsentSettingKey         = "tos_privacy_accepted_at"
	LegalConsentSettingDescription = "When the user actively accepted the Privacy Policy and Terms of Service (RFC3339 UTC); empty if revoked or never accepted"
	LegalPrivacyPolicyURL          = "https://yourphr.org/privacy.html"
	LegalTermsOfServiceURL         = "https://yourphr.org/terms.html"
)

// LegalConsentStatus is the API payload for GET /account/legal-consent.
type LegalConsentStatus struct {
	Accepted          bool   `json:"accepted"`
	AcceptedAt        string `json:"accepted_at,omitempty"` // RFC3339 UTC when accepted
	PrivacyPolicyURL  string `json:"privacy_policy_url"`
	TermsOfServiceURL string `json:"terms_of_service_url"`
}

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
