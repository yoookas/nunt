package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/security"
)

// enrollTOTP runs setup and confirm with the given session and returns the
// secret and the recovery codes.
func enrollTOTP(t *testing.T, env *testEnv, cookies []*http.Cookie, csrf string) (string, []string) {
	t.Helper()
	rec := env.do(t, http.MethodPost, "/api/v1/auth/totp/setup",
		map[string]string{"password": testPassword}, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("setup = %d: %s", rec.Code, rec.Body.String())
	}
	var setup struct {
		Secret string `json:"secret"`
		URI    string `json:"uri"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &setup); err != nil {
		t.Fatalf("decode setup: %v", err)
	}
	if setup.Secret == "" || !strings.HasPrefix(setup.URI, "otpauth://totp/") {
		t.Fatalf("setup payload = %+v", setup)
	}

	code, err := security.TOTPCodeAt(setup.Secret, security.TOTPStep(time.Now()))
	if err != nil {
		t.Fatalf("code: %v", err)
	}
	rec = env.do(t, http.MethodPost, "/api/v1/auth/totp/confirm",
		map[string]string{"code": code}, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm = %d: %s", rec.Code, rec.Body.String())
	}
	var confirmed struct {
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &confirmed); err != nil {
		t.Fatalf("decode confirm: %v", err)
	}
	if len(confirmed.RecoveryCodes) != recoveryCodeCount {
		t.Fatalf("recovery codes = %d, want %d", len(confirmed.RecoveryCodes), recoveryCodeCount)
	}
	return setup.Secret, confirmed.RecoveryCodes
}

// startTOTPLogin performs the password step and returns the challenge.
func startTOTPLogin(t *testing.T, env *testEnv) string {
	t.Helper()
	rec := env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "admin",
		"password": testPassword,
	}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		TOTPRequired bool   `json:"totpRequired"`
		Challenge    string `json:"challenge"`
		CSRF         string `json:"csrf"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	if !payload.TOTPRequired || payload.Challenge == "" {
		t.Fatalf("login payload = %+v", payload)
	}
	if payload.CSRF != "" {
		t.Fatal("the password step must not return a session csrf token")
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("the password step must not set a session cookie")
	}
	return payload.Challenge
}

func TestTOTPEnrollmentAndLogin(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)
	secret, _ := enrollTOTP(t, env, cookies, csrf)

	// The password step now only yields a challenge.
	challenge := startTOTPLogin(t, env)

	code, err := security.TOTPCodeAt(secret, security.TOTPStep(time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	rec := env.do(t, http.MethodPost, "/api/v1/auth/login/totp",
		map[string]string{"challenge": challenge, "code": code}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login/totp = %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		CSRF     string `json:"csrf"`
		Username string `json:"username"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.CSRF == "" || payload.Username != "admin" {
		t.Fatalf("payload = %+v", payload)
	}
	session := rec.Result().Cookies()
	if len(session) == 0 {
		t.Fatal("a successful second factor must set the session cookie")
	}

	rec = env.do(t, http.MethodGet, "/api/v1/auth/session", nil, session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("session = %d", rec.Code)
	}
	var sessionBody struct {
		TOTPEnabled       bool `json:"totpEnabled"`
		RecoveryCodesLeft int  `json:"recoveryCodesLeft"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &sessionBody); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if !sessionBody.TOTPEnabled || sessionBody.RecoveryCodesLeft != recoveryCodeCount {
		t.Fatalf("session body = %+v", sessionBody)
	}
}

func TestTOTPReplayIsRejected(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)
	secret, _ := enrollTOTP(t, env, cookies, csrf)

	code, err := security.TOTPCodeAt(secret, security.TOTPStep(time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	challenge := startTOTPLogin(t, env)
	if rec := env.do(t, http.MethodPost, "/api/v1/auth/login/totp",
		map[string]string{"challenge": challenge, "code": code}, nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("first login = %d: %s", rec.Code, rec.Body.String())
	}

	// The same code with a fresh challenge must be refused as already used.
	challenge = startTOTPLogin(t, env)
	rec := env.do(t, http.MethodPost, "/api/v1/auth/login/totp",
		map[string]string{"challenge": challenge, "code": code}, nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("replayed code = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "invalid_code") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestTOTPRecoveryCodeIsSingleUse(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)
	_, codes := enrollTOTP(t, env, cookies, csrf)

	challenge := startTOTPLogin(t, env)
	rec := env.do(t, http.MethodPost, "/api/v1/auth/login/totp",
		map[string]string{"challenge": challenge, "code": codes[0]}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("recovery login = %d: %s", rec.Code, rec.Body.String())
	}

	challenge = startTOTPLogin(t, env)
	rec = env.do(t, http.MethodPost, "/api/v1/auth/login/totp",
		map[string]string{"challenge": challenge, "code": codes[0]}, nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("reused recovery code = %d, want 401", rec.Code)
	}

	// The code was consumed: a fresh login sees one code less.
	session := env.do(t, http.MethodPost, "/api/v1/auth/login/totp", map[string]string{
		"challenge": startTOTPLogin(t, env), "code": codes[1],
	}, nil, nil)
	if session.Code != http.StatusOK {
		t.Fatalf("second recovery code = %d", session.Code)
	}
	req := session.Result().Cookies()
	info := env.do(t, http.MethodGet, "/api/v1/auth/session", nil, req, nil)
	if !strings.Contains(info.Body.String(), `"recoveryCodesLeft":8`) {
		t.Fatalf("session = %s", info.Body.String())
	}
}

func TestTOTPChallengeIsBurnedAfterWrongCodes(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)
	enrollTOTP(t, env, cookies, csrf)

	challenge := startTOTPLogin(t, env)
	for i := 0; i < totpMaxAttempts; i++ {
		rec := env.do(t, http.MethodPost, "/api/v1/auth/login/totp",
			map[string]string{"challenge": challenge, "code": "000000"}, nil, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d = %d, want 401", i+1, rec.Code)
		}
	}
	rec := env.do(t, http.MethodPost, "/api/v1/auth/login/totp",
		map[string]string{"challenge": challenge, "code": "000000"}, nil, nil)
	if !strings.Contains(rec.Body.String(), "challenge_expired") {
		t.Fatalf("exhausted challenge = %s", rec.Body.String())
	}
}

func TestTOTPDisableNeedsBothFactors(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)
	secret, _ := enrollTOTP(t, env, cookies, csrf)

	// A wrong password must not disable the factor.
	rec := env.do(t, http.MethodPost, "/api/v1/auth/totp/disable",
		map[string]string{"password": "wrong-password", "code": "000000"}, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("disable with a wrong password = %d", rec.Code)
	}

	code, err := security.TOTPCodeAt(secret, security.TOTPStep(time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	rec = env.do(t, http.MethodPost, "/api/v1/auth/totp/disable",
		map[string]string{"password": testPassword, "code": code}, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("disable = %d: %s", rec.Code, rec.Body.String())
	}

	// The factor is gone: the next password login returns a session directly.
	rec = env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "admin", "password": testPassword,
	}, nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"csrf"`) {
		t.Fatalf("login after disable = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestTOTPSecretIsMaskedInConfigExport(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)
	secret, _ := enrollTOTP(t, env, cookies, csrf)

	rec := env.do(t, http.MethodGet, "/api/v1/system/config", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatal("the exported configuration contains the TOTP secret")
	}
	if !strings.Contains(rec.Body.String(), `"totp"`) {
		t.Fatal("the export should still show that the factor is enabled")
	}
}

func TestTOTPConfirmWithoutSetupFails(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)
	rec := env.do(t, http.MethodPost, "/api/v1/auth/totp/confirm",
		map[string]string{"code": "123456"}, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("confirm without setup = %d, want 400", rec.Code)
	}
}
