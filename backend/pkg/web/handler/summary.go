package handler

import (
	_ "embed"
	"errors"
	"fmt"
	"net/http"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/utils/ips"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/utils/ips_pdf"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

func GetSummary(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	summary, err := databaseRepo.GetSummary(c)
	if err != nil {
		logger.Errorln("An error occurred while retrieving summary", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": summary})
}

func GetIPSSummary(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	ipsData, err := databaseRepo.GetInternationalPatientSummaryExport(c)
	if err != nil {
		// No Patient resource for this user (e.g. nothing imported yet) is a "no data"
		// condition, not a server fault — return 404, not 500 (#148).
		if errors.Is(err, database.ErrIPSNoPatientData) {
			logger.Warnln("IPS summary requested but no patient data available")
			c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "no patient data available to summarize"})
			return
		}
		logger.Errorln("An error occurred while retrieving IPS summary", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false})
		return
	}

	format := c.Query("format")
	if format == "" {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": ipsData.Bundle})
		return
	}

	// format=json downloads the FHIR bundle as a FILE. Without a format the same bytes are returned
	// as an ordinary API response, which is right for a caller reading the API and wrong for a
	// patient pressing Save: they want something that lands in Downloads and can be handed to a
	// clinic (#523). application/fhir+json rather than application/json, because the registered type
	// is what tells receiving software what it is looking at.
	if format == "json" {
		c.Header("Content-Disposition", "attachment; filename=yourphr-records.json")
		c.JSON(http.StatusOK, ipsData.Bundle)
		return
	}

	var renderer ips.IPSRenderer
	switch format {
	case "html":
		renderer, err = ips.NewHTMLRenderer()
		if err != nil {
			logger.Errorln("An error occurred while creating HTML renderer", err)
			c.JSON(http.StatusInternalServerError, gin.H{"success": false})
			return
		}
	case "pdf":
		renderer = ips_pdf.NewPDFRenderer()
	default:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "unsupported format — expected pdf, html or json"})
		return
	}

	logger.Debugf("Rendering IPS summary to %s", format)
	content, err := renderer.Render(ipsData)
	if err != nil {
		logger.Errorln("An error occurred while rendering IPS summary", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false})
		return
	}

	c.Header("Content-Type", renderer.ContentType())
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=ips_summary.%s", renderer.FileExtension()))
	c.Data(http.StatusOK, renderer.ContentType(), content)
}
