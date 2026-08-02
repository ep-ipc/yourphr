package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CustomConfigFileName is the instance-custom overlay: the settings an operator changed for
// THIS instance, as opposed to the built-in defaults. Named after the equivalent in
// jwilleke/ngdpbase, whose layering this mirrors.
const CustomConfigFileName = "app-custom-config.json"

// customConfigComment is written back on every save so someone opening the file knows what it
// is and, more importantly, that hand-edits are not merged with anything — the file IS the
// custom layer, and whatever is not in it falls through to the defaults.
const customConfigComment = "Instance-custom configuration for YourPHR. Written by the Admin Dashboard; " +
	"safe to hand-edit while the server is stopped. Only settings that differ from the built-in " +
	"defaults belong here — anything absent falls through to defaults. See docs/configuration.md."

// CustomConfigPath is <data root>/config/app-custom-config.json.
func CustomConfigPath(c Interface) string {
	return filepath.Join(DataDir(c), "config", CustomConfigFileName)
}

// LoadCustomConfig merges the instance-custom overlay into the running configuration.
//
// Layering, lowest to highest precedence:
//
//	built-in defaults (SetDefault)  <  custom config file (this)  <  YOURPHR_* env
//
// Env stays on top deliberately, matching ngdpbase: env governs bootstrap and infrastructure
// (ports, paths, secrets) while the custom file governs instance identity and presentation
// (operator contact, theme, site name). The two layers are not meant to address the same keys,
// so the ordering should never actually be contested — but if it is, a deployment's env wins
// over a file inside the data volume, which is the safer direction for a secret.
//
// A missing file is not an error: an instance that has never customized anything is the normal
// case. A malformed file IS an error — silently ignoring it would present built-in defaults as
// though they were the operator's settings.
func LoadCustomConfig(c Interface) error {
	path := CustomConfigPath(c)

	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading %s: %w", path, err)
	}

	values, err := decodeCustomConfig(raw, path)
	if err != nil {
		return err
	}
	if len(values) == 0 {
		return nil
	}

	if err := c.MergeConfigMap(values); err != nil {
		return fmt.Errorf("merging %s: %w", path, err)
	}
	return nil
}

// SetCustomValues persists dotted keys into the custom overlay and applies them to the running
// configuration, so a change takes effect without a restart.
//
// Read-modify-write on the CUSTOM layer only — the file never absorbs the built-in defaults.
// Writing the merged view instead would freeze today's defaults into the instance forever, so
// a later release that changed a default would silently not apply.
func SetCustomValues(c Interface, values map[string]interface{}) error {
	if len(values) == 0 {
		return nil
	}

	path := CustomConfigPath(c)

	current := map[string]interface{}{}
	if raw, err := os.ReadFile(path); err == nil {
		if decoded, decodeErr := decodeCustomConfig(raw, path); decodeErr != nil {
			// Refuse to overwrite a file we cannot parse — it may hold settings the operator
			// wants back, and clobbering it would destroy them.
			return decodeErr
		} else {
			current = decoded
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("reading %s: %w", path, err)
	}

	for key, value := range values {
		setNested(current, key, value)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}

	current["_comment"] = customConfigComment
	encoded, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding %s: %w", path, err)
	}
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}

	// Apply to the live config so the running process reflects the change immediately.
	for key, value := range values {
		c.Set(key, value)
	}
	return nil
}

// decodeCustomConfig parses the overlay and strips underscore-prefixed keys, which are comments
// rather than settings (same convention as ngdpbase's config files).
func decodeCustomConfig(raw []byte, path string) (map[string]interface{}, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return map[string]interface{}{}, nil
	}

	var values map[string]interface{}
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	stripComments(values)
	return values, nil
}

func stripComments(values map[string]interface{}) {
	for key, value := range values {
		if strings.HasPrefix(key, "_") {
			delete(values, key)
			continue
		}
		if nested, ok := value.(map[string]interface{}); ok {
			stripComments(nested)
		}
	}
}

// setNested writes a dotted key ("operator.contact_email") as nested JSON objects, so the file
// stays readable as structure rather than as a flat list of dotted strings.
//
// A non-object value standing where a branch needs to go is replaced. That only happens if a
// key changed shape between releases, and preserving the stale scalar would leave the new key
// unwritable.
func setNested(target map[string]interface{}, dottedKey string, value interface{}) {
	parts := strings.Split(dottedKey, ".")
	for _, part := range parts[:len(parts)-1] {
		next, ok := target[part].(map[string]interface{})
		if !ok {
			next = map[string]interface{}{}
			target[part] = next
		}
		target = next
	}
	target[parts[len(parts)-1]] = value
}
