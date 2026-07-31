package models

import "testing"

func TestResolveConnectionPolicy_Defaults(t *testing.T) {
	epic := &ProviderCatalogEntry{
		Display:            "Epic MyChart",
		ApiEndpointBaseUrl: "https://fhir.epic.com/x",
		Environment:        ProviderEnvironmentProduction,
	}
	p := ResolveConnectionPolicy(epic)
	if !p.RequiresUserConsent {
		t.Error("epic should require consent by default")
	}
	if p.PreConnectProfile != PreConnectGeneric {
		t.Errorf("epic pre-connect = %q, want generic", p.PreConnectProfile)
	}
	if p.MedicareClass {
		t.Error("epic should not be medicare class")
	}
}

func TestResolveConnectionPolicy_MedicareAuto(t *testing.T) {
	bb := &ProviderCatalogEntry{
		Display:            "CMS Blue Button",
		ApiEndpointBaseUrl: "https://api.bluebutton.cms.gov/v2/fhir",
		Environment:        ProviderEnvironmentProduction,
	}
	p := ResolveConnectionPolicy(bb)
	if !p.RequiresUserConsent || !p.MedicareClass {
		t.Fatalf("medicare flags: consent=%v class=%v", p.RequiresUserConsent, p.MedicareClass)
	}
	if p.PreConnectProfile != PreConnectMedicare {
		t.Errorf("pre-connect = %q, want medicare", p.PreConnectProfile)
	}
}

func TestResolveConnectionPolicy_SkipConsent(t *testing.T) {
	e := &ProviderCatalogEntry{
		Display:            "Special",
		ApiEndpointBaseUrl: "https://example.com/fhir",
		ConsentPolicy:      ConsentPolicySkip,
		PreConnectProfile:  PreConnectNone,
	}
	p := ResolveConnectionPolicy(e)
	if p.RequiresUserConsent {
		t.Error("skip should not require consent")
	}
	if p.PreConnectProfile != PreConnectNone {
		t.Errorf("pre-connect = %q, want none", p.PreConnectProfile)
	}
}

func TestResolveConnectionPolicy_ForceGenericOnMedicareURL(t *testing.T) {
	// Operator override: still Medicare-class for label/attribution detect, but generic modal if forced…
	// Actually medicare class is from URL; pre-connect can be forced generic.
	e := &ProviderCatalogEntry{
		Display:            "Claims API",
		ApiEndpointBaseUrl: "https://sandbox.bluebutton.cms.gov/v2/fhir",
		PreConnectProfile:  PreConnectGeneric,
	}
	p := ResolveConnectionPolicy(e)
	if p.PreConnectProfile != PreConnectGeneric {
		t.Errorf("forced generic = %q", p.PreConnectProfile)
	}
	if !p.MedicareClass {
		t.Error("URL should still mark medicare class")
	}
}
