package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	mock_config "github.com/fastenhealth/fasten-onprem/backend/pkg/config/mock"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

func TestLooksLikeCDA(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"cda xml", `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"></ClinicalDocument>`, true},
		{"cda with leading whitespace", "  \n<ClinicalDocument/>", true},
		{"fhir json bundle", `{"resourceType":"Bundle","type":"batch","entry":[]}`, false},
		{"fhir ndjson", "{\"resourceType\":\"Patient\"}\n{\"resourceType\":\"Observation\"}", false},
		{"plain xml non-cda", `<?xml version="1.0"?><Foo/>`, false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, looksLikeCDA([]byte(tc.in)))
		})
	}
}

func TestCDAPatientID(t *testing.T) {
	cda := []byte(`<ClinicalDocument xmlns="urn:hl7-org:v3"><recordTarget><patientRole>` +
		`<id root="2.16.840.1.113883.19.5" extension="MRN-123"/></patientRole></recordTarget></ClinicalDocument>`)

	// deterministic: same input -> same id across calls
	id1 := cdaPatientID(cda)
	id2 := cdaPatientID(cda)
	require.Equal(t, id1, id2)
	require.Regexp(t, `^cda-[0-9a-f]{16}$`, id1)

	// a different record-target id -> a different patient id
	other := []byte(`<ClinicalDocument xmlns="urn:hl7-org:v3"><recordTarget><patientRole>` +
		`<id root="2.16.840.1.113883.19.5" extension="MRN-999"/></patientRole></recordTarget></ClinicalDocument>`)
	require.NotEqual(t, id1, cdaPatientID(other))

	// no record-target id -> falls back to a (still deterministic) document hash
	noId := []byte(`<ClinicalDocument xmlns="urn:hl7-org:v3"></ClinicalDocument>`)
	require.Equal(t, cdaPatientID(noId), cdaPatientID(noId))
	require.Regexp(t, `^cda-[0-9a-f]{16}$`, cdaPatientID(noId))
}

func TestConvertCDAToFHIR(t *testing.T) {
	cda := []byte(`<ClinicalDocument xmlns="urn:hl7-org:v3"></ClinicalDocument>`)

	t.Run("happy path unwraps fhirResource", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		var gotPath, gotPatient string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotPath = r.URL.Path
			gotPatient = r.URL.Query().Get("patientId")
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"fhirResource":{"resourceType":"Bundle","type":"batch","entry":[]}}`)
		}))
		defer srv.Close()

		cfg := mock_config.NewMockInterface(ctrl)
		cfg.EXPECT().GetBool("cda_converter.enabled").Return(true).AnyTimes()
		cfg.EXPECT().GetString("cda_converter.url").Return(srv.URL).AnyTimes()
		cfg.EXPECT().GetInt("cda_converter.timeout_seconds").Return(60).AnyTimes()

		out, err := convertCDAToFHIR(context.Background(), cfg, cda, "cda-abc")
		require.NoError(t, err)
		require.JSONEq(t, `{"resourceType":"Bundle","type":"batch","entry":[]}`, string(out))
		require.Equal(t, "/api/convert/cda/ccd.hbs", gotPath)
		require.Equal(t, "cda-abc", gotPatient)
	})

	t.Run("disabled -> clear error", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		cfg := mock_config.NewMockInterface(ctrl)
		cfg.EXPECT().GetBool("cda_converter.enabled").Return(false).AnyTimes()
		_, err := convertCDAToFHIR(context.Background(), cfg, cda, "p")
		require.ErrorContains(t, err, "not enabled")
	})

	t.Run("no url configured -> clear error", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		cfg := mock_config.NewMockInterface(ctrl)
		cfg.EXPECT().GetBool("cda_converter.enabled").Return(true).AnyTimes()
		cfg.EXPECT().GetString("cda_converter.url").Return("").AnyTimes()
		_, err := convertCDAToFHIR(context.Background(), cfg, cda, "p")
		require.ErrorContains(t, err, "no converter address is configured")
		// The flag alone looks configured from the outside; the error must name the missing URL var (#397).
		require.ErrorContains(t, err, "YOURPHR_CDA_CONVERTER_URL")
	})

	t.Run("non-200 -> error", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "boom", http.StatusInternalServerError)
		}))
		defer srv.Close()
		cfg := mock_config.NewMockInterface(ctrl)
		cfg.EXPECT().GetBool("cda_converter.enabled").Return(true).AnyTimes()
		cfg.EXPECT().GetString("cda_converter.url").Return(srv.URL).AnyTimes()
		cfg.EXPECT().GetInt("cda_converter.timeout_seconds").Return(60).AnyTimes()
		_, err := convertCDAToFHIR(context.Background(), cfg, cda, "p")
		require.ErrorContains(t, err, "HTTP 500")
	})

	t.Run("missing fhirResource -> error", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, `{"somethingElse":true}`)
		}))
		defer srv.Close()
		cfg := mock_config.NewMockInterface(ctrl)
		cfg.EXPECT().GetBool("cda_converter.enabled").Return(true).AnyTimes()
		cfg.EXPECT().GetString("cda_converter.url").Return(srv.URL).AnyTimes()
		cfg.EXPECT().GetInt("cda_converter.timeout_seconds").Return(60).AnyTimes()
		_, err := convertCDAToFHIR(context.Background(), cfg, cda, "p")
		require.ErrorContains(t, err, "missing fhirResource")
	})
}

// newMockConverterServer returns an httptest server that mimics the fhir-converter: it wraps the
// committed Metriport-output fixture in {"fhirResource": <bundle>}, so the upload->convert->import
// edge can be tested hermetically (no Docker / live sidecar).
func newMockConverterServer(t *testing.T) *httptest.Server {
	bundle, err := os.ReadFile("testdata/ccda_to_fhir_converted_C-CDA_R2-1_CCD.xml.json")
	require.NoError(t, err)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"fhirResource":`)
		w.Write(bundle)
		io.WriteString(w, `}`)
	}))
}

