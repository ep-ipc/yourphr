package database

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/event_bus"
	"github.com/sirupsen/logrus"

	//"github.com/glebarez/sqlite"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// ErrSqlcipherNotActive means database encryption is enabled in config but the connected driver is
// not SQLCipher-capable, so data would be written UNENCRYPTED. Callers must treat this as fatal —
// the whole point is to fail loudly instead of silently storing PHI in plaintext (#401).
var ErrSqlcipherNotActive = errors.New("database encryption is enabled but SQLCipher is NOT active")

// verifySqlcipherActive confirms the SQLCipher driver is really in effect on an open connection.
//
// `PRAGMA cipher` returns "sqlcipher" on the SQLCipher-enabled driver. On the stock mattn driver the
// pragma is unrecognized and yields an empty string (or errors) — which is exactly the silent-
// plaintext case this guards. Both outcomes are treated as failure.
func verifySqlcipherActive(database *gorm.DB) error {
	var cipher string
	if resp := database.Raw("PRAGMA cipher;").Scan(&cipher); resp.Error != nil {
		return fmt.Errorf("%w: could not read `PRAGMA cipher` (the driver likely has no SQLCipher support): %v."+
			" %s", ErrSqlcipherNotActive, resp.Error, sqlcipherRemediation)
	}
	if !strings.EqualFold(strings.TrimSpace(cipher), "sqlcipher") {
		return fmt.Errorf("%w: `PRAGMA cipher` returned %q, want \"sqlcipher\"."+
			" Refusing to start rather than write patient data unencrypted. %s",
			ErrSqlcipherNotActive, cipher, sqlcipherRemediation)
	}
	return nil
}

// sqlcipherRemediation tells the operator what actually causes this, since the symptom (a working
// database) gives no clue. Almost always a dependency bump moved go-sqlite3 off the version the
// `replace` directive redirects to the SQLCipher fork.
const sqlcipherRemediation = "This usually means github.com/mattn/go-sqlite3 was upgraded past the version" +
	" redirected by the `replace` directive in go.mod, so the build linked the stock driver instead of" +
	" github.com/jgiannuzzi/go-sqlite3. Check `go list -m github.com/mattn/go-sqlite3` and see issue #401."

