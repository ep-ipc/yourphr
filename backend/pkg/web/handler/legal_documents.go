package handler

import (
	"net/http"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/legal"
	"github.com/gin-gonic/gin"
)

// GetLegalDocument serves this instance's Privacy Policy or Terms of Service (#463).
//
// Unauthenticated, because someone deciding whether to sign up needs to read the terms first,
// and because the sign-in page links to them.
//
// Served BY THE INSTANCE rather than linking to yourphr.org: an offline home server must still
// be able to show its own policy, and the operator — who is the data controller — may have
// replaced it with their own. The response says which it is.
//
// The Markdown source is omitted here; the rendered HTML is what a reader needs, and the digest
// is what a consent record needs.
func GetLegalDocument(c *gin.Context) {
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	kind, err := legal.ParseKind(c.Param("kind"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": err.Error()})
		return
	}

	document, err := legal.Load(appConfig, kind)
	if err != nil {
		// A broken operator override is an error, not a reason to quietly serve the shipped
		// text — that would show users a document their operator deliberately replaced.
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	document.Markdown = ""

	c.JSON(http.StatusOK, gin.H{"success": true, "data": document})
}
