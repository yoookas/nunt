package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/security"
)

const (
	// totpPendingTTL is how long a half finished enrollment stays valid.
	totpPendingTTL = 5 * time.Minute
	// totpChallengeTTL is how long the password step of a login stays valid.
	totpChallengeTTL = 5 * time.Minute
	// totpMaxAttempts bounds the codes one challenge may burn.
	totpMaxAttempts = 5
	// recoveryCodeCount is how many one time codes are generated at a time.
	recoveryCodeCount = 10
)

// recoveryAlphabet removes the characters people confuse when typing a code
// from paper: 0/O and 1/I.
const recoveryAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

// pendingTOTP is a generated but not yet confirmed secret. It only lives in
// memory: refreshing the page or restarting the process throws it away, which
// is exactly what an unfinished enrollment should do.
type pendingTOTP struct {
	secret   string
	expires  time.Time
	attempts int
}

type totpPendingStore struct {
	mu    sync.Mutex
	items map[string]*pendingTOTP
	now   func() time.Time
}

func newTOTPPendingStore() *totpPendingStore {
	return &totpPendingStore{items: map[string]*pendingTOTP{}, now: time.Now}
}

func (s *totpPendingStore) put(userID, secret string) time.Time {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, p := range s.items {
		if !now.Before(p.expires) {
			delete(s.items, id)
		}
	}
	expires := now.Add(totpPendingTTL)
	s.items[userID] = &pendingTOTP{secret: secret, expires: expires}
	return expires
}

func (s *totpPendingStore) get(userID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[userID]
	if !ok || !s.now().Before(p.expires) {
		delete(s.items, userID)
		return "", false
	}
	return p.secret, true
}

// fail counts one wrong confirmation code and drops the pending secret once
// the attempts are exhausted.
func (s *totpPendingStore) fail(userID string, max int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[userID]
	if !ok {
		return 0
	}
	p.attempts++
	left := max - p.attempts
	if left <= 0 {
		delete(s.items, userID)
		return 0
	}
	return left
}

func (s *totpPendingStore) delete(userID string) {
	s.mu.Lock()
	delete(s.items, userID)
	s.mu.Unlock()
}

// ---------------------------------------------------------------------------
// enrollment
// ---------------------------------------------------------------------------

func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.SessionFrom(r)
	if !ok {
		rest.FailCode(w, http.StatusForbidden, "session_required", "双因子只能在浏览器会话里配置")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if !jsonBody(w, r, &req) {
		return
	}
	user, ok := s.userByID(sess.UserID)
	if !ok {
		rest.FailCode(w, http.StatusUnauthorized, "unauthorized", "账号不存在")
		return
	}
	if user.TOTP.Enabled {
		rest.Fail(w, http.StatusConflict, "双因子已启用，请先关闭再重新绑定")
		return
	}

	limitKey := "totp-setup|" + user.ID
	if ok, wait := s.loginLimiter.Allow(limitKey); !ok {
		rest.FailCode(w, http.StatusTooManyRequests, "locked", "尝试次数过多，请在 %s 后重试", wait.Round(time.Second))
		return
	}
	if !security.VerifyPassword(user.PasswordHash, req.Password) {
		s.loginLimiter.Fail(limitKey)
		rest.FailCode(w, http.StatusUnauthorized, "invalid_credentials", "密码错误")
		return
	}
	s.loginLimiter.Reset(limitKey)

	secret, err := security.GenerateTOTPSecret()
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法生成密钥：%s", err)
		return
	}
	expires := s.totpPending.put(user.ID, secret)
	rest.OK(w, map[string]any{
		"secret":    secret,
		"uri":       security.TOTPURI("nunt", user.Username, secret),
		"expiresAt": expires,
	})
}