func (suite *SourceHandlerTestSuite) TestCreateManualSourceHandler_ConvertsCCDA() {
	srv := newMockConverterServer(suite.T())
	defer srv.Close()
	suite.AppConfig.EXPECT().GetBool("cda_converter.enabled").Return(true).AnyTimes()
	suite.AppConfig.EXPECT().GetString("cda_converter.url").Return(srv.URL).AnyTimes()
	suite.AppConfig.EXPECT().GetInt("cda_converter.timeout_seconds").Return(60).AnyTimes()

	w := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(w)
	ctx.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", suite.T().Name()))
	ctx.Set(pkg.ContextKeyTypeDatabase, suite.AppRepository)
	ctx.Set(pkg.ContextKeyTypeConfig, suite.AppConfig)
	ctx.Set(pkg.ContextKeyTypeEventBusServer, suite.AppEventBus)
	ctx.Set(pkg.ContextKeyTypeAuthUsername, "test_username")

	req, err := CreateManualSourceHttpRequestFromFile("testdata/sample_minimal_ccd.xml")
	require.NoError(suite.T(), err)
	ctx.Request = req

	CreateManualSource(ctx)

	require.Equal(suite.T(), http.StatusOK, w.Code)
	var resp struct {
		Data    struct{ TotalResources int } `json:"data"`
		Success bool                         `json:"success"`
	}
	require.NoError(suite.T(), json.Unmarshal(w.Body.Bytes(), &resp))
	require.True(suite.T(), resp.Success)
	require.Equal(suite.T(), 65, resp.Data.TotalResources)
}

func (suite *SourceHandlerTestSuite) TestCreateManualSourceHandler_CCDAConverterDisabled() {
	suite.AppConfig.EXPECT().GetBool("cda_converter.enabled").Return(false).AnyTimes()

	w := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(w)
	ctx.Set(pkg.ContextKeyTypeLogger, logrus.WithField("test", suite.T().Name()))
	ctx.Set(pkg.ContextKeyTypeDatabase, suite.AppRepository)
	ctx.Set(pkg.ContextKeyTypeConfig, suite.AppConfig)
	ctx.Set(pkg.ContextKeyTypeEventBusServer, suite.AppEventBus)
	ctx.Set(pkg.ContextKeyTypeAuthUsername, "test_username")

	req, err := CreateManualSourceHttpRequestFromFile("testdata/sample_minimal_ccd.xml")
	require.NoError(suite.T(), err)
	ctx.Request = req

	CreateManualSource(ctx)

	require.Equal(suite.T(), http.StatusBadRequest, w.Code)
	require.Contains(suite.T(), w.Body.String(), "not enabled")
}

