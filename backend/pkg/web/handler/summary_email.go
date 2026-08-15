package handler

import (
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	appmail "github.com/fastenhealth/fasten-onprem/backend/pkg/mail"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/web/middleware"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/utils/ips"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/utils/ips_pdf"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// emailSendLimiter caps how often ONE account may send a report.
//
// An authenticated endpoint that mails arbitrary addresses with attachments is a spam vector, and
// the guard belongs here rather than in the transport: the transport does not know whose account is
// asking. Package-level so the window survives across requests, as with the sign-in limiter (#509).
//
// Five an hour is generous for the real use — sending your records to a new doctor — and useless
// for anyone trying to relay mail through somebody's home instance.
var emailSendLimiter = middleware.NewFixedWindowLimiter(5, time.Hour)

type sendSummaryEmailRequest struct {
	To     string `json:"to"`
	Format string `json:"format"`
}

// SendIPSSummaryEmail mails the patient's own record to an address they choose (#524).
//
// The operator's decision, and it corrects an earlier position taken on that issue: the app already
// lets a patient DOWNLOAD this same file unencrypted (#523), so refusing to send it protects
// nothing — it only makes somebody do by hand what they could already do. It is their data. What is
// owed is an honest warning before it happens, which the UI gives, not a locked door beside an open
// window.
func SendIPSSummaryEmail(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	var req sendSummaryEmailRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "could not read the request"})
		return
	}

	recipient := strings.TrimSpace(req.To)
	if _, err := mail.ParseAddress(recipient); err != nil {
		// Checked before anything is rendered: building a whole report to then reject the address
		// wastes the work and delays the message the person needs to see.
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "that does not look like an email address"})
		return
	}

	currentUser, err := databaseRepo.GetCurrentUser(c)
	if err != nil || currentUser == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "not signed in"})
		return
	}

	if allowed, retryAfter := emailSendLimiter.Allow(strings.ToLower(currentUser.Username)); !allowed {
		c.Header("Retry-After", fmt.Sprint(int(retryAfter.Seconds())))
		c.JSON(http.StatusTooManyRequests, gin.H{
			"success": false,
			"error":   "too many reports sent recently — please wait before sending another",
		})
		return
	}

	sender, err := appmail.New(appConfig, logger)
	if err != nil {
		// A misconfigured relay is an operator problem, and the message says so rather than
		// pretending the send failed for the patient's reasons.
		logger.Errorf("could not build the mail sender: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"error":   "email is not configured correctly on this instance — an administrator needs to check the mail settings",
		})
		return
	}
	if !appConfig.GetBool(appmail.KeyEnabled) {
		// Distinct from a failure: nothing is wrong, the feature is simply off. Says which setting.
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"success": false,
			"error":   "email is not enabled on this instance",
		})
		return
	}

	ipsData, err := databaseRepo.GetInternationalPatientSummaryExport(c)
	if err != nil {
		if errors.Is(err, database.ErrIPSNoPatientData) {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "no patient data available to send"})
			return
		}
		logger.Errorln("could not build the summary to email", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not build your report"})
		return
	}

	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format == "" {
		format = "pdf"
	}
	var renderer ips.IPSRenderer
	switch format {
	case "html":
		renderer, err = ips.NewHTMLRenderer()
		if err != nil {
			logger.Errorln("could not create the HTML renderer", err)
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not build your report"})
			return
		}
	case "pdf":
		renderer = ips_pdf.NewPDFRenderer()
	default:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "unsupported format"})
		return
	}

	content, err := renderer.Render(ipsData)
	if err != nil {
		logger.Errorln("could not render the summary to email", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not build your report"})
		return
	}

	err = sender.Send(appmail.Message{
		To:      []string{recipient},
		Subject: "Medical records",
		Body: "Attached is a summary of medical records, sent from YourPHR at the request of the person they belong to.\n\n" +
			"This file is not password protected. Please store it somewhere you would keep paper medical records.\n",
		Attachments: []appmail.Attachment{{
			Filename:    fmt.Sprintf("yourphr-records.%s", renderer.FileExtension()),
			ContentType: renderer.ContentType(),
			Content:     content,
		}},
	})
	if err != nil {
		// The relay's reason reaches the user. A send that fails silently is #527 again: the patient
		// believes their doctor has their records and nothing was delivered.
		logger.Errorf("could not send the summary to %q: %v", recipient, err)
		c.JSON(http.StatusBadGateway, gin.H{
			"success": false,
			"error":   fmt.Sprintf("the report could not be sent: %v", err),
		})
		return
	}

	// Recorded so the patient can be told what left their instance and when. Recipient and time
	// only — never the content. A fuller audit trail is #507.
	logger.Infof("emailed the %s record summary for %q to %q", format, currentUser.Username, recipient)

	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"sent_to": recipient, "format": format}})
}
