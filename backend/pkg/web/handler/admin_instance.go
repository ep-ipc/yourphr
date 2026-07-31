package handler

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/gin-gonic/gin"
)

// Admin Instance card — operator contact for this deployment (name, email, help URL).
// Admin-only to read/write; values are meant to be shown to users of this instance
// (footer / About / connect help) without hardcoding them in the product.

// GetInstanceSettings returns the effective operator contact for this instance. Admin-only.
func GetInstanceSettings(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "admin role required"})
		return
	}
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": database.LoadOperatorSettings(appConfig)})
}

// SetInstanceSettingsRequest is the PUT body for operator contact fields.
type SetInstanceSettingsRequest struct {
	Name         string `json:"name"`
	ContactEmail string `json:"contact_email"`
	ContactURL   string `json:"contact_url"`
}

// SetInstanceSettings persists operator contact. Admin-only. Applies without restart.
func SetInstanceSettings(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "admin role required"})
		return
	}
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	var req SetInstanceSettingsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "invalid request"})
		return
	}
	s := database.OperatorSettings{
		Name:         strings.TrimSpace(req.Name),
		ContactEmail: strings.TrimSpace(req.ContactEmail),
		ContactURL:   strings.TrimSpace(req.ContactURL),
	}
	if err := database.ValidateOperatorSettings(s); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if err := database.SaveOperatorSettings(appConfig, s); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": fmt.Sprintf("save failed: %s", err)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": s})
}
