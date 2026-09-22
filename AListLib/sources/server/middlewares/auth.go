package middlewares

import (
	"crypto/subtle"
	"net"

	"github.com/OpenListTeam/OpenList/v4/internal/conf"
	"github.com/OpenListTeam/OpenList/v4/internal/model"
	"github.com/OpenListTeam/OpenList/v4/internal/op"
	"github.com/OpenListTeam/OpenList/v4/internal/setting"
	"github.com/OpenListTeam/OpenList/v4/server/common"
	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

// isLoopbackRequest 判断请求是否直接来自本机。
// App 内置的 WebView 通过 http://127.0.0.1:<port> 访问，属于本机请求。
// 这里读的是 RemoteAddr（TCP 对端地址），不使用 ClientIP()，
// 否则 X-Forwarded-For 之类的头可以被伪造。
func isLoopbackRequest(c *gin.Context) bool {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		host = c.Request.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Auth is a middleware that checks if the user is logged in.
// if token is empty, set user to guest
func Auth(allowDisabledGuest bool) func(c *gin.Context) {
	return func(c *gin.Context) {
		token := c.GetHeader("Authorization")
		if subtle.ConstantTimeCompare([]byte(token), []byte(setting.GetStr(conf.Token))) == 1 {
			admin, err := op.GetAdmin()
			if err != nil {
				common.ErrorResp(c, err, 500)
				c.Abort()
				return
			}
			common.GinAppendValues(c, conf.UserKey, admin)
			log.Debugf("use admin token: %+v", admin)
			c.Next()
			return
		}
		if token == "" {
			// 本机免密：App 内的页面直接以管理员身份使用，不需要登录。
			// 手机浏览器或局域网等其他来源仍然只当作访客，不会因此拿到管理权限。
			if isLoopbackRequest(c) {
				if admin, err := op.GetAdmin(); err == nil {
					common.GinAppendValues(c, conf.UserKey, admin)
					log.Debugf("loopback request, use admin: %+v", admin)
					c.Next()
					return
				}
			}
			guest, err := op.GetGuest()
			if err != nil {
				common.ErrorResp(c, err, 500)
				c.Abort()
				return
			}
			if !allowDisabledGuest && guest.Disabled {
				common.ErrorStrResp(c, "Guest user is disabled, login please", 401)
				c.Abort()
				return
			}
			common.GinAppendValues(c, conf.UserKey, guest)
			log.Debugf("use empty token: %+v", guest)
			c.Next()
			return
		}
		userClaims, err := common.ParseToken(token)
		if err != nil {
			common.ErrorResp(c, err, 401)
			c.Abort()
			return
		}
		user, err := op.GetUserByName(userClaims.Username)
		if err != nil {
			common.ErrorResp(c, err, 401)
			c.Abort()
			return
		}
		// validate password timestamp
		if userClaims.PwdTS != user.PwdTS {
			common.ErrorStrResp(c, "Password has been changed, login please", 401)
			c.Abort()
			return
		}
		if user.Disabled {
			common.ErrorStrResp(c, "Current user is disabled, replace please", 401)
			c.Abort()
			return
		}
		common.GinAppendValues(c, conf.UserKey, user)
		log.Debugf("use login token: %+v", user)
		c.Next()
	}
}

func Authn(c *gin.Context) {
	token := c.GetHeader("Authorization")
	if subtle.ConstantTimeCompare([]byte(token), []byte(setting.GetStr(conf.Token))) == 1 {
		admin, err := op.GetAdmin()
		if err != nil {
			common.ErrorResp(c, err, 500)
			c.Abort()
			return
		}
		common.GinAppendValues(c, conf.UserKey, admin)
		log.Debugf("use admin token: %+v", admin)
		c.Next()
		return
	}
	if token == "" {
		guest, err := op.GetGuest()
		if err != nil {
			common.ErrorResp(c, err, 500)
			c.Abort()
			return
		}
		common.GinAppendValues(c, conf.UserKey, guest)
		log.Debugf("use empty token: %+v", guest)
		c.Next()
		return
	}
	userClaims, err := common.ParseToken(token)
	if err != nil {
		common.ErrorResp(c, err, 401)
		c.Abort()
		return
	}
	user, err := op.GetUserByName(userClaims.Username)
	if err != nil {
		common.ErrorResp(c, err, 401)
		c.Abort()
		return
	}
	// validate password timestamp
	if userClaims.PwdTS != user.PwdTS {
		common.ErrorStrResp(c, "Password has been changed, login please", 401)
		c.Abort()
		return
	}
	if user.Disabled {
		common.ErrorStrResp(c, "Current user is disabled, replace please", 401)
		c.Abort()
		return
	}
	common.GinAppendValues(c, conf.UserKey, user)
	log.Debugf("use login token: %+v", user)
	c.Next()
}

func AuthNotGuest(c *gin.Context) {
	user := c.Request.Context().Value(conf.UserKey).(*model.User)
	if user.IsGuest() {
		common.ErrorStrResp(c, "You are a guest", 403)
		c.Abort()
	} else {
		c.Next()
	}
}

func AuthAdmin(c *gin.Context) {
	user := c.Request.Context().Value(conf.UserKey).(*model.User)
	if !user.IsAdmin() {
		common.ErrorStrResp(c, "You are not an admin", 403)
		c.Abort()
	} else {
		c.Next()
	}
}
