package handler

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBuildPatientVitalObservation_Weight(t *testing.T) {
	v := 72.5
	obs, title, err := buildPatientVitalObservation(PatientEntryRequest{
		Kind:  "vital",
		Vital: "body_weight",
		Value: &v,
	})
	require.NoError(t, err)
	require.Contains(t, title, "Body weight")
	require.Equal(t, "Observation", obs["resourceType"])
	require.Equal(t, "final", obs["status"])
	meta := obs["meta"].(map[string]interface{})
	require.Equal(t, patientEntryMetaSource, meta["source"])
	vq := obs["valueQuantity"].(map[string]interface{})
	require.Equal(t, 72.5, vq["value"])
}

func TestBuildPatientVitalObservation_BloodPressure(t *testing.T) {
	sys, dia := 120.0, 80.0
	obs, title, err := buildPatientVitalObservation(PatientEntryRequest{
		Vital:     "blood_pressure",
		Systolic:  &sys,
		Diastolic: &dia,
	})
	require.NoError(t, err)
	require.Contains(t, title, "120")
	require.Contains(t, title, "80")
	comps := obs["component"].([]map[string]interface{})
	require.Len(t, comps, 2)
}

func TestBuildPatientVitalObservation_MissingValue(t *testing.T) {
	_, _, err := buildPatientVitalObservation(PatientEntryRequest{Vital: "heart_rate"})
	require.Error(t, err)
}

func TestBuildPatientVitalObservation_UnknownVital(t *testing.T) {
	v := 1.0
	_, _, err := buildPatientVitalObservation(PatientEntryRequest{Vital: "steps", Value: &v})
	require.Error(t, err)
}