func (s *Server) handleTOTPConfirm(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.SessionFrom(r)
	if !ok {
		rest.FailCode(w, http.StatusForbidden, "session_required", "双因子只能在浏览器会话里配置")
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if !jsonBody(w, r, &req) {
		return
	}
	user, ok := s.userByID(sess.UserID)
	if !ok {
		rest.FailCode(w, http.StatusUnauthorized, "unauthorized", "账号不存在")
		return
	}
	if user.TOTP.Enabled {
		rest.Fail(w, http.StatusConflict, "双因子已启用")
		return
	}
	if s.opts.Box == nil {
		rest.Fail(w, http.StatusInternalServerError, "加密密钥不可用，无法保存双因子密钥")
		return
	}

	secret, ok := s.totpPending.get(user.ID)
	if !ok {
		rest.Fail(w, http.StatusBadRequest, "绑定已过期，请重新开始")
		return
	}
	// The confirming code is not a login: do not advance LastStep, otherwise a
	// user who logs out and back in within the same 30 second window would be
	// told that their brand new code was already used.
	if _, ok := security.TOTPVerify(secret, req.Code, time.Now()); !ok {
		left := s.totpPending.fail(user.ID, totpMaxAttempts)
		if left == 0 {
			rest.FailCode(w, http.StatusBadRequest, "invalid_code", "验证码错误，绑定已失效，请重新开始")
			return
		}
		rest.FailCode(w, http.StatusBadRequest, "invalid_code", "验证码错误，还可以尝试 %d 次", left)
		return
	}

	sealed, err := s.opts.Box.Seal(secret)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法加密密钥：%s", err)
		return
	}
	codes, hashes := newRecoveryCodes()
	now := time.Now()
	if err := s.updateUserTOTP(user.ID, func(u *model.User) {
		u.TOTP = model.TOTP{
			Enabled:    true,
			Secret:     sealed,
			Codes:      hashes,
			EnrolledAt: &now,
		}
	}); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法保存双因子：%s", err)
		return
	}
	s.totpPending.delete(user.ID)
	s.revokeOtherSessions(sess)
	s.log.Info("已开启 TOTP", "user", user.Username, "ip", s.clientIP(r).String())
	rest.OK(w, map[string]any{"enabled": true, "recoveryCodes": codes})
}

func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.SessionFrom(r)
	if !ok {
		rest.FailCode(w, http.StatusForbidden, "session_required", "双因子只能在浏览器会话里配置")
		return
	}
	var req struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if !jsonBody(w, r, &req) {
		return
	}
	user, ok := s.userByID(sess.UserID)
	if !ok || !user.TOTP.Enabled {
		rest.Fail(w, http.StatusConflict, "双因子未启用")
		return
	}
	if !s.verifyPasswordAndFactor(w, r, user, req.Password, req.Code, "totp-disable") {
		return
	}
	if err := s.updateUserTOTP(user.ID, func(u *model.User) { u.TOTP = model.TOTP{} }); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法关闭双因子：%s", err)
		return
	}
	s.revokeOtherSessions(sess)
	s.log.Info("已关闭 TOTP", "user", user.Username, "ip", s.clientIP(r).String())
	rest.OK(w, map[string]any{"enabled": false})
}

func (s *Server) handleTOTPNewRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.SessionFrom(r)
	if !ok {
		rest.FailCode(w, http.StatusForbidden, "session_required", "双因子只能在浏览器会话里配置")
		return
	}
	var req struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if !jsonBody(w, r, &req) {
		return
	}
	user, ok := s.userByID(sess.UserID)
	if !ok || !user.TOTP.Enabled {
		rest.Fail(w, http.StatusConflict, "双因子未启用")
		return
	}
	if !s.verifyPasswordAndFactor(w, r, user, req.Password, req.Code, "totp-recovery") {
		return
	}
	codes, hashes := newRecoveryCodes()
	if err := s.updateUserTOTP(user.ID, func(u *model.User) { u.TOTP.Codes = hashes }); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法保存恢复码：%s", err)
		return
	}
	s.log.Info("已重新生成恢复码", "user", user.Username, "ip", s.clientIP(r).String())
	rest.OK(w, map[string]any{"recoveryCodes": codes})
}

