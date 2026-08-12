package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/fastenhealth/fasten-onprem/backend/pkg"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/auth"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/database"
	"github.com/fastenhealth/fasten-onprem/backend/pkg/models"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"gorm.io/gorm"
)

func GetUsers(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "Unauthorized"})
		return
	}

	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	users, err := databaseRepo.GetUsers(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"success": true, "data": users})
}

func CreateUser(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "Unauthorized"})
		return
	}

	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)

	var newUser models.User
	if err := c.ShouldBindJSON(&newUser); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Same policy as self-service signup (#506). An admin creating a family member's account is not
	// a reason to accept a weaker password than the instance requires of everyone else.
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)
	policy := auth.PasswordPolicyFromConfig(appConfig)
	if err := policy.ValidateUsername(newUser.Username); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if err := policy.ValidatePassword(newUser.Username, newUser.Password); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	err := databaseRepo.CreateUser(c, &newUser)
	if err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "User already exists"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		}
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": newUser})
}

// AdminResetUserPassword sets a GENERATED password for another account and returns it once (#511).
//
// The everyday case this exists for: a family member forgot theirs. Before this, an admin could list
// users and create them and do nothing else, so a household's only answer was hand-editing the
// database — or, after #510, finding a shell.
//
// GENERATED, NOT ADMIN-TYPED. An admin choosing a password picks one they use elsewhere, and that
// value is now attached to another person's health record. The generated one satisfies the
// instance's own policy (#506), so it cannot be a credential the change-password screen would then
// refuse.
//
// RETURNED ONCE, in the response, and never stored in plaintext or logged. Unlike the CLI (#510)
// there is no file: the admin is looking at the screen, and writing a credential into the data root
// — which is what a backup contains (#466) — to hand it to somebody in the same room would be worse.
//
// NOT A PRIVILEGE ESCALATION, and worth being explicit. Whoever runs this service already has full
// access to every record: the database encryption key is instance-level, so an admin can read any
// user's data straight out of the file. This adds convenience, not capability — which is why it is
// defensible on a family instance and would not be in a hosted product.
func AdminResetUserPassword(c *gin.Context) {
	if !IsAdmin(c) {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "Unauthorized"})
		return
	}

	logger := c.MustGet(pkg.ContextKeyTypeLogger).(*logrus.Entry)
	databaseRepo := c.MustGet(pkg.ContextKeyTypeDatabase).(database.DatabaseRepository)
	appConfig := c.MustGet(pkg.ContextKeyTypeConfig).(config.Interface)

	userID := strings.TrimSpace(c.Param("id"))
	if userID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "a user id is required"})
		return
	}

	targetUser, err := databaseRepo.GetUserByID(c, userID)
	if err != nil || targetUser == nil || targetUser.Username == "" {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "no such user"})
		return
	}

	password, err := auth.GenerateCompliantPassword(appConfig, targetUser.Username)
	if err != nil {
		logger.Errorf("could not generate a password for %q: %v", targetUser.Username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	// PLAINTEXT into HashPassword, which writes the hash back onto the model; UpdateUserPassword then
	// takes that ALREADY-HASHED value. The two take opposite things, which is how #504 shipped broken.
	hashed := &models.User{}
	if err := hashed.HashPassword(password); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not set the password"})
		return
	}

	// UpdateUserPassword resolves the account from the context, the same way a request does — so name
	// the TARGET rather than letting it find the admin who is signed in.
	targetCtx := context.WithValue(c.Request.Context(), pkg.ContextKeyTypeAuthUsername, targetUser.Username)
	if err := databaseRepo.UpdateUserPassword(targetCtx, hashed.Password); err != nil {
		logger.Errorf("could not reset the password for %q: %v", targetUser.Username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "could not set the password"})
		return
	}

	// End that user's existing sessions (#508). A reset is often a response to a compromised account,
	// and leaving the intruder signed in would defeat it. Not fatal: the password IS changed by now.
	if err := databaseRepo.BumpUserTokenGeneration(c, targetUser.Username); err != nil {
		logger.Warnf("password for %q was reset, but existing sessions could not be revoked: %v", targetUser.Username, err)
	}

	// The username, never the value.
	logger.Infof("an admin reset the password for %q", targetUser.Username)

	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"username": targetUser.Username,
		"password": password,
	}})
}
