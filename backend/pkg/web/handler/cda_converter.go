package handler

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// C-CDA / CCD import (#254). Manual upload is otherwise FHIR-JSON/NDJSON only. When a raw
// C-CDA XML document is uploaded, we convert it to a FHIR R4 bundle via the external
// fhir-converter sidecar (Metriport) and then feed it through the existing import pipeline
// unchanged. Conversion is opt-in (cda_converter.enabled) and the sidecar is internal-only
// (raw CCD is PHI).

// looksLikeCDA reports whether the uploaded bytes are a C-CDA (HL7 CDA R2) XML document
// rather than a FHIR JSON/NDJSON bundle. We require both an XML root and the ClinicalDocument
// element so a stray FHIR-XML upload doesn't get mis-routed to the converter.
func looksLikeCDA(data []byte) bool {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '<' {
		return false
	}
	return bytes.Contains(trimmed, []byte("ClinicalDocument"))
}

// cdaPatientID derives a STABLE patient id from the CDA recordTarget/patientRole/id. The
// fhir-converter uses the patientId we pass as the FHIR Patient.id, so it must be deterministic
// per patient — otherwise re-importing the same person's documents mints a new Patient each time
// and breaks idempotent dedup (#252, confirmed in #254 Phase 0). Falls back to hashing the whole
// document when no record-target id is present (still deterministic per document).
func cdaPatientID(cdaXML []byte) string {
	var doc struct {
		RecordTarget []struct {
			PatientRole struct {
				ID []struct {
					Root      string `xml:"root,attr"`
					Extension string `xml:"extension,attr"`
				} `xml:"id"`
			} `xml:"patientRole"`
		} `xml:"recordTarget"`
	}
	seed := ""
	if err := xml.Unmarshal(cdaXML, &doc); err == nil {
		for _, rt := range doc.RecordTarget {
			for _, id := range rt.PatientRole.ID {
				if id.Root != "" || id.Extension != "" {
					seed = id.Root + "|" + id.Extension
					break
				}
			}
			if seed != "" {
				break
			}
		}
	}
	if seed == "" {
		seed = string(cdaXML)
	}
	sum := sha1.Sum([]byte(seed))
	return fmt.Sprintf("cda-%x", sum[:8]) // 16 hex chars — a valid, stable FHIR id
}

// GetCDAConverterStatus reports whether this server can actually convert a C-CDA upload, so the
// UI can stop offering a "Convert" button that is guaranteed to fail (#397). Returns only
// deployment booleans and the operator-facing setup text — no URL, since the sidecar address is
// internal infrastructure the browser has no business knowing.
func GetCDAConverterStatus(c *gin.Context) {
	cfg := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	enabled := cfg.GetBool("cda_converter.enabled")
	configured := strings.TrimSpace(cfg.GetString("cda_converter.url")) != ""
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"enabled": enabled,
		// ready means BOTH settings are present. Either one alone still fails the upload, and the
		// half-configured case is exactly what made #397 hard to diagnose.
		"ready":      enabled && configured,
		"setup_hint": cdaSetupHint("C-CDA import is not available on this server."),
	}})
}

// cdaSetupHint appends the exact steps needed to turn C-CDA import on. The bare
// "set cda_converter.enabled" wording sent a user down a dead end (#397): config KEYS are not env
// VAR names, so they tried FASTEN_CDA_CONVERTER_ENABLED and CDA_CONVERTER_ENABLED (the prefix is
// YOURPHR_), and nothing told them a separate sidecar container has to be running at all. An error
// a self-hoster cannot act on is a bug in the error, so name both variables and the command.
func cdaSetupHint(problem string) string {
	return problem + " C-CDA import needs the converter sidecar running AND two settings:\n" +
		"  1. start the sidecar:  docker compose --profile cda up -d\n" +
		"  2. YOURPHR_CDA_CONVERTER_ENABLED=true\n" +
		"  3. YOURPHR_CDA_CONVERTER_URL=http://cda-converter:8080\n" +
		"Set 2 and 3 in your .env (or .env_custom) and restart, then retry the upload. " +
		"Note the YOURPHR_ prefix — the config keys are cda_converter.enabled / cda_converter.url. " +
		"See docs/import/c-cda.md."
}

