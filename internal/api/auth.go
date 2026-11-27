package api

import (
	"net/http"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/security"
)

func (s *Server) registerAuth() {
	g := s.mux.Group("/api/v1/auth")
	g.Public().Post("/login", s.handleLogin)
	g.Public().Post("/login/totp", s.handleLoginTOTP)
	g.Post("/logout", s.handleLogout)
	g.Get("/session", s.handleSession)
	g.Post("/password", s.handleChangePassword)

	g.Post("/totp/setup", s.handleTOTPSetup)
	g.Post("/totp/confirm", s.handleTOTPConfirm)
	g.Post("/totp/disable", s.handleTOTPDisable)
	g.Post("/totp/recovery", s.handleTOTPNewRecoveryCodes)

	g.Get("/sessions", s.handleListSessions)
	g.Delete("/sessions/{id}", s.handleDeleteSession)
}

type loginRequest struct {
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !jsonBody(w, r, &req) {
		return
	}
	ip := s.clientIP(r).String()
	if ok, wait := s.loginLimiter.Allow(ip); !ok {
		s.log.Warn("登录被限流拒绝", "ip", ip, "retryAfter", wait.Round(time.Second).String())
		rest.FailCode(w, http.StatusTooManyRequests, "locked",
			"失败次数过多，请在 %s 后重试", wait.Round(time.Second))
		return
	}

	user := s.opts.Cfg.Admin()
	if user == nil {
		rest.FailCode(w, http.StatusUnauthorized, "invalid_credentials", "密码错误")
		return
	}

	// Hashing is memory hard (64 MiB with the administrator parameters) and a
	// burst of parallel requests used to run every verification at once. Wait
	// for the single global slot, then check the limiter again: requests that
	// queued behind a burst may have been locked out in the meantime, and they
	// must not burn a hash before saying so.
	release, err := security.AcquirePasswordSlot(r.Context())
	if err != nil {
		// Either the client went away while queueing or the server is shutting
		// down; answer 503 instead of the empty 200 a bare return would send.
		rest.Fail(w, http.StatusServiceUnavailable, "服务繁忙或正在关闭，请稍后重试")
		return
	}
	if ok, wait := s.loginLimiter.Allow(ip); !ok {
		release()
		s.log.Warn("登录被限流拒绝", "ip", ip, "retryAfter", wait.Round(time.Second).String())
		rest.FailCode(w, http.StatusTooManyRequests, "locked",
			"失败次数过多，请在 %s 后重试", wait.Round(time.Second))
		return
	}
	valid := security.VerifyPasswordHeld(user.PasswordHash, req.Password)
	release()

	if !valid {
		lock := s.loginLimiter.Fail(ip)
		args := []any{"ip", ip}
		if lock > 0 {
			args = append(args, "lockedFor", lock.Round(time.Second).String())
		}
		s.log.Warn("登录失败", args...)
		if lock > 0 {
			rest.FailCode(w, http.StatusTooManyRequests, "locked",
				"失败次数过多，账号已锁定 %s", lock.Round(time.Second))
			return
		}
		rest.FailCode(w, http.StatusUnauthorized, "invalid_credentials", "密码错误")
		return
	}
	s.loginLimiter.Reset(ip)

	// The password is correct, but a second factor is required: hand out a
	// short lived challenge instead of a session. No cookie is set here.
	if user.TOTP.Enabled {
		challenge, err := s.totpChallenges.Issue(user.ID, ip, r.UserAgent())
		if err != nil {
			rest.Fail(w, http.StatusInternalServerError, "无法开始二次验证：%s", err)
			return
		}
		rest.OK(w, map[string]any{
			"totpRequired": true,
			"challenge":    challenge.Token,
			"expiresAt":    challenge.ExpiresAt,
		})
		return
	}

	s.startSession(w, r, user, ip)
}

