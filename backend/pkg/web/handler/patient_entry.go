package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	sourceModels "github.com/fastenhealth/fasten-onprem/backend/pkg/sources/clients/models"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

// Patient-entry meta.source for direct UI PGHD (#313).
const patientEntryMetaSource = "yourphr://patient-ui"

// PatientEntryRequest is the body for POST /api/secure/resource/patient-entry.
// First slice: home vitals only (US Core Vital Signs LOINC codes).
type PatientEntryRequest struct {
	// Kind is currently only "vital" (future: allergy, condition, medication, note).
	Kind string `json:"kind"`
	// Vital: body_weight | heart_rate | body_temperature | oxygen_saturation | blood_pressure
	Vital string `json:"vital"`
	// Value is required for single-quantity vitals.
	Value *float64 `json:"value"`
	// Systolic / Diastolic for blood_pressure (mmHg).
	Systolic  *float64 `json:"systolic"`
	Diastolic *float64 `json:"diastolic"`
	// Unit optional override (defaults from vital type).
	Unit string `json:"unit"`
	// EffectiveDateTime optional RFC3339; default now UTC.
	EffectiveDateTime string `json:"effective_date_time"`
}

// CreatePatientEntry stores a patient-authored FHIR resource on the user's YourPHR (fasten) source.
// Vitals appear in Explore / Labs / GetVitalsRecognized alongside imported data (#313).
func CreatePatientEntry(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	var req PatientEntryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "invalid request: " + err.Error()})
		return
	}
	kind := strings.ToLower(strings.TrimSpace(req.Kind))
	if kind == "" {
		kind = "vital"
	}
	if kind != "vital" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "unsupported kind; this release supports kind=vital only"})
		return
	}

	obs, sortTitle, err := buildPatientVitalObservation(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	fastenSource, err := ensureFastenSource(c, databaseRepo)
	if err != nil {
		logger.Errorln("patient entry: ensure Fasten source:", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not prepare manual-entry source"})
		return
	}

	resourceRaw, err := json.Marshal(obs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to serialize observation"})
		return
	}

	id, _ := obs["id"].(string)
	resourceToUpsert := sourceModels.RawResourceFhir{
		SourceResourceType: "Observation",
		SourceResourceID:   id,
		ResourceRaw:        resourceRaw,
		SortTitle:          &sortTitle,
	}

	created, err := databaseRepo.UpsertRawResource(c, fastenSource, resourceToUpsert)
	if err != nil {
		logger.Errorln("patient entry: upsert Observation:", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to store observation"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"resource_type":      "Observation",
			"source_resource_id": id,
			"source_id":          fastenSource.ID.String(),
			"sort_title":         sortTitle,
			"resource":           created,
		},
	})
}

