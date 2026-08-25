// Package healthkit maps Apple HealthKit type identifiers onto the normalized metric names stored in
// health_samples, and validates the units and category values that accompany them.
//
// The mapping is intentionally additive: a type identifier missing from this table is still stored
// (with an empty metric_type), because a companion app that ships a new metric before the server
// knows about it should not lose the user's data. Only a type that IS known and arrives with a unit
// this table does not accept is rejected, since storing a heart rate whose unit might be beats per
// hour is worse than not storing it.
package healthkit

import "strings"

// Kind distinguishes HealthKit's two sample shapes.
type Kind string

const (
	// KindQuantity is an HKQuantitySample: a number plus a unit.
	KindQuantity Kind = "quantity"
	// KindCategory is an HKCategorySample: an enumerated value, such as a sleep stage.
	KindCategory Kind = "category"
)

// Metric describes one HealthKit type this server understands.
type Metric struct {
	// MetricType is the normalized name written to health_samples.metric_type.
	MetricType string
	Kind       Kind
	// CanonicalUnit is the unit values are stored in, and is empty for category metrics.
	CanonicalUnit string

	// acceptedUnits are the unit spellings accepted on input, all meaning CanonicalUnit. The first
	// entry is HealthKit's own HKUnit.unitString; the rest are spellings a client may reasonably send.
	acceptedUnits []string
	// allowedValues are the accepted category values, for KindCategory metrics only.
	allowedValues []categoryValue
}

// categoryValue is one enumerated category value plus the spellings accepted for it. Aliases include
// HealthKit's raw integer HKCategoryValue, because a client may forward the enum without naming it.
type categoryValue struct {
	canonical string
	aliases   []string
}

// metrics is keyed by the exact HealthKit type identifier.
var metrics = map[string]Metric{
	"HKQuantityTypeIdentifierHeartRate": {
		MetricType:    "heart_rate",
		Kind:          KindQuantity,
		CanonicalUnit: "count/min",
		acceptedUnits: []string{"count/min", "count/minute", "bpm"},
	},
	"HKQuantityTypeIdentifierRestingHeartRate": {
		MetricType:    "resting_heart_rate",
		Kind:          KindQuantity,
		CanonicalUnit: "count/min",
		acceptedUnits: []string{"count/min", "count/minute", "bpm"},
	},
	"HKQuantityTypeIdentifierHeartRateVariabilitySDNN": {
		MetricType:    "heart_rate_variability_sdnn",
		Kind:          KindQuantity,
		CanonicalUnit: "ms",
		acceptedUnits: []string{"ms", "msec", "millisecond", "milliseconds"},
	},
	"HKQuantityTypeIdentifierBloodPressureSystolic": {
		MetricType:    "blood_pressure_systolic",
		Kind:          KindQuantity,
		CanonicalUnit: "mmHg",
		acceptedUnits: []string{"mmHg", "mm[Hg]"},
	},
	"HKQuantityTypeIdentifierBloodPressureDiastolic": {
		MetricType:    "blood_pressure_diastolic",
		Kind:          KindQuantity,
		CanonicalUnit: "mmHg",
		acceptedUnits: []string{"mmHg", "mm[Hg]"},
	},
	"HKQuantityTypeIdentifierStepCount": {
		MetricType:    "step_count",
		Kind:          KindQuantity,
		CanonicalUnit: "count",
		acceptedUnits: []string{"count", "steps"},
	},
	"HKQuantityTypeIdentifierBodyMass": {
		MetricType:    "body_mass",
		Kind:          KindQuantity,
		CanonicalUnit: "kg",
		acceptedUnits: []string{"kg", "kilogram", "kilograms"},
	},
	"HKQuantityTypeIdentifierOxygenSaturation": {
		MetricType:    "oxygen_saturation",
		Kind:          KindQuantity,
		CanonicalUnit: "%",
		acceptedUnits: []string{"%", "percent"},
	},
	"HKQuantityTypeIdentifierBodyTemperature": {
		MetricType:    "body_temperature",
		Kind:          KindQuantity,
		CanonicalUnit: "degC",
		acceptedUnits: []string{"degC", "°C", "C", "celsius"},
	},
	"HKCategoryTypeIdentifierSleepAnalysis": {
		MetricType: "sleep_stage",
		Kind:       KindCategory,
		allowedValues: []categoryValue{
			{canonical: "inBed", aliases: []string{"0", "HKCategoryValueSleepAnalysisInBed"}},
			{canonical: "asleepUnspecified", aliases: []string{"1", "asleep", "HKCategoryValueSleepAnalysisAsleepUnspecified"}},
			{canonical: "awake", aliases: []string{"2", "HKCategoryValueSleepAnalysisAwake"}},
			{canonical: "asleepCore", aliases: []string{"3", "HKCategoryValueSleepAnalysisAsleepCore"}},
			{canonical: "asleepDeep", aliases: []string{"4", "HKCategoryValueSleepAnalysisAsleepDeep"}},
			{canonical: "asleepREM", aliases: []string{"5", "HKCategoryValueSleepAnalysisAsleepREM"}},
		},
	},
}

// Lookup returns the Metric for a HealthKit type identifier. The second return is false for
// identifiers this server does not recognize, which callers store verbatim rather than reject.
func Lookup(hkType string) (Metric, bool) {
	m, ok := metrics[strings.TrimSpace(hkType)]
	return m, ok
}

// LookupByMetricType returns the Metric for a normalized name such as "heart_rate". Used by the
// series endpoint, which is queried by metric_type rather than the raw HealthKit identifier.
func LookupByMetricType(metricType string) (Metric, bool) {
	metricType = strings.TrimSpace(metricType)
	if metricType == "" {
		return Metric{}, false
	}
	for _, m := range metrics {
		if m.MetricType == metricType {
			return m, true
		}
	}
	return Metric{}, false
}

// NormalizeUnit maps an incoming unit spelling to the metric's canonical unit. It reports false for
// units this metric does not accept, including the empty string: a quantity sample whose unit is
// unstated cannot be safely assumed.
func (m Metric) NormalizeUnit(unit string) (string, bool) {
	unit = strings.TrimSpace(unit)
	for _, accepted := range m.acceptedUnits {
		if strings.EqualFold(unit, accepted) {
			return m.CanonicalUnit, true
		}
	}
	return "", false
}

// NormalizeCategoryValue maps an incoming category value to its canonical spelling, accepting both
// the name and HealthKit's raw integer enum.
func (m Metric) NormalizeCategoryValue(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}
	for _, allowed := range m.allowedValues {
		if strings.EqualFold(value, allowed.canonical) {
			return allowed.canonical, true
		}
		for _, alias := range allowed.aliases {
			if strings.EqualFold(value, alias) {
				return allowed.canonical, true
			}
		}
	}
	return "", false
}