// TestCDASetupHintIsActionable pins the content that #397 was missing. A self-hoster tried
// FASTEN_CDA_CONVERTER_ENABLED and a bare CDA_CONVERTER_ENABLED because the old error named a
// config KEY and no env var; it also never mentioned that a sidecar has to be running. If these
// assertions ever fail, the error has gone back to being un-actionable.
func TestCDASetupHintIsActionable(t *testing.T) {
	hint := cdaSetupHint("C-CDA import is not enabled on this server.")

	require.Contains(t, hint, "YOURPHR_CDA_CONVERTER_ENABLED", "must name the actual env var, not just the config key")
	require.Contains(t, hint, "YOURPHR_CDA_CONVERTER_URL", "the flag alone is not enough — the URL is required too")
	require.Contains(t, hint, "docker compose --profile cda up -d", "must say the sidecar has to be started")
	require.Contains(t, hint, "docs/import/c-cda.md")
}

// TestGetCDAConverterStatus covers the three deployment states the UI branches on (#397).
// The half-configured case (enabled, no URL) is the one that is hardest to diagnose from the
// outside, so it must report ready=false rather than looking healthy.
func TestGetCDAConverterStatus(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name      string
		enabled   bool
		url       string
		wantReady bool
	}{
		{"off by default", false, "", false},
		{"enabled but no url is NOT ready", true, "", false},
		{"fully configured", true, "http://cda-converter:8080", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			cfg := mock_config.NewMockInterface(ctrl)
			cfg.EXPECT().GetBool("cda_converter.enabled").Return(tt.enabled).AnyTimes()
			cfg.EXPECT().GetString("cda_converter.url").Return(tt.url).AnyTimes()

			w := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(w)
			ctx.Set(pkg.ContextKeyTypeConfig, cfg)
			ctx.Request, _ = http.NewRequest("GET", "/source/cda-converter/status", nil)

			GetCDAConverterStatus(ctx)

			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			var resp struct {
				Data struct {
					Enabled   bool   `json:"enabled"`
					Ready     bool   `json:"ready"`
					SetupHint string `json:"setup_hint"`
				} `json:"data"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
			require.Equal(t, tt.enabled, resp.Data.Enabled)
			require.Equal(t, tt.wantReady, resp.Data.Ready)
			require.NotEmpty(t, resp.Data.SetupHint)
			// The hint carries the standard compose service address as an example — that is the
			// point of it. What must never leak is this deployment's CONFIGURED url.
			require.NotContains(t, w.Body.String(), `"url"`)
		})
	}
}

// TestCDAUnreachableHintIsActionable — since #404 the converter is ENABLED BY DEFAULT, so
// "enabled but nothing answering" became the likely failure rather than an edge case: any
// deployment without the sidecar (bare k8s Deployment, or compose scaled to 0) lands here. An
// operator seeing only "connection refused" has nothing to act on, so the hint must offer all
// three exits — start it, repoint it, or turn the feature off.
func TestCDAUnreachableHintIsActionable(t *testing.T) {
	hint := cdaUnreachableHint()

	require.Contains(t, hint, "cda-converter", "must name the sidecar to start")
	require.Contains(t, hint, "YOURPHR_CDA_CONVERTER_URL", "must offer repointing it")
	require.Contains(t, hint, "YOURPHR_CDA_CONVERTER_ENABLED=false", "must offer turning it OFF — the settings are already correct here")
	require.Contains(t, hint, "docs/import/c-cda.md")

	// It must NOT tell the operator to set the enable flag: it is already set, and repeating the
	// misconfiguration advice would send them in circles. That is cdaSetupHint's job, not this one.
	require.NotContains(t, hint, "YOURPHR_CDA_CONVERTER_ENABLED=true")
}

// TestConvertCDAUnreachableSurfacesTheHint proves the hint actually reaches the caller when the
// sidecar is down, rather than only existing as a function.
func TestConvertCDAUnreachableSurfacesTheHint(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// A server that is closed immediately => a guaranteed-dead address.
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := srv.URL
	srv.Close()

	cfg := mock_config.NewMockInterface(ctrl)
	cfg.EXPECT().GetBool("cda_converter.enabled").Return(true).AnyTimes()
	cfg.EXPECT().GetString("cda_converter.url").Return(deadURL).AnyTimes()
	cfg.EXPECT().GetInt("cda_converter.timeout_seconds").Return(5).AnyTimes()

	_, err := convertCDAToFHIR(context.Background(), cfg, []byte(`<ClinicalDocument/>`), "p")
	require.Error(t, err)
	require.Contains(t, err.Error(), "unreachable")
	require.Contains(t, err.Error(), deadURL, "naming the address it tried is half the diagnosis")
	require.Contains(t, err.Error(), "YOURPHR_CDA_CONVERTER_ENABLED=false")
}