// verifyPasswordAndFactor checks both the password and the second factor and
// writes the matching error response itself. It reports whether the caller may
// continue.
func (s *Server) verifyPasswordAndFactor(w http.ResponseWriter, r *http.Request, user *model.User, password, code, action string) bool {
	ip := s.clientIP(r).String()
	limitKey := action + "|" + user.ID
	if ok, wait := s.loginLimiter.Allow(limitKey); !ok {
		rest.FailCode(w, http.StatusTooManyRequests, "locked", "尝试次数过多，请在 %s 后重试", wait.Round(time.Second))
		return false
	}
	if !security.VerifyPassword(user.PasswordHash, password) {
		s.loginLimiter.Fail(limitKey)
		rest.FailCode(w, http.StatusUnauthorized, "invalid_credentials", "密码错误")
		return false
	}
	res := s.checkFactor(user, code, time.Now(), true)
	if !res.ok {
		s.loginLimiter.Fail(limitKey)
		s.log.Warn("双因子验证拒绝", "user", user.Username, "ip", ip, "action", action)
		rest.FailCode(w, http.StatusUnauthorized, "invalid_code", "验证码错误")
		return false
	}
	s.loginLimiter.Reset(limitKey)
	return true
}

// ---------------------------------------------------------------------------
// second factor login
// ---------------------------------------------------------------------------

func (s *Server) handleLoginTOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Challenge string `json:"challenge"`
		Code      string `json:"code"`
	}
	if !jsonBody(w, r, &req) {
		return
	}
	ip := s.clientIP(r).String()
	ipKey := "totp-ip|" + ip
	if ok, wait := s.loginLimiter.Allow(ipKey); !ok {
		rest.FailCode(w, http.StatusTooManyRequests, "locked", "尝试次数过多，请在 %s 后重试", wait.Round(time.Second))
		return
	}

	token := strings.TrimSpace(req.Challenge)
	ch, ok := s.totpChallenges.Get(token)
	if !ok || ch.IP != ip || ch.UserAgent != r.UserAgent() {
		if ok {
			// The token is valid but belongs to another client: burn it.
			s.totpChallenges.Delete(token)
		}
		s.loginLimiter.Fail(ipKey)
		rest.FailCode(w, http.StatusUnauthorized, "challenge_expired", "验证已过期，请重新登录")
		return
	}

	user, ok := s.userByID(ch.UserID)
	if !ok || !user.Enabled || !user.TOTP.Enabled {
		s.totpChallenges.Delete(token)
		rest.FailCode(w, http.StatusUnauthorized, "challenge_expired", "验证已过期，请重新登录")
		return
	}

	userKey := "totp-user|" + user.ID + "|" + ip
	if ok, wait := s.loginLimiter.Allow(userKey); !ok {
		rest.FailCode(w, http.StatusTooManyRequests, "locked", "尝试次数过多，请在 %s 后重试", wait.Round(time.Second))
		return
	}

	res := s.checkFactor(user, req.Code, time.Now(), false)
	if res.stale {
		s.loginLimiter.Fail(userKey)
		s.totpChallenges.Fail(token, totpMaxAttempts)
		rest.FailCode(w, http.StatusUnauthorized, "invalid_code", "验证码已使用，请输入新的验证码")
		return
	}
	if !res.ok {
		s.loginLimiter.Fail(userKey)
		left := s.totpChallenges.Fail(token, totpMaxAttempts)
		if left == 0 {
			rest.FailCode(w, http.StatusUnauthorized, "challenge_expired", "尝试次数过多，请重新登录")
			return
		}
		rest.FailCode(w, http.StatusUnauthorized, "invalid_code", "验证码错误，还可以尝试 %d 次", left)
		return
	}

	// Consume the code: either advance the step or burn the recovery code.
	if err := s.updateUserTOTP(user.ID, func(u *model.User) {
		if res.recoveryIndex >= 0 {
			u.TOTP.Codes = append(u.TOTP.Codes[:res.recoveryIndex], u.TOTP.Codes[res.recoveryIndex+1:]...)
			return
		}
		u.TOTP.LastStep = res.step
	}); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法记录登录状态：%s", err)
		return
	}
	s.totpChallenges.Delete(token)
	s.loginLimiter.Reset(ipKey)
	s.loginLimiter.Reset(userKey)
	updated, _ := s.userByID(user.ID)
	if updated == nil {
		updated = user
	}
	s.log.Info("双因子验证通过", "user", user.Username, "ip", ip, "recovery", res.recoveryIndex >= 0)
	s.startSession(w, r, updated, ip)
}