// startSession creates the session, sets the cookie and writes the login
// response. The single factor login and the second factor login both end here.
func (s *Server) startSession(w http.ResponseWriter, r *http.Request, user *model.User, ip string) {
	cfg := s.opts.Cfg.Snapshot()
	ttl := time.Duration(cfg.System.SessionTTLHours) * time.Hour
	sess, token, err := s.opts.Sessions.Create(user.ID, ip, r.UserAgent(), ttl)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法创建会话：%s", err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secureCookie(r),
		SameSite: http.SameSiteStrictMode,
		Expires:  sess.ExpiresAt,
		MaxAge:   int(ttl.Seconds()),
	})
	_ = s.opts.Cfg.Update(func(c *model.Config) error {
		now := time.Now()
		for i := range c.Users {
			if c.Users[i].ID == user.ID {
				c.Users[i].LastLogin = &now
			}
		}
		return nil
	})
	s.log.Info("登录成功", "ip", ip)
	rest.OK(w, map[string]any{
		"csrf":               sess.CSRF,
		"mustChangePassword": user.MustChangePassword,
		"expiresAt":          sess.ExpiresAt,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(SessionCookie); err == nil {
		s.opts.Sessions.Delete(c.Value)
	}
	// The deletion cookie must carry the same flags as the one it replaces:
	// a browser refuses to let a plaintext response overwrite a Secure cookie,
	// so a logout through the TLS proxy would otherwise leave the session
	// cookie behind.
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secureCookie(r),
		MaxAge:   -1,
		SameSite: http.SameSiteStrictMode,
	})
	rest.NoContent(w)
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	id, _ := IdentityFrom(r.Context())
	if id == nil {
		rest.FailCode(w, http.StatusUnauthorized, "unauthorized", "尚未登录")
		return
	}
	cfg := s.opts.Cfg.Snapshot()
	mustChange := false
	totpEnabled := false
	recoveryLeft := 0
	for _, u := range cfg.Users {
		if u.ID == id.UserID {
			mustChange = u.MustChangePassword
			totpEnabled = u.TOTP.Enabled
			recoveryLeft = len(u.TOTP.Codes)
			break
		}
	}
	rest.OK(w, map[string]any{
		"kind":               id.Kind,
		"csrf":               id.CSRF,
		"mustChangePassword": mustChange,
		"totpEnabled":        totpEnabled,
		"recoveryCodesLeft":  recoveryLeft,
		"admin":              isAdmin(r),
	})
}

type passwordRequest struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var req passwordRequest
	if !jsonBody(w, r, &req) {
		return
	}
	id, _ := IdentityFrom(r.Context())
	if id == nil || id.Kind != IdentitySession {
		rest.FailCode(w, http.StatusForbidden, "forbidden", "只能通过浏览器登录后修改密码")
		return
	}
	if len(req.New) < 8 {
		rest.Fail(w, http.StatusBadRequest, "新密码长度至少 8 位")
		return
	}
	currentHash := ""
	if admin := s.opts.Cfg.Admin(); admin != nil && admin.ID == id.UserID {
		currentHash = admin.PasswordHash
	}
	// The current password is a credential check just like the login form, so
	// it shares the same limiter. Without this gate a stolen session could
	// brute-force the password and take the account over permanently.
	limitKey := "pw:" + s.clientIP(r).String()
	if ok, wait := s.loginLimiter.Allow(limitKey); !ok {
		rest.FailCode(w, http.StatusTooManyRequests, "locked",
			"尝试次数过多，请在 %s 后重试", wait.Round(time.Second))
		return
	}
	if !security.VerifyPassword(currentHash, req.Current) {
		s.loginLimiter.Fail(limitKey)
		rest.FailCode(w, http.StatusUnauthorized, "invalid_credentials", "当前密码不正确")
		return
	}
	s.loginLimiter.Reset(limitKey)
	hash, err := security.HashPassword(req.New)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法生成密码哈希：%s", err)
		return
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		for i := range c.Users {
			if c.Users[i].ID == id.UserID {
				c.Users[i].PasswordHash = hash
				c.Users[i].MustChangePassword = false
			}
		}
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法保存新密码：%s", err)
		return
	}
	// Invalidate the other sessions of this account; the one that changed the
	// password stays usable, otherwise the console would bounce straight back
	// to the sign in screen (and the forced first change would loop).
	s.revokeOtherSessions(id.Session)
	s.audit(r, "password.change")
	rest.NoContent(w)
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	type view struct {
		// ID is the hashed session id; the delete endpoint needs it and it
		// cannot be turned back into the cookie token.
		ID        string    `json:"id"`
		IP        string    `json:"ip"`
		UserAgent string    `json:"userAgent"`
		CreatedAt time.Time `json:"createdAt"`
		ExpiresAt time.Time `json:"expiresAt"`
		Current   bool      `json:"current"`
	}
	current, _ := IdentityFrom(r.Context())
	out := []view{}
	for _, sess := range s.opts.Sessions.List() {
		v := view{sess.ID, sess.IP, sess.UserAgent, sess.CreatedAt, sess.ExpiresAt, false}
		if current != nil && current.Session != nil && current.Session.ID == sess.ID {
			v.Current = true
		}
		out = append(out, v)
	}
	rest.OK(w, out)
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	s.opts.Sessions.DeleteByID(idParam(r, "id"))
	s.audit(r, "session.delete")
	rest.NoContent(w)
}
