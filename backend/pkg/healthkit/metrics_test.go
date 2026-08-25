package healthkit

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLookup_KnownQuantityType(t *testing.T) {
	t.Parallel()

	metric, ok := Lookup("HKQuantityTypeIdentifierHeartRate")
	require.True(t, ok)
	require.Equal(t, "heart_rate", metric.MetricType)
	require.Equal(t, KindQuantity, metric.Kind)
	require.Equal(t, "count/min", metric.CanonicalUnit)
}

func TestLookup_KnownCategoryType(t *testing.T) {
	t.Parallel()

	metric, ok := Lookup("HKCategoryTypeIdentifierSleepAnalysis")
	require.True(t, ok)
	require.Equal(t, "sleep_stage", metric.MetricType)
	require.Equal(t, KindCategory, metric.Kind)
	require.Empty(t, metric.CanonicalUnit)
}

// An identifier the server does not know must report false rather than error, so the caller can store
// the sample verbatim instead of discarding the user's data.
func TestLookup_UnknownTypeIsNotAnError(t *testing.T) {
	t.Parallel()

	metric, ok := Lookup("HKQuantityTypeIdentifierSomethingAppleShippedLastTuesday")
	require.False(t, ok)
	require.Empty(t, metric.MetricType)
}

func TestLookupByMetricType(t *testing.T) {
	t.Parallel()

	metric, ok := LookupByMetricType("heart_rate")
	require.True(t, ok)
	require.Equal(t, KindQuantity, metric.Kind)

	_, ok = LookupByMetricType("not_a_metric")
	require.False(t, ok)

	_, ok = LookupByMetricType("  ")
	require.False(t, ok)
}

func TestLookup_TrimsWhitespace(t *testing.T) {
	t.Parallel()

	metric, ok := Lookup("  HKQuantityTypeIdentifierStepCount\n")
	require.True(t, ok)
	require.Equal(t, "step_count", metric.MetricType)
}

func TestNormalizeUnit(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		hkType   string
		unit     string
		expected string
		ok       bool
	}{
		{name: "healthkit spelling", hkType: "HKQuantityTypeIdentifierHeartRate", unit: "count/min", expected: "count/min", ok: true},
		{name: "alias collapses to canonical", hkType: "HKQuantityTypeIdentifierHeartRate", unit: "bpm", expected: "count/min", ok: true},
		{name: "case insensitive", hkType: "HKQuantityTypeIdentifierBloodPressureSystolic", unit: "MMHG", expected: "mmHg", ok: true},
		{name: "surrounding whitespace", hkType: "HKQuantityTypeIdentifierBodyMass", unit: " kg ", expected: "kg", ok: true},
		{name: "wrong unit rejected", hkType: "HKQuantityTypeIdentifierBodyMass", unit: "lb", ok: false},
		{name: "unit of another metric rejected", hkType: "HKQuantityTypeIdentifierHeartRate", unit: "mmHg", ok: false},
		{name: "empty unit rejected", hkType: "HKQuantityTypeIdentifierHeartRate", unit: "", ok: false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			metric, found := Lookup(tt.hkType)
			require.True(t, found)

			normalized, ok := metric.NormalizeUnit(tt.unit)
			require.Equal(t, tt.ok, ok)
			require.Equal(t, tt.expected, normalized)
		})
	}
}

func TestNormalizeCategoryValue(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		value    string
		expected string
		ok       bool
	}{
		{name: "canonical name", value: "asleepCore", expected: "asleepCore", ok: true},
		{name: "case insensitive", value: "ASLEEPREM", expected: "asleepREM", ok: true},
		{name: "raw healthkit enum", value: "4", expected: "asleepDeep", ok: true},
		{name: "in bed enum zero", value: "0", expected: "inBed", ok: true},
		{name: "legacy asleep alias", value: "asleep", expected: "asleepUnspecified", ok: true},
		{name: "full enum constant", value: "HKCategoryValueSleepAnalysisAwake", expected: "awake", ok: true},
		{name: "unknown stage rejected", value: "dreaming", ok: false},
		{name: "out of range enum rejected", value: "99", ok: false},
		{name: "empty rejected", value: "", ok: false},
	}

	metric, found := Lookup("HKCategoryTypeIdentifierSleepAnalysis")
	require.True(t, found)

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			normalized, ok := metric.NormalizeCategoryValue(tt.value)
			require.Equal(t, tt.ok, ok)
			require.Equal(t, tt.expected, normalized)
		})
	}
}

// Every quantity metric must accept its own canonical unit, and every category metric must accept its
// own canonical values. A typo in the table above would otherwise reject valid samples at runtime.
func TestMetricTable_IsSelfConsistent(t *testing.T) {
	t.Parallel()

	for hkType, metric := range metrics {
		require.NotEmpty(t, metric.MetricType, "%s has no metric type", hkType)

		switch metric.Kind {
		case KindQuantity:
			require.NotEmpty(t, metric.CanonicalUnit, "%s has no canonical unit", hkType)
			require.Empty(t, metric.allowedValues, "%s is a quantity metric but lists category values", hkType)

			normalized, ok := metric.NormalizeUnit(metric.CanonicalUnit)
			require.True(t, ok, "%s rejects its own canonical unit", hkType)
			require.Equal(t, metric.CanonicalUnit, normalized)
		case KindCategory:
			require.Empty(t, metric.CanonicalUnit, "%s is a category metric but declares a unit", hkType)
			require.NotEmpty(t, metric.allowedValues, "%s has no category values", hkType)
			require.Empty(t, metric.acceptedUnits, "%s is a category metric but accepts units", hkType)

			for _, allowed := range metric.allowedValues {
				normalized, ok := metric.NormalizeCategoryValue(allowed.canonical)
				require.True(t, ok, "%s rejects its own value %s", hkType, allowed.canonical)
				require.Equal(t, allowed.canonical, normalized)
			}
		default:
			t.Fatalf("%s has unknown kind %q", hkType, metric.Kind)
		}
	}
}