// cdaUnreachableHint covers the "enabled but nothing answering" case. Distinct from cdaSetupHint:
// the settings are already correct here, so telling the operator to set them again would be wrong.
// What they need is the sidecar actually running, or the feature turned off.
func cdaUnreachableHint() string {
	return "C-CDA import is enabled but the converter did not answer. Either start the sidecar" +
		" (`docker compose up -d cda-converter`; it runs by default in the shipped compose files, and" +
		" on k8s see deploy/yourphr-cda-converter.example.yaml), point YOURPHR_CDA_CONVERTER_URL at a" +
		" reachable one, or set YOURPHR_CDA_CONVERTER_ENABLED=false to turn C-CDA import off." +
		" See docs/import/c-cda.md."
}

// convertCDAToFHIR posts a raw C-CDA document to the fhir-converter sidecar and returns the
// unwrapped FHIR R4 Bundle JSON. The converter wraps its output as {"fhirResource": <Bundle>}
// (#254 Phase 0). Returns actionable errors when conversion is disabled or the sidecar is
// unreachable, so the caller can surface them without affecting FHIR/NDJSON import.
func convertCDAToFHIR(ctx context.Context, cfg config.Interface, cdaXML []byte, patientID string) ([]byte, error) {
	if !cfg.GetBool("cda_converter.enabled") {
		return nil, fmt.Errorf("%s", cdaSetupHint("C-CDA import is not enabled on this server."))
	}
	baseURL := cfg.GetString("cda_converter.url")
	if baseURL == "" {
		return nil, fmt.Errorf("%s", cdaSetupHint("C-CDA import is enabled but no converter address is configured."))
	}
	timeout := cfg.GetInt("cda_converter.timeout_seconds")
	if timeout <= 0 {
		timeout = 60
	}

	endpoint := fmt.Sprintf("%s/api/convert/cda/ccd.hbs?patientId=%s", strings.TrimRight(baseURL, "/"), url.QueryEscape(patientID))
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(cdaXML))
	if err != nil {
		return nil, fmt.Errorf("building C-CDA converter request: %w", err)
	}
	req.Header.Set("Content-Type", "text/plain")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Now the LIKELY failure, not an edge case: since #404 the converter is enabled by default,
		// so anyone running the app without the sidecar (a bare k8s Deployment, or compose with the
		// service scaled to 0) lands here rather than on the "not enabled" path. Carry the same
		// actionable text — an operator seeing only "connection refused" has nothing to act on.
		return nil, fmt.Errorf("C-CDA conversion service unreachable at %s: %w. %s",
			baseURL, err, cdaUnreachableHint())
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading C-CDA converter response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("C-CDA converter returned HTTP %d: %s", resp.StatusCode, truncateForError(body, 300))
	}

	var envelope struct {
		FhirResource json.RawMessage `json:"fhirResource"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("parsing C-CDA converter response: %w", err)
	}
	if len(bytes.TrimSpace(envelope.FhirResource)) == 0 {
		return nil, fmt.Errorf("C-CDA converter response missing fhirResource")
	}
	return envelope.FhirResource, nil
}

// maybeConvertCDA inspects the uploaded bundle; if it's a C-CDA document it converts it to a
// FHIR R4 bundle via the sidecar and returns a new temp file holding the converted JSON. FHIR
// JSON/NDJSON uploads are returned unchanged (rewound). The original raw-CDA temp file is removed
// once converted.
func maybeConvertCDA(c *gin.Context, logger *logrus.Entry, bundleFile *os.File) (*os.File, error) {
	data, err := io.ReadAll(bundleFile)
	if err != nil {
		return nil, fmt.Errorf("reading uploaded file: %w", err)
	}
	if !looksLikeCDA(data) {
		if _, err := bundleFile.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
		return bundleFile, nil
	}

	cfg := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	patientID := cdaPatientID(data)
	logger.Infof("detected C-CDA upload — converting via sidecar (patientId=%s, %d bytes)", patientID, len(data))

	fhirBytes, err := convertCDAToFHIR(c.Request.Context(), cfg, data, patientID)
	if err != nil {
		return nil, err
	}

	converted, err := os.CreateTemp("", "fasten-cda-converted-*.json")
	if err != nil {
		return nil, fmt.Errorf("creating converted temp file: %w", err)
	}
	if _, err := converted.Write(fhirBytes); err != nil {
		converted.Close()
		return nil, fmt.Errorf("writing converted bundle: %w", err)
	}
	if _, err := converted.Seek(0, io.SeekStart); err != nil {
		converted.Close()
		return nil, err
	}

	// best-effort cleanup of the original raw-CDA temp file
	origName := bundleFile.Name()
	_ = bundleFile.Close()
	_ = os.Remove(origName)
	return converted, nil
}

func truncateForError(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n]) + "…"
	}
	return string(b)
}
