package handler

import (
	"net/http"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// GetLegalConsent returns whether the current user has accepted PP/ToS and when (#427).
func GetLegalConsent(c *gin.Context) {
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	at, err := databaseRepo.GetLegalConsentAcceptedAt(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	at = strings.TrimSpace(at)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": models.LegalConsentStatus{
			Accepted:          at != "",
			AcceptedAt:        at,
			PrivacyPolicyURL:  models.LegalPrivacyPolicyURL,
			TermsOfServiceURL: models.LegalTermsOfServiceURL,
		},
	})
}

// GrantLegalConsent records active opt-in (timestamp now UTC). Idempotent if already accepted.
func GrantLegalConsent(c *gin.Context) {
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	now := time.Now().UTC().Format(time.RFC3339)
	if err := databaseRepo.SetLegalConsentAcceptedAt(c, now); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": models.LegalConsentStatus{
			Accepted:          true,
			AcceptedAt:        now,
			PrivacyPolicyURL:  models.LegalPrivacyPolicyURL,
			TermsOfServiceURL: models.LegalTermsOfServiceURL,
		},
	})
}

// RevokeLegalConsent clears PP/ToS acceptance and disconnects Medicare-class sources for this user
// (tokens removed; imported records stay until the user deletes them — matches Privacy Policy).
func RevokeLegalConsent(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	if err := databaseRepo.SetLegalConsentAcceptedAt(c, ""); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	disconnected := 0
	sources, err := databaseRepo.GetSources(c)
	if err != nil {
		logger.Warnf("legal consent revoke: could not list sources: %v", err)
	} else {
		for _, src := range sources {
			if !models.ProviderRequiresLegalConsent(src.Display, src.ApiEndpointBaseUrl, string(src.PlatformType)) {
				continue
			}
			if _, delErr := databaseRepo.DeleteSource(c, src.ID.String()); delErr != nil {
				logger.Warnf("legal consent revoke: disconnect source %s: %v", src.ID, delErr)
				continue
			}
			disconnected++
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"accepted":               false,
			"accepted_at":            "",
			"privacy_policy_url":     models.LegalPrivacyPolicyURL,
			"terms_of_service_url":   models.LegalTermsOfServiceURL,
			"medicare_sources_disconnected": disconnected,
		},
	})
}

// requireLegalConsentForCatalogEntry aborts with 403 if the entry needs consent and the user has not accepted.
// Returns true if the handler should stop.
func requireLegalConsentForCatalogEntry(c *gin.Context, databaseRepo database.DatabaseRepository, entry *models.ProviderCatalogEntry) bool {
	if entry == nil || !models.ProviderRequiresLegalConsent(entry.Display, entry.ApiEndpointBaseUrl, string(entry.PlatformType)) {
		return false
	}
	at, err := databaseRepo.GetLegalConsentAcceptedAt(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return true
	}
	if strings.TrimSpace(at) != "" {
		return false
	}
	c.JSON(http.StatusForbidden, gin.H{
		"success":    false,
		"error":      "Accept the Privacy Policy and Terms of Service before connecting Medicare. Open Account Profile to grant consent.",
		"error_code": "legal_consent_required",
		"privacy_policy_url":  models.LegalPrivacyPolicyURL,
		"terms_of_service_url": models.LegalTermsOfServiceURL,
	})
	return true
}
