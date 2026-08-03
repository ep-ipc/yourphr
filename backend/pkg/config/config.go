package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"github.com/analogj/go-util/utils"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/errors"
	"github.com/spf13/viper"
	"github.com/subosito/gotenv"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// dotEnvFiles are loaded into the process environment at startup, in precedence order: a value in an
// earlier file wins over a later one, and a value already in the real OS environment wins over both.
// So: .env (base/committed example) < .env_custom (per-deployment, gitignored) < OS env. Missing files
// are ignored. Values use the YOURPHR_ prefix (see Init).
var dotEnvFiles = []string{".env_custom", ".env"}

// loadDotEnvFiles merges the layered dotenv files into the environment without overriding values that
// are already set (gotenv.Load is non-override), giving the precedence documented on dotEnvFiles.
func loadDotEnvFiles() {
	for _, f := range dotEnvFiles {
		if _, err := os.Stat(f); err == nil {
			if err := gotenv.Load(f); err != nil {
				log.Printf("warning: could not load env file %s: %s", f, err)
			}
		}
	}
}

// DefaultJWTIssuerKey is the placeholder HS256 signing key inherited from upstream Fasten. It is
// a KNOWN PUBLIC value present in this repo and in every Fasten deployment, so anything signing
// tokens with it can have sessions forged for any user or role.
//
// It is no longer a default. app-default-config.json carries the env reference
// "${YOURPHR_JWT_ISSUER_KEY}" instead, which resolves empty when unset — and empty already means
// "generate a real key" (see ResolveJWTIssuerKey). The constant survives only to keep rejecting
// this specific string, because it still appears in the committed config.yaml and in upstream
// deployment guides, so an operator can arrive carrying it.
//
// Removing the sentinel-as-default matters beyond tidiness: it was a value whose meaning depended
// on being byte-identical to a constant elsewhere, which is the same shape as the bug that
// crash-looped prod and demo on v1.21.0.
const DefaultJWTIssuerKey = "thisismysupersecuressessionsecretlength"

// jwtKeyFileName is the basename of the auto-generated JWT signing key, persisted
// in the runtime data directory (alongside the SQLite DB) with 0600 permissions.
const jwtKeyFileName = ".jwt_issuer_key"

// ResolveJWTIssuerKey returns the effective JWT signing key, secure-by-default with
// zero configuration (issue #102). JWTs are signed/verified with HS256 (a symmetric
// key), so this is the root of trust for all auth and per-user data isolation —
// the committed public default must never be used to sign tokens. Resolution order:
//
//  1. an explicit, non-default configuredKey (jwt.issuer.key / YOURPHR_JWT_ISSUER_KEY)
//     is honored as-is, so operators/secret-managers keep full control — optionally;
//  2. otherwise a key previously persisted at <dataDir>/.jwt_issuer_key is reused
//     (stable across restarts, so sessions survive reboots);
//  3. otherwise a new 256-bit random key is generated, persisted there (0600), and
//     returned — so a fresh `docker run` is secure with no operator action.
//
// The committed public default (DefaultJWTIssuerKey) and "" are both treated as
// "unset", triggering reuse-or-generate rather than ever signing with the default.
func ResolveJWTIssuerKey(configuredKey string, dataDir string) (string, error) {
	if configuredKey != "" && configuredKey != DefaultJWTIssuerKey {
		return configuredKey, nil
	}
	if dataDir == "" {
		return "", fmt.Errorf("cannot resolve JWT signing key: data directory is empty (set jwt.issuer.key / YOURPHR_JWT_ISSUER_KEY, or database.location)")
	}

	keyPath := filepath.Join(dataDir, jwtKeyFileName)
	if existing, err := os.ReadFile(keyPath); err == nil {
		if key := strings.TrimSpace(string(existing)); key != "" {
			return key, nil
		}
	}

	// Generate a new 256-bit key, hex-encoded (equivalent to `openssl rand -hex 32`).
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate JWT signing key: %w", err)
	}
	key := hex.EncodeToString(buf)

	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return "", fmt.Errorf("failed to create data dir %q for the JWT signing key: %w", dataDir, err)
	}
	if err := os.WriteFile(keyPath, []byte(key), 0600); err != nil {
		return "", fmt.Errorf("failed to persist the generated JWT signing key to %q: %w", keyPath, err)
	}
	return key, nil
}

// When initializing this class the following methods must be called:
// Config.New
// Config.Init
// This is done automatically when created via the Factory.
type configuration struct {
	*viper.Viper
}

func (c *configuration) Init() error {
	c.Viper = viper.New()

	// Layer dotenv files into the environment before viper reads env via AutomaticEnv below.
	loadDotEnvFiles()

	// Register every shipped default from app-default-config.json (#456). One loop, no
	// hardcoded SetDefault calls — the JSON file is the single catalogue of what an instance
	// can be configured to do, and is what the Admin configuration screen reads.
	//
	// Rationale for each default lives beside it in that file as a "_comment_*" key, so the
	// explanation travels with the value instead of living in Go the value no longer does.
	if err := c.applyDefaults(); err != nil {
		return err
	}

	//set the default system config file search path.
	//if you want to load a non-standard location system config file (~/capsule.yml), use ReadConfig
	//if you want to load a repo specific config file, use ReadConfig
	c.SetConfigType("yaml")
	c.SetConfigName("template")
	c.AddConfigPath("$HOME/")

	//configure env variable parsing: YOURPHR_<KEY> with '.'/'-' -> '_' (e.g. cda_converter.enabled
	//-> YOURPHR_CDA_CONVERTER_ENABLED).
	c.SetEnvPrefix("YOURPHR")
	c.SetEnvKeyReplacer(strings.NewReplacer("-", "_", ".", "_"))
	c.AutomaticEnv()
	//CLI options will be added via the `Set()` function

	// Unprefixed host vars, bound explicitly because AutomaticEnv only maps YOURPHR_*. These
	// describe how the app is reached from OUTSIDE the container (docker-compose publishes
	// HOST_IP:HOST_PORT), so they cannot be derived from web.listen.*. Bound here rather than
	// read with os.Getenv at the point of use, so config stays the single accessor (#455).
	_ = c.BindEnv("host.port", "HOST_PORT")
	_ = c.BindEnv("host.ip", "HOST_IP")

	return nil
}

func (c *configuration) ReadConfig(configFilePath string) error {

	if !utils.FileExists(configFilePath) {
		message := fmt.Sprintf("The configuration file (%s) could not be found. Skipping", configFilePath)
		log.Print(message)
		return errors.ConfigFileMissingError("The configuration file could not be found.")
	}

	log.Printf("Loading configuration file: %s", configFilePath)

	config_data, err := os.Open(configFilePath)
	if err != nil {
		log.Printf("Error reading configuration file: %s", err)
		return err
	}
	err = c.MergeConfig(config_data)
	if err != nil {
		log.Printf("Error merging config file: %s", err)
		return err
	}
	return c.ValidateConfig()
}

// This function ensures that required configuration keys (that must be manually set) are present
func (c *configuration) ValidateConfig() error {
	if c.IsSet("database.encryption.key") {
		key := c.GetString("database.encryption.key")
		if key == "" {
			return errors.ConfigValidationError("database.encryption.key cannot be empty")
		}
		if len(key) < 10 {
			return errors.ConfigValidationError("database.encryption.key must be at least 10 characters")
		}
	}
	return nil
}
