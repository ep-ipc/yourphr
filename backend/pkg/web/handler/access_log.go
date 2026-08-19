package handler

import (
	"net/http"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// GetAccessLog returns the current user's complete access log (#563): who accessed which category of
// their records on which day, aggregated with counts and first/last times. Unfiltered and unedited —
// this is the page that makes "users can obtain a complete record of who has accessed their data" a
// true statement.
func GetAccessLog(c *gin.Context) {
	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	events, err := databaseRepo.ListAccessEvents(c)
	if err != nil {
		logger.Errorf("Failed to list access events: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "Failed to load the access log"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": events})
}
