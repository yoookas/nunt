package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/security"
)

func (s *Server) registerAuth() {
	g := s.mux.Group("/api/v1/auth")
	g.Public().Get("/mode", s.handleLoginMode)
	g.Public().Post("/login", s.handleLogin)
	g.Public().Post("/login/totp", s.handleLoginTOTP)
	g.Post("/logout", s.handleLogout)
	g.Get("/session", s.handleSession)
	g.Post("/password", s.handleChangePassword)

	g.Post("/totp/setup", s.handleTOTPSetup)
	g.Post("/totp/confirm", s.handleTOTPConfirm)
	g.Post("/totp/disable", s.handleTOTPDisable)
	g.Post("/totp/recovery", s.handleTOTPNewRecoveryCodes)

	g.Get("/users", s.handleListUsers)
	g.Post("/users", s.handleCreateUser)
	g.Put("/users/{id}", s.handleUpdateUser)
	g.Delete("/users/{id}", s.handleDeleteUser)

	g.Get("/sessions", s.handleListSessions)
	g.Delete("/sessions/{id}", s.handleDeleteSession)
}

// handleLoginMode tells the sign in page whether a username is needed. It is
// public and returns a single boolean, never the account name.
func (s *Server) handleLoginMode(w http.ResponseWriter, r *http.Request) {
	_, single := s.opts.Cfg.SingleEnabledUser()
	rest.OK(w, map[string]any{"singleUser": single})
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !jsonBody(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		// With exactly one enabled account there is nothing to choose, so the
		// sign in form only asks for the password.
		if user, ok := s.opts.Cfg.SingleEnabledUser(); ok {
			req.Username = user.Username
		} else {
			rest.FailCode(w, http.StatusBadRequest, "username_required", "请填写用户名")
			return
		}
	}
	ip := s.clientIP(r).String()
	limitKey := strings.ToLower(req.Username) + "|" + ip
	if ok, wait := s.loginLimiter.Allow(limitKey); !ok {
		s.log.Warn("登录被限流拒绝",
			"user", req.Username, "ip", ip, "retryAfter", wait.Round(time.Second).String())
		rest.FailCode(w, http.StatusTooManyRequests, "locked",
			"失败次数过多，请在 %s 后重试", wait.Round(time.Second))
		return
	}

	user, found := s.opts.Cfg.FindUser(req.Username)
	if !found || !user.Enabled || !security.VerifyPassword(user.PasswordHash, req.Password) {
		lock := s.loginLimiter.Fail(limitKey)
		reason := "密码错误"
		switch {
		case !found:
			reason = "用户不存在"
		case !user.Enabled:
			reason = "用户已停用"
		}
		args := []any{"user", req.Username, "ip", ip, "reason", reason}
		if lock > 0 {
			args = append(args, "lockedFor", lock.Round(time.Second).String())
		}
		s.log.Warn("登录失败", args...)
		if lock > 0 {
			rest.FailCode(w, http.StatusTooManyRequests, "locked",
				"失败次数过多，账号已锁定 %s", lock.Round(time.Second))
			return
		}
		rest.FailCode(w, http.StatusUnauthorized, "invalid_credentials", "用户名或密码错误")
		return
	}
	s.loginLimiter.Reset(limitKey)

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
	sess, token, err := s.opts.Sessions.Create(user.ID, user.Username, ip, r.UserAgent(), ttl)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法创建会话：%s", err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
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
	s.log.Info("登录成功", "user", user.Username, "ip", ip)
	rest.OK(w, map[string]any{
		"username":           user.Username,
		"csrf":               sess.CSRF,
		"mustChangePassword": user.MustChangePassword,
		"expiresAt":          sess.ExpiresAt,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(SessionCookie); err == nil {
		s.opts.Sessions.Delete(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
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
	username := id.Username
	for _, u := range cfg.Users {
		if u.ID == id.UserID {
			mustChange = u.MustChangePassword
			username = u.Username
			totpEnabled = u.TOTP.Enabled
			recoveryLeft = len(u.TOTP.Codes)
			break
		}
	}
	rest.OK(w, map[string]any{
		"kind":               id.Kind,
		"username":           username,
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
	var currentHash string
	cfg := s.opts.Cfg.Snapshot()
	for _, u := range cfg.Users {
		if u.ID == id.UserID {
			currentHash = u.PasswordHash
		}
	}
	if !security.VerifyPassword(currentHash, req.Current) {
		s.loginLimiter.Fail("pw:" + id.Username)
		rest.FailCode(w, http.StatusUnauthorized, "invalid_credentials", "当前密码不正确")
		return
	}
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
	// Invalidate other sessions of this user.
	s.opts.Sessions.DeleteUser(id.UserID)
	s.audit(r, "password.change")
	rest.NoContent(w)
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	cfg := s.opts.Cfg.Snapshot()
	type userView struct {
		ID                 string     `json:"id"`
		Username           string     `json:"username"`
		Role               string     `json:"role"`
		Enabled            bool       `json:"enabled"`
		MustChangePassword bool       `json:"mustChangePassword"`
		CreatedAt          time.Time  `json:"createdAt"`
		LastLogin          *time.Time `json:"lastLogin,omitempty"`
	}
	out := make([]userView, 0, len(cfg.Users))
	for _, u := range cfg.Users {
		out = append(out, userView{u.ID, u.Username, u.Role, u.Enabled, u.MustChangePassword, u.CreatedAt, u.LastLogin})
	}
	rest.OK(w, out)
}

type userRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Enabled  *bool  `json:"enabled"`
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req userRequest
	if !jsonBody(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || len(req.Password) < 8 {
		rest.Fail(w, http.StatusBadRequest, "请填写用户名，密码长度至少 8 位")
		return
	}
	hash, err := security.HashPassword(req.Password)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法生成密码哈希：%s", err)
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	user := model.User{
		ID:           model.NewID(),
		Username:     req.Username,
		PasswordHash: hash,
		Role:         "admin",
		Enabled:      enabled,
		CreatedAt:    time.Now(),
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		for _, u := range c.Users {
			if strings.EqualFold(u.Username, req.Username) {
				return errAlreadyExists
			}
		}
		c.Users = append(c.Users, user)
		return nil
	}); err != nil {
		if err == errAlreadyExists {
			rest.Fail(w, http.StatusConflict, "已存在同名用户")
			return
		}
		rest.Fail(w, http.StatusInternalServerError, "无法保存用户：%s", err)
		return
	}
	s.audit(r, "user.create", "target", req.Username)
	rest.OK(w, map[string]any{"id": user.ID})
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := idParam(r, "id")
	var req userRequest
	if !jsonBody(w, r, &req) {
		return
	}
	var newHash string
	if req.Password != "" {
		if len(req.Password) < 8 {
			rest.Fail(w, http.StatusBadRequest, "密码长度至少 8 位")
			return
		}
		h, err := security.HashPassword(req.Password)
		if err != nil {
			rest.Fail(w, http.StatusInternalServerError, "无法生成密码哈希：%s", err)
			return
		}
		newHash = h
	}
	err := s.opts.Cfg.Update(func(c *model.Config) error {
		found := false
		for i := range c.Users {
			if c.Users[i].ID != id {
				continue
			}
			found = true
			if req.Username != "" {
				c.Users[i].Username = strings.TrimSpace(req.Username)
			}
			if req.Enabled != nil {
				c.Users[i].Enabled = *req.Enabled
			}
			if newHash != "" {
				c.Users[i].PasswordHash = newHash
				c.Users[i].MustChangePassword = false
			}
		}
		if !found {
			return errNotFound
		}
		return nil
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "用户不存在")
		return
	}
	if newHash != "" {
		s.opts.Sessions.DeleteUser(id)
	}
	s.audit(r, "user.update", "id", id)
	rest.NoContent(w)
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := idParam(r, "id")
	current, _ := IdentityFrom(r.Context())
	if current != nil && current.UserID == id {
		rest.Fail(w, http.StatusBadRequest, "不能删除当前登录的账号")
		return
	}
	err := s.opts.Cfg.Update(func(c *model.Config) error {
		out := c.Users[:0]
		removed := false
		for _, u := range c.Users {
			if u.ID == id {
				removed = true
				continue
			}
			out = append(out, u)
		}
		c.Users = out
		if !removed {
			return errNotFound
		}
		if len(c.Users) == 0 {
			return errLastUser
		}
		return nil
	})
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	s.opts.Sessions.DeleteUser(id)
	s.audit(r, "user.delete", "id", id)
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
		Username  string    `json:"username"`
		IP        string    `json:"ip"`
		UserAgent string    `json:"userAgent"`
		CreatedAt time.Time `json:"createdAt"`
		ExpiresAt time.Time `json:"expiresAt"`
		Current   bool      `json:"current"`
	}
	current, _ := IdentityFrom(r.Context())
	out := []view{}
	for _, sess := range s.opts.Sessions.List() {
		v := view{sess.ID, sess.Username, sess.IP, sess.UserAgent, sess.CreatedAt, sess.ExpiresAt, false}
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