// factorResult is the outcome of checking a TOTP or recovery code.
type factorResult struct {
	ok            bool
	stale         bool
	step          int64
	recoveryIndex int
}

// checkFactor verifies a TOTP code or one of the recovery codes. When
// allowStale is false a TOTP step that is not newer than LastStep is reported
// as stale, which blocks replaying a code inside its validity window.
func (s *Server) checkFactor(user *model.User, code string, now time.Time, allowStale bool) factorResult {
	res := factorResult{recoveryIndex: -1}
	if user.TOTP.Secret != "" {
		secret := user.TOTP.Secret
		if s.opts.Box != nil {
			opened, err := s.opts.Box.Open(secret)
			if err == nil {
				secret = opened
			}
		}
		if step, ok := security.TOTPVerify(secret, code, now); ok {
			if !allowStale && step <= user.TOTP.LastStep {
				res.stale = true
				return res
			}
			res.ok = true
			res.step = step
			return res
		}
	}
	if idx := matchRecoveryCode(user.TOTP.Codes, code); idx >= 0 {
		res.ok = true
		res.recoveryIndex = idx
		return res
	}
	return res
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func (s *Server) userByID(id string) (*model.User, bool) {
	for _, u := range s.opts.Cfg.Snapshot().Users {
		if u.ID == id {
			copied := u
			return &copied, true
		}
	}
	return nil, false
}

func (s *Server) updateUserTOTP(userID string, fn func(*model.User)) error {
	return s.opts.Cfg.Update(func(c *model.Config) error {
		for i := range c.Users {
			if c.Users[i].ID == userID {
				fn(&c.Users[i])
				return nil
			}
		}
		return fmt.Errorf("user %q not found", userID)
	})
}

// revokeOtherSessions drops every other session of the same account. Enabling or
// disabling a factor has to invalidate sessions that were created with one
// factor less.
func (s *Server) revokeOtherSessions(current *security.Session) {
	if current == nil {
		return
	}
	for _, sess := range s.opts.Sessions.List() {
		if sess.UserID == current.UserID && sess.ID != current.ID {
			s.opts.Sessions.DeleteByID(sess.ID)
		}
	}
}

// newRecoveryCodes returns the plain codes (shown once) and their hashes.
func newRecoveryCodes() ([]string, []string) {
	codes := make([]string, 0, recoveryCodeCount)
	hashes := make([]string, 0, recoveryCodeCount)
	for i := 0; i < recoveryCodeCount; i++ {
		code := recoveryCode()
		codes = append(codes, code)
		hashes = append(hashes, hashRecoveryCode(code))
	}
	return codes, hashes
}

func recoveryCode() string {
	var raw [10]byte
	for i := range raw {
		raw[i] = recoveryAlphabet[rand.IntN(len(recoveryAlphabet))]
	}
	return string(raw[:5]) + "-" + string(raw[5:])
}

func hashRecoveryCode(code string) string {
	sum := sha256.Sum256([]byte(normalizeRecoveryCode(code)))
	return hex.EncodeToString(sum[:])
}

func normalizeRecoveryCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.NewReplacer(" ", "", "-", "", "\t", "").Replace(code)
	return code
}

// matchRecoveryCode returns the index of the matching recovery code or -1.
func matchRecoveryCode(hashes []string, code string) int {
	normalized := normalizeRecoveryCode(code)
	if len(normalized) != 10 {
		return -1
	}
	sum := sha256.Sum256([]byte(normalized))
	got := hex.EncodeToString(sum[:])
	for i, stored := range hashes {
		if subtle.ConstantTimeCompare([]byte(stored), []byte(got)) == 1 {
			return i
		}
	}
	return -1
}
