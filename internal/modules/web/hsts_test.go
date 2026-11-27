package web

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

// HSTS may only be announced for a request that really is, or really reached
// the service through a proxy that terminated, TLS. The forwarded protocol
// header therefore counts only from a configured trusted proxy: otherwise any
// caller could make the service promise TLS on a connection that has none.
func TestHSTSIsEmittedOnlyForAProvenTLSRequest(t *testing.T) {
	cases := []struct {
		name    string
		trust   bool
		proxies []string
		proto   string
		want    bool
	}{
		{
			name:    "a trusted proxy that terminates TLS",
			trust:   true,
			proxies: []string{"127.0.0.1/32"},
			proto:   "https",
			want:    true,
		},
		{
			name:    "a trusted proxy that forwards plain http",
			trust:   true,
			proxies: []string{"127.0.0.1/32"},
			proto:   "http",
			want:    false,
		},
		{
			name:    "a peer that is not one of the configured proxies",
			trust:   true,
			proxies: []string{"192.0.2.0/24"},
			proto:   "https",
			want:    false,
		},
		{
			name:  "no trusted proxy configured at all",
			trust: false,
			proto: "https",
			want:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rule := mkRule(t, "hsts", "example.com", "/", 0, model.WebTypeRedirect)
			addr := freeAddr(t)
			listener := testListener("l1", []string{addr}, model.TLSModeOff)
			listener.TLS.HSTS = true
			store := testConfigStoreWithListener(t, listener, rule)
			if err := store.Update(func(c *model.Config) error {
				c.System.TrustProxy = tc.trust
				c.System.TrustedProxies = tc.proxies
				return nil
			}); err != nil {
				t.Fatalf("configure the trust proxy: %v", err)
			}

			w := New(&module.Deps{Cfg: store, DataDir: t.TempDir(), Registry: module.NewRegistry()})
			if err := w.Start(context.Background()); err != nil {
				t.Fatalf("start the module: %v", err)
			}
			t.Cleanup(func() { _ = w.Stop(context.Background()) })

			req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1"+addr+"/", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Host = "example.com"
			req.Header.Set("X-Forwarded-Proto", tc.proto)

			// The rule redirects: read the first response, do not chase it.
			client := &http.Client{
				Timeout: 5 * time.Second,
				CheckRedirect: func(*http.Request, []*http.Request) error {
					return http.ErrUseLastResponse
				},
			}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("request: %v", err)
			}
			defer func() { _ = resp.Body.Close() }()

			got := resp.Header.Get("Strict-Transport-Security")
			switch {
			case tc.want && got == "":
				t.Fatal("the expected HSTS header is missing")
			case !tc.want && got != "":
				t.Fatalf("an HSTS header was emitted without a proven TLS request: %q", got)
			}
		})
	}
}