// uses github.com/mattn/go-sqlite3 driver (warning, uses CGO)
func newSqliteRepository(appConfig config.Interface, globalLogger logrus.FieldLogger, eventBus event_bus.Interface, validationMode bool) (DatabaseRepository, error) {
	//backgroundContext := context.Background()

	////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
	// Gorm/SQLite setup
	////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
	globalLogger.Infof("Trying to connect to sqlite db: %s\n", appConfig.GetString("database.location"))

	// BUSY TIMEOUT SETTING DOCS ---
	// When a transaction cannot lock the database, because it is already locked by another one,
	// SQLite by default throws an error: database is locked. This behavior is usually not appropriate when
	// concurrent access is needed, typically when multiple processes write to the same database.
	// PRAGMA busy_timeout lets you set a timeout or a handler for these events. When setting a timeout,
	// SQLite will try the transaction multiple times within this timeout.
	// fixes #341
	// https://rsqlite.r-dbi.org/reference/sqlitesetbusyhandler
	// retrying for 30000 milliseconds, 30seconds - this would be unreasonable for a distributed multi-tenant application,
	// but should be fine for local usage.
	//
	// JOURNAL MODE WAL DOCS ---
	//
	// Write-Ahead Logging or WAL (New Way)
	// In this case all writes are appended to a temporary file (write-ahead log) and this file is periodically merged with the original database. When SQLite is searching for something it would first check this temporary file and if nothing is found proceed with the main database file.
	// As a result, readers don’t compete with writers and performance is much better compared to the Old Way.
	// https://stackoverflow.com/questions/4060772/sqlite-concurrent-access
	//
	// NOTE: this schema is driver specific, and may not work with other drivers.
	// eg.https://github.com/mattn/go-sqlite3 uses `?_journal_mode=WAL` prefixes
	// https://github.com/glebarez/sqlite uses `?_pragma=journal_mode(WAL)`
	// see https://github.com/mattn/go-sqlite3/compare/master...jgiannuzzi:go-sqlite3:sqlite3mc
	// see https://github.com/mattn/go-sqlite3/pull/1109
	pragmaOpts := map[string]string{
		"_busy_timeout": "5000",
		"_foreign_keys": "on",
		"_journal_mode": "WAL",
	}

	if validationMode {
		pragmaOpts["mode"] = "ro"
	}

	if appConfig.GetBool("database.encryption.enabled") {
		encryptionKey := appConfig.GetString("database.encryption.key")
		if encryptionKey == "" {
			return nil, fmt.Errorf("database encryption key is not set")
		}

		// Configure sqlcipher
		pragmaOpts["_cipher"] = "sqlcipher"
		pragmaOpts["_legacy"] = "3"
		pragmaOpts["_hmac_use"] = "off"
		pragmaOpts["_kdf_iter"] = "4000"
		pragmaOpts["_legacy_page_size"] = "1024"
		pragmaOpts["_key"] = encryptionKey
	}

	pragmaStr := sqlitePragmaString(pragmaOpts)

	dsn := "file:" + appConfig.GetString("database.location") + pragmaStr
	database, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		//TODO: figure out how to log database queries again.
		//logger: logger
		DisableForeignKeyConstraintWhenMigrating: true,
	})

	if err != nil {
		if strings.Contains(err.Error(), "file is not a database") {
			return nil, fmt.Errorf("failed to connect to database! encryption key may be incorrect - %w", err)
		}

		return nil, fmt.Errorf("failed to connect to database! - %w", err)
	}
	if strings.ToUpper(appConfig.GetString("log.level")) == "DEBUG" {
		database = database.Debug() //set debug globally
	}

	// FAIL CLOSED: prove encryption is actually active before anything is written (#401).
	//
	// The `_cipher=sqlcipher` DSN pragma above is only understood by the SQLCipher-enabled driver
	// (jgiannuzzi/go-sqlite3, wired in via a `replace` in go.mod). Link the stock mattn driver
	// instead and those pragmas become UNKNOWN PARAMETERS THAT ARE SILENTLY IGNORED: the database
	// opens fine, the app runs fine, and PHI is written in plaintext while the config still says
	// encryption is on. There is no error to notice.
	//
	// That is not hypothetical — a routine `gorm.io/driver/sqlite` bump drags go-sqlite3 past the
	// version pinned in the replace directive, which stops matching, and the stock driver gets
	// linked. So verify the cipher is really in effect and refuse to start if it is not.
	if appConfig.GetBool("database.encryption.enabled") {
		if err := verifySqlcipherActive(database); err != nil {
			return nil, err
		}
	}

	globalLogger.Infof("Successfully connected to fasten sqlite db: %s\n", dsn)

	////verify journal mode
	//var journalMode []map[string]interface{}
	//resp := database.Raw("PRAGMA journal_mode;").Scan(&journalMode)
	//if resp.Error != nil {
	//	return nil, fmt.Errorf("Failed to verify journal mode! - %v", resp.Error)
	//} else {
	//	globalLogger.Infof("Journal mode: %v", journalMode)
	//}

	fastenRepo := GormRepository{
		AppConfig:  appConfig,
		Logger:     globalLogger,
		GormClient: database,
		EventBus:   eventBus,
	}

	if !validationMode {
		err = fastenRepo.Migrate()
		if err != nil {
			return nil, err
		}

		//fail any Locked jobs. This is necessary because the job may have been locked by a process that was killed.
		err = fastenRepo.CancelAllLockedBackgroundJobsAndFail()
		if err != nil {
			return nil, err
		}
	}

	return &fastenRepo, nil
}

func sqlitePragmaString(pragmas map[string]string) string {
	q := url.Values{}
	for key, val := range pragmas {
		//q.Add("_pragma", fmt.Sprintf("%s=%s", key, val))
		q.Add(key, val)
	}

	queryStr := q.Encode()
	if len(queryStr) > 0 {
		return "?" + queryStr
	}
	return ""
}
