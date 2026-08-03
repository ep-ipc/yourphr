package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// defaultConfigJSON is the shipped configuration catalogue: every key an instance can set,
// with its default value. See app-default-config.json.
//
// EMBEDDED rather than read from disk, for two reasons. It can never be missing at runtime —
// no mount to forget, no COPY to get wrong. And /opt/fasten/config, the obvious place to ship
// it, is covered by a ConfigMap mount on both prod and demo, so a file placed there is
// invisible to the process (the Dockerfile's existing COPY of config.yaml is already shadowed
// that way). Same approach as backend/resources/related_versions.go.
//
//go:embed app-default-config.json
var defaultConfigJSON []byte

// DefaultConfigValues parses the shipped defaults into dotted key -> value.
//
// Keys are flat and dotted ("operator.contact_email"), never nested. That is the decision the
// rest of the design rests on: with nesting, every object forces a judgment about whether it is
// a namespace to descend into or a value the operator sets whole, and the JSON shape cannot
// tell you which. Putting the whole path in the key removes the question, so a value is free to
// be a scalar, an array, or an object.
//
// Keys beginning with "_" are comments and are dropped.
func DefaultConfigValues() (map[string]interface{}, error) {
	var raw map[string]interface{}
	if err := json.Unmarshal(defaultConfigJSON, &raw); err != nil {
		return nil, fmt.Errorf("parsing app-default-config.json: %w", err)
	}

	values := make(map[string]interface{}, len(raw))
	for key, value := range raw {
		if strings.HasPrefix(key, "_") {
			continue
		}
		values[key] = normalizeJSONNumber(value)
	}

	// A shipped default may reference an environment variable instead of carrying a value
	// (#460), so the file can name where a secret comes from without holding one.
	return ResolveEnvRefs(values)
}

// normalizeJSONNumber turns whole float64s back into ints.
//
// encoding/json decodes every number as float64, so 9091 arrives as 9091.0. Viper's casting
// copes, but the value then surfaces as "9091" or "9.091e+03" depending on the reader, and an
// operator comparing the Admin screen against this file should see the number they wrote.
func normalizeJSONNumber(value interface{}) interface{} {
	number, ok := value.(float64)
	if !ok {
		return value
	}
	if number == math.Trunc(number) && math.Abs(number) < math.MaxInt64 {
		return int(number)
	}
	return number
}

// applyDefaults registers every shipped default with viper.
//
// One loop, no hardcoded SetDefault calls: adding a setting is a line of JSON, and the file is
// the only place the catalogue lives (#456).
func (c *configuration) applyDefaults() error {
	values, err := DefaultConfigValues()
	if err != nil {
		return err
	}
	for key, value := range values {
		c.SetDefault(key, value)
	}
	return nil
}
