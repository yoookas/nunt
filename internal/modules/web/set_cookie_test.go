package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/security"
)

// The administrator session cookie is host scoped, not port scoped. A proxied
// site on the same hostname therefore shares the browser cookie jar with the
// console: it must neither receive the console token nor be able to plant one
// of its own through a response.
func TestProxyKeepsTheAdminSessionCookieOffTheUpstream(t *testing.T) {
	// The handler goroutine publishes what it received through a channel: the
	// race detector needs a happens-before edge that plain network I/O does not
	// provide.
	received := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Get("Cookie")
		http.SetCookie(w, &http.Cookie{
			Name:  security.SessionCookieName,
			Value: "planted-by-the-upstream",
			Path:  "/",
		})
		http.SetCookie(w, &http.Cookie{Name: "app_session", Value: "keep-me", Path: "/"})
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(upstream.Close)

	raw := mkRule(t, "cookie-isolation", "example.com", "/", 0, model.WebTypeProxy)
	raw.Proxy = &model.ProxyTarget{Targets: []string{upstream.URL}, Balance: "roundrobin"}

	addr := freeAddr(t)
	store := testConfigStoreWithListener(t, testListener("l1", []string{addr}, model.TLSModeOff), raw)
	w := New(&module.Deps{Cfg: store, DataDir: t.TempDir(), Registry: module.NewRegistry()})
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = w.Stop(context.Background()) })

	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1"+addr+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "example.com"
	req.AddCookie(&http.Cookie{Name: security.SessionCookieName, Value: "operator-token"})
	req.AddCookie(&http.Cookie{Name: "app_session", Value: "keep-me"})

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var forwarded string
	select {
	case forwarded = <-received:
	case <-time.After(5 * time.Second):
		t.Fatal("the upstream received no request")
	}

	if strings.Contains(forwarded, security.SessionCookieName+"=") {
		t.Fatalf("the upstream received the administrator session cookie: %q", forwarded)
	}
	if !strings.Contains(forwarded, "app_session=keep-me") {
		t.Fatalf("the upstream lost a cookie of its own site: %q", forwarded)
	}

	names := make([]string, 0, len(resp.Cookies()))
	for _, c := range resp.Cookies() {
		names = append(names, c.Name)
	}
	if slices.Contains(names, security.SessionCookieName) {
		t.Fatalf("the response carries an administrator session cookie: %v", names)
	}
	if !slices.Contains(names, "app_session") {
		t.Fatalf("the response lost a cookie of the upstream site: %v", names)
	}
}
