package models

import "strings"

// Modular per-provider connection policy for patient catalog connects.
// Defaults apply to all medical-record providers; rare opt-outs use catalog fields.
//
// ConsentPolicy values:
//   - "" / "required" — PP/ToS active opt-in required before connect (product default)
//   - "skip" — no product consent gate (escape hatch when a provider truly cannot fit)
//
// PreConnectProfile values:
//   - "" / "auto" — pick medicare vs generic from provider signals
//   - "generic" — standard medical-records pre-connect copy
//   - "medicare" — CMS/Medicare claims-oriented copy + attribution
//   - "none" — skip pre-connect modal (escape hatch)

const (
	ConsentPolicyRequired = "required"
	ConsentPolicySkip     = "skip"

	PreConnectAuto     = "auto"
	PreConnectGeneric  = "generic"
	PreConnectMedicare = "medicare"
	PreConnectNone     = "none"
)

// ConnectionPolicy is the resolved patient-connect behavior for one catalog entry.
type ConnectionPolicy struct {
	// RequiresUserConsent — Account Profile PP/ToS must be granted before connect.
	RequiresUserConsent bool `json:"requires_user_consent"`
	// PreConnectProfile — "none" | "generic" | "medicare" (never "auto" after resolve).
	PreConnectProfile string `json:"pre_connect_profile"`
	// MedicareClass — CMS Blue Button-class (label "Medicare", CMS attribution contexts).
	MedicareClass bool `json:"medicare_class"`
}

// IsMedicareClassProvider is the detector for CMS Blue Button / Medicare claims sources.
func IsMedicareClassProvider(display, apiEndpointBaseURL, platformType string) bool {
	return ProviderRequiresLegalConsent(display, apiEndpointBaseURL, platformType)
}

// ResolveConnectionPolicy merges catalog overrides with defaults and auto-detection.
func ResolveConnectionPolicy(entry *ProviderCatalogEntry) ConnectionPolicy {
	if entry == nil {
		return ConnectionPolicy{
			RequiresUserConsent: true,
			PreConnectProfile:   PreConnectGeneric,
		}
	}
	medicare := IsMedicareClassProvider(entry.Display, entry.ApiEndpointBaseUrl, string(entry.PlatformType))

	consent := strings.ToLower(strings.TrimSpace(entry.ConsentPolicy))
	if consent == "" {
		consent = ConsentPolicyRequired
	}
	requiresConsent := consent != ConsentPolicySkip

	pre := strings.ToLower(strings.TrimSpace(entry.PreConnectProfile))
	if pre == "" || pre == PreConnectAuto {
		if medicare {
			pre = PreConnectMedicare
		} else {
			pre = PreConnectGeneric
		}
	}
	switch pre {
	case PreConnectNone, PreConnectGeneric, PreConnectMedicare:
		// ok
	default:
		if medicare {
			pre = PreConnectMedicare
		} else {
			pre = PreConnectGeneric
		}
	}

	return ConnectionPolicy{
		RequiresUserConsent: requiresConsent,
		PreConnectProfile:   pre,
		MedicareClass:       medicare,
	}
}
