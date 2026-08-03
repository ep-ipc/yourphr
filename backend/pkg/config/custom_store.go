package config

import (
	"encoding/json"
	"fmt"
	"log"
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

	flat, err := ResolveEnvRefs(flattenToKnownKeys(values))
	if err != nil {
		return fmt.Errorf("in %s: %w", path, err)
	}

	// Convert a pre-#456 nested file on disk, once, rather than only when something next saves.
	// Otherwise the file stays nested indefinitely — not matching its own documented format, and
	// exercising the compat path on every boot.
	//
	// Best-effort: a read-only volume or a permissions problem must not stop the instance
	// starting, because the in-memory values are already correct either way.
	if isNested(values) {
		if err := rewriteCustomConfigFlat(path, flat); err != nil {
			log.Printf("warning: could not convert %s to flat keys (values still applied): %s", path, err)
		}
	}

	if err := c.MergeConfigMap(flat); err != nil {
		return fmt.Errorf("merging %s: %w", path, err)
	}
	return nil
}

// isNested reports whether any value is an object, i.e. the file predates the flat-key format.
func isNested(values map[string]interface{}) bool {
	for _, value := range values {
		if _, ok := value.(map[string]interface{}); ok {
			return true
		}
	}
	return false
}

// rewriteCustomConfigFlat persists the converted file, keeping the original alongside it.
//
// The nested copy is retained rather than discarded: this runs unattended at startup, and a
// config file is the one thing an operator cannot reconstruct from the code.
func rewriteCustomConfigFlat(path string, flat map[string]interface{}) error {
	if err := os.Rename(path, path+".nested"); err != nil {
		return fmt.Errorf("preserving the original: %w", err)
	}

	out := make(map[string]interface{}, len(flat)+1)
	for key, value := range flat {
		out[key] = value
	}
	out["_comment"] = customConfigComment

	encoded, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		// Put the original back rather than leaving the instance with no custom config at all.
		_ = os.Rename(path+".nested", path)
		return err
	}
	return nil
}

// flattenToKnownKeys converts nested objects into the flat dotted keys the defaults use (#456),
// so a custom file written before that change still applies.
//
// The instances running v1.21.x wrote {"operator":{"contact_email":"..."}}; the format is now
// {"operator.contact_email":"..."}. Both must work, because the old file is sitting on a PVC and
// nobody is going to hand-edit it.
//
// Flattening stops as soon as the accumulated path names a real setting, so an object that IS a
// value (a future key whose default is a map) is passed through whole rather than being torn
// apart into keys nobody declared.
func flattenToKnownKeys(values map[string]interface{}) map[string]interface{} {
	known, err := DefaultConfigValues()
	if err != nil {
		// Defaults are embedded, so this cannot fail in practice. If it somehow does, pass the
		// values through untouched rather than silently dropping the operator's settings.
		return values
	}

	out := make(map[string]interface{}, len(values))
	var walk func(prefix string, value interface{})
	walk = func(prefix string, value interface{}) {
		if _, isSetting := known[prefix]; !isSetting {
			if nested, ok := value.(map[string]interface{}); ok && prefix != "" {
				for key, child := range nested {
					walk(prefix+"."+key, child)
				}
				return
			}
		}
		out[prefix] = value
	}

	for key, value := range values {
		if nested, ok := value.(map[string]interface{}); ok {
			if _, isSetting := known[key]; !isSetting {
				for child, childValue := range nested {
					walk(key+"."+child, childValue)
				}
				continue
			}
		}
		out[key] = value
	}
	return out
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

	// Written flat, matching app-default-config.json (#456). A file written in the older nested
	// shape is folded into flat keys first, so a save does not leave the two styles interleaved.
	current = flattenToKnownKeys(current)
	for key, value := range values {
		current[key] = value
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

// CustomConfigValues returns ONLY this instance's overrides, flat and without comments.
//
// Distinct from reading the running config, which is the merged view and cannot tell you which
// values an operator actually chose. The Admin configuration screen (#458) needs both: the
// merged result to show what is in effect, and this to show what was changed from stock.
//
// A missing file means no overrides, not an error.
func CustomConfigValues(c Interface) (map[string]interface{}, error) {
	path := CustomConfigPath(c)

	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]interface{}{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	values, err := decodeCustomConfig(raw, path)
	if err != nil {
		return nil, err
	}
	return flattenToKnownKeys(values), nil
}

// ClearCustomValue removes a key from the overlay, so the setting falls back to its shipped
// default. Returns false when the key was not overridden in the first place.
//
// Deliberately distinct from setting an empty value: "" is a legitimate setting an operator may
// choose (no contact URL), and it must stay distinguishable from "use whatever ships".
func ClearCustomValue(c Interface, key string) (bool, error) {
	path := CustomConfigPath(c)

	current, err := CustomConfigValues(c)
	if err != nil {
		return false, err
	}
	if _, present := current[key]; !present {
		return false, nil
	}
	delete(current, key)

	current["_comment"] = customConfigComment
	encoded, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return false, err
	}
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		return false, fmt.Errorf("writing %s: %w", path, err)
	}

	// Restore the shipped default in the running config, so the change takes effect without a
	// restart in the same way a set does.
	defaults, err := DefaultConfigValues()
	if err != nil {
		return true, err
	}
	c.Set(key, defaults[key])
	return true, nil
}
