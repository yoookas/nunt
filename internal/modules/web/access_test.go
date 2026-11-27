package web

import (
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/testutil"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAccessHandlerIPFilter(t *testing.T) {
	raw := mkRule(t, "guard", "example.com", "/", 0, model.WebTypeRedirect)
	raw.Access = model.Access{
		Mode: model.AccessRules,
		IP: model.AccessList{Rest: model.AccessAllow, Entries: []model.AccessEntry{
			{Action: model.AccessDeny, Kind: model.AccessKindIP, Value: "203.0.113.0/24"},
		}},
		UA: model.AccessList{Rest: model.AccessAllow},
	}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	handler := bareWeb().accessHandler(compiled, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(rw, "ok")
	}))
	req := httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	req.RemoteAddr = "203.0.113.9:1234"
	rw := httptest.NewRecorder()
	handler.ServeHTTP(rw, req)
	if rw.Code != http.StatusForbidden {
		t.Fatalf("denied client status = %d", rw.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	req.RemoteAddr = "198.51.100.5:1234"
	rw = httptest.NewRecorder()
	handler.ServeHTTP(rw, req)
	if rw.Code != http.StatusOK {
		t.Fatalf("allowed client status = %d", rw.Code)
	}
}

func TestBasicAuthHandler(t *testing.T) {
	hash := testutil.PasswordHash("s3cret")
	raw := mkRule(t, "guard", "example.com", "/", 0, model.WebTypeRedirect)
	raw.BasicAuth = &model.BasicAuth{Enable: true, Users: []model.BasicAuthUser{{Username: "alice", Password: hash}}}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	handler := bareWeb().basicAuthHandler(compiled, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(rw, "ok")
	}))

	req := httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	rw := httptest.NewRecorder()
	handler.ServeHTTP(rw, req)
	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status = %d", rw.Code)
	}
	if !strings.HasPrefix(rw.Header().Get("WWW-Authenticate"), "Basic realm=") {
		t.Fatalf("missing challenge: %q", rw.Header().Get("WWW-Authenticate"))
	}

	req = httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	req.SetBasicAuth("alice", "s3cret")
	rw = httptest.NewRecorder()
	handler.ServeHTTP(rw, req)
	if rw.Code != http.StatusOK {
		t.Fatalf("authenticated status = %d", rw.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	req.SetBasicAuth("alice", "wrong")
	rw = httptest.NewRecorder()
	handler.ServeHTTP(rw, req)
	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password status = %d", rw.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	req.SetBasicAuth("bob", "s3cret")
	rw = httptest.NewRecorder()
	handler.ServeHTTP(rw, req)
	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("unknown user status = %d", rw.Code)
	}
}

// A route with mode inherit uses the access rule of its listener; a route with
// its own mode overrides it.
func TestRouteInheritsListenerAccess(t *testing.T) {
	cfg := &model.Config{Web: model.WebConfig{
		Listeners: []model.WebListener{{
			ID: "l1", Name: "http", Listen: []string{":18080"},
			Access: model.Access{Mode: model.AccessRules, IP: model.AccessList{Rest: model.AccessDeny, Entries: []model.AccessEntry{{Action: model.AccessAllow, Kind: model.AccessKindIP, Value: "10.0.0.0/8"}}}, UA: model.AccessList{Rest: model.AccessAllow}},
		}},
		Rules: []model.WebRule{{
			ID: "r1", Name: "inherit", Enable: true, Type: model.WebTypeProxy,
			ListenerID: "l1", Path: "/", Domains: []string{"a.example.com"},
			Access: model.Access{Mode: model.AccessInherit},
			Proxy:  &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9000"}},
		}},
	}}
	w := &Web{deps: &module.Deps{}}
	compiled, _, errs := w.compileWeb(cfg)
	if len(errs) != 0 {
		t.Fatalf("compileWeb: %v", errs)
	}
	if len(compiled) != 1 {
		t.Fatalf("compiled = %d", len(compiled))
	}
	rule := compiled[0]
	if rule.spec.Access.Mode != model.AccessRules || len(rule.spec.Access.IP.Entries) != 1 {
		t.Fatalf("the listener access was not inherited: %+v", rule.spec.Access)
	}
	if ok, _ := rule.filter.Allowed(net.ParseIP("10.1.2.3"), ""); !ok {
		t.Fatal("an address from the listener allow list must pass")
	}
	if ok, _ := rule.filter.Allowed(net.ParseIP("192.168.1.1"), ""); ok {
		t.Fatal("an address outside the listener allow list must be refused")
	}

	// A route's own rule replaces the listener rule.
	cfg.Web.Rules[0].Access = model.Access{Mode: model.AccessRules, IP: model.AccessList{Rest: model.AccessDeny, Entries: []model.AccessEntry{{Action: model.AccessAllow, Kind: model.AccessKindIP, Value: "192.168.1.0/24"}}}, UA: model.AccessList{Rest: model.AccessAllow}}
	compiled, _, errs = w.compileWeb(cfg)
	if len(errs) != 0 || len(compiled) != 1 {
		t.Fatalf("compileWeb: %v", errs)
	}
	if ok, _ := compiled[0].filter.Allowed(net.ParseIP("192.168.1.5"), ""); !ok {
		t.Fatal("the route's own allow list must win")
	}
	if ok, _ := compiled[0].filter.Allowed(net.ParseIP("10.1.2.3"), ""); ok {
		t.Fatal("the listener list must not leak into a custom route")
	}
}