func buildPatientVitalObservation(req PatientEntryRequest) (map[string]interface{}, string, error) {
	vital := strings.ToLower(strings.TrimSpace(req.Vital))
	if vital == "" {
		return nil, "", fmt.Errorf("vital is required (body_weight, heart_rate, body_temperature, oxygen_saturation, blood_pressure)")
	}

	effective := strings.TrimSpace(req.EffectiveDateTime)
	if effective == "" {
		effective = time.Now().UTC().Format(time.RFC3339)
	} else if _, err := time.Parse(time.RFC3339, effective); err != nil {
		// allow date-only
		if _, err2 := time.Parse("2006-01-02", effective); err2 != nil {
			return nil, "", fmt.Errorf("effective_date_time must be RFC3339 or YYYY-MM-DD")
		}
	}

	id := uuid.New().String()
	base := map[string]interface{}{
		"resourceType": "Observation",
		"id":           id,
		"status":       "final",
		"category": []map[string]interface{}{
			{
				"coding": []map[string]interface{}{
					{
						"system":  "http://terminology.hl7.org/CodeSystem/observation-category",
						"code":    "vital-signs",
						"display": "Vital Signs",
					},
				},
			},
		},
		"effectiveDateTime": effective,
		"meta": map[string]interface{}{
			"source": patientEntryMetaSource,
			"tag": []map[string]interface{}{
				{
					"system":  "https://yourphr.org/fhir/CodeSystem/record-origin",
					"code":    "patient-reported",
					"display": "Patient-reported (YourPHR)",
				},
			},
		},
	}

	var sortTitle string
	switch vital {
	case "body_weight", "weight":
		if req.Value == nil {
			return nil, "", fmt.Errorf("value is required for body_weight")
		}
		unit := firstNonEmpty(req.Unit, "kg")
		base["code"] = coding("http://loinc.org", "29463-7", "Body weight")
		base["valueQuantity"] = quantity(*req.Value, unit, "http://unitsofmeasure.org", unit)
		sortTitle = fmt.Sprintf("Body weight %g %s", *req.Value, unit)

	case "heart_rate", "pulse":
		if req.Value == nil {
			return nil, "", fmt.Errorf("value is required for heart_rate")
		}
		unit := firstNonEmpty(req.Unit, "/min")
		base["code"] = coding("http://loinc.org", "8867-4", "Heart rate")
		base["valueQuantity"] = quantity(*req.Value, unit, "http://unitsofmeasure.org", "/min")
		sortTitle = fmt.Sprintf("Heart rate %g %s", *req.Value, unit)

	case "body_temperature", "temperature":
		if req.Value == nil {
			return nil, "", fmt.Errorf("value is required for body_temperature")
		}
		unit := firstNonEmpty(req.Unit, "Cel")
		base["code"] = coding("http://loinc.org", "8310-5", "Body temperature")
		base["valueQuantity"] = quantity(*req.Value, unit, "http://unitsofmeasure.org", unit)
		sortTitle = fmt.Sprintf("Body temperature %g %s", *req.Value, unit)

	case "oxygen_saturation", "spo2":
		if req.Value == nil {
			return nil, "", fmt.Errorf("value is required for oxygen_saturation")
		}
		unit := firstNonEmpty(req.Unit, "%")
		base["code"] = coding("http://loinc.org", "2708-6", "Oxygen saturation in Arterial blood")
		base["valueQuantity"] = quantity(*req.Value, unit, "http://unitsofmeasure.org", "%")
		sortTitle = fmt.Sprintf("Oxygen saturation %g%s", *req.Value, unit)

	case "blood_pressure", "bp":
		if req.Systolic == nil || req.Diastolic == nil {
			return nil, "", fmt.Errorf("systolic and diastolic are required for blood_pressure")
		}
		base["code"] = coding("http://loinc.org", "85354-9", "Blood pressure panel with all children optional")
		base["component"] = []map[string]interface{}{
			{
				"code":          coding("http://loinc.org", "8480-6", "Systolic blood pressure"),
				"valueQuantity": quantity(*req.Systolic, "mm[Hg]", "http://unitsofmeasure.org", "mm[Hg]"),
			},
			{
				"code":          coding("http://loinc.org", "8462-4", "Diastolic blood pressure"),
				"valueQuantity": quantity(*req.Diastolic, "mm[Hg]", "http://unitsofmeasure.org", "mm[Hg]"),
			},
		}
		sortTitle = fmt.Sprintf("Blood pressure %g/%g mmHg", *req.Systolic, *req.Diastolic)

	default:
		return nil, "", fmt.Errorf("unknown vital %q", vital)
	}

	return base, sortTitle, nil
}

func coding(system, code, display string) map[string]interface{} {
	return map[string]interface{}{
		"coding": []map[string]interface{}{
			{"system": system, "code": code, "display": display},
		},
		"text": display,
	}
}

func quantity(value float64, unit, system, code string) map[string]interface{} {
	return map[string]interface{}{
		"value":  value,
		"unit":   unit,
		"system": system,
		"code":   code,
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
