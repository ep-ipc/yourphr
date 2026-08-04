package handler

import (
	"errors"
	"net/http"
	"os"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/event_bus"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/utils" // Import the utils package
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// EncryptionKeyPayload defines the structure for the encryption key JSON payload
type EncryptionKeyPayload struct {
	EncryptionKey string `json:"encryption_key"`
}

// EncryptionKeyHandler holds dependencies for encryption key-related operations
type AppEngineInterface interface {
	Reinitialize() error
}

// EncryptionKeyHandler holds dependencies for encryption key-related operations
type EncryptionKeyHandler struct {
	AppConfig config.Interface
	Logger    *logrus.Entry
	AppEngine AppEngineInterface
}

// NewEncryptionKeyHandler creates a new EncryptionKeyHandler
func NewEncryptionKeyHandler(appConfig config.Interface, logger *logrus.Entry, appEngine AppEngineInterface) *EncryptionKeyHandler {
	return &EncryptionKeyHandler{
		AppConfig: appConfig,
		Logger:    logger,
		AppEngine: appEngine,
	}
}

// GetEncryptionKey handles the GET /api/encryption-key endpoint
func (h *EncryptionKeyHandler) GetEncryptionKey(c *gin.Context) {
	encryptionKey, err := utils.GenerateRandomKey(32)
	if err != nil {
		h.Logger.Errorf("failed to generate random key: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "internal server error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": encryptionKey})
}

// SetupEncryptionKey handles the POST /api/encryption-key endpoint
func (h *EncryptionKeyHandler) SetEncryptionKey(c *gin.Context) {
	var payload EncryptionKeyPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Enforced here rather than at startup: this is the moment an operator commits to a key, and
	// until yourphr#474 the rule lived in ValidateConfig, which only the removed --config path
	// reached. So the first-run wizard — the way nearly every install actually sets its key — had
	// no length check at all.
	//
	// ONLY for a database that does not exist yet. The UI calls /encryption-key/validate and then
	// this endpoint for both cases, and validate succeeds precisely when the key opens the existing
	// database. Applying a minimum here unconditionally would take a correct legacy key, confirm it
	// against the real database, and then refuse to use it — locking the operator out of their own
	// records to enforce a rule that can no longer change anything.
	if !databaseExists(h.AppConfig.GetString("database.location")) {
		if err := config.ValidateEncryptionKey(payload.EncryptionKey); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
			return
		}
	} else if payload.EncryptionKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "encryption key is required"})
		return
	}

	h.AppConfig.Set("database.encryption.key", payload.EncryptionKey)

	c.JSON(http.StatusOK, gin.H{"success": true})

	// Reinitialize the server after setting the encryption key
	go func() {
		if err := h.AppEngine.Reinitialize(); err != nil {
			h.Logger.Errorf("Failed to reinitialize AppEngine: %v", err)
		}
	}()
}

// ValidateEncryptionKey handles the POST /api/encryption-key/validate endpoint
func (h *EncryptionKeyHandler) ValidateEncryptionKey(c *gin.Context) {
	var payload EncryptionKeyPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// The key was logged here in cleartext, defeating the encryption it unlocks for anyone with
	// read access to the log — which the Admin Dashboard exposes over HTTP.
	h.Logger.Info("Validating a supplied database encryption key")

	if payload.EncryptionKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "encryption key is required"})
		return
	}

	// Create a temporary config for validation
	tempConfig, err := config.Create()
	if err != nil {
		h.Logger.Errorf("failed to create temp config: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "internal server error"})
		return
	}
	tempConfig.Set("database.encryption.key", payload.EncryptionKey)
	tempConfig.Set("database.location", h.AppConfig.GetString("database.location"))
	tempConfig.Set("database.encryption.enabled", true)
	tempConfig.Set("database.validation_mode", true)

	// Attempt to initialize the database with the provided encryption key
	_, err = database.NewRepository(tempConfig, h.Logger, event_bus.NewNoopEventBusServer())
	if err != nil {
		h.Logger.Errorf("failed to validate encryption key: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"success": false})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// databaseExists reports whether the SQLite file is already there.
//
// A missing path means a fresh instance about to create its database, which is the only moment a
// key requirement can be applied without risking a lockout. Errors other than "not found" are
// treated as "exists" — the safe direction, since guessing "fresh" for a database that is merely
// unreadable would apply the rule to an existing instance.
func databaseExists(location string) bool {
	if location == "" {
		return false
	}
	_, err := os.Stat(location)
	return !errors.Is(err, os.ErrNotExist)
}
