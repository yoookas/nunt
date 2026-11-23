package healthprobe

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/adminlisten"
)

func TestProbeAddrs(t *testing.T) {
	cases := []struct {
		listen string
		want   []string
	}{
		{":3113", []string{"127.0.0.1:3113"}},
		{"0.0.0.0:3113", []string{"127.0.0.1:3113"}},
		{"[::]:3113", []string{"[::1]:3113", "127.0.0.1:3113"}},
		{"127.0.0.1:8080", []string{"127.0.0.1:8080"}},
		{"192.0.2.10:8080", []string{"192.0.2.10:8080"}},
		{"[fd00::1]:8080", []string{"[fd00::1]:8080"}},
	}
	for _, tc := range cases {
		got := ProbeAddrs(tc.listen)
		if strings.Join(got, ",") != strings.Join(tc.want, ",") {
			t.Fatalf("ProbeAddrs(%q) = %v, want %v", tc.listen, got, tc.want)
		}
	}
}

func TestReadAdminListen(t *testing.T) {
	dir := t.TempDir()

	path := filepath.Join(dir, "config.json")
	if got, err := ReadAdminListen(path); err != nil || got != "" {
		t.Fatalf("missing file: got %q err %v", got, err)
	}

	if err := os.WriteFile(path, []byte(`{
  "version": 1,
  "system": {
    "adminListen": "127.0.0.1:18080"
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadAdminListen(path); err != nil || got != "127.0.0.1:18080" {
		t.Fatalf("present value: got %q err %v", got, err)
	}

	// A minified document has to work as well: sed based parsing used to be the
	// fragile part of the container health check.
	if err := os.WriteFile(path, []byte(`{"system":{"adminListen":":19090"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadAdminListen(path); err != nil || got != ":19090" {
		t.Fatalf("minified value: got %q err %v", got, err)
	}

	if err := os.WriteFile(path, []byte(`{"system":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadAdminListen(path); err == nil {
		t.Fatal("a broken configuration file must be an error")
	}
}

func TestRunAgainstRealServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	_, port, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"system":{"adminListen":"127.0.0.1:`+port+`"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	info, targets, err := Run(context.Background(), Config{
		ConfigPath:    path,
		DefaultListen: ":3113",
		Getenv:        func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if info.Listen != "127.0.0.1:"+port {
		t.Fatalf("listen = %q", info.Listen)
	}
	if len(targets) != 1 || targets[0] != "127.0.0.1:"+port {
		t.Fatalf("targets = %v", targets)
	}
}

func TestRunHonoursEnvironmentOverride(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))

	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	// The configuration points at a dead port; the environment wins.
	if err := os.WriteFile(path, []byte(`{"system":{"adminListen":"127.0.0.1:1"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"NUNT_ADMIN_PORT": port}
	info, _, err := Run(context.Background(), Config{
		ConfigPath:    path,
		DefaultListen: ":3113",
		Getenv:        func(k string) string { return env[k] },
	})
	if err != nil {
		t.Fatalf("Run with NUNT_ADMIN_PORT: %v", err)
	}
	if info.Source != adminlisten.SourceEnv || info.EnvVar != adminlisten.EnvPort {
		t.Fatalf("source = %q env = %q", info.Source, info.EnvVar)
	}
	if info.Listen != ":"+port {
		t.Fatalf("listen = %q, want :%s", info.Listen, port)
	}
}

func TestRunUsesDefaultWhenConfigIsMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))

	_, _, err := Run(context.Background(), Config{
		ConfigPath:    filepath.Join(t.TempDir(), "missing.json"),
		DefaultListen: "127.0.0.1:" + port,
		Getenv:        func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("Run with a missing config: %v", err)
	}
}

func TestRunFailsWhenNothingAnswers(t *testing.T) {
	// A closed listener gives a port nothing is listening on.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	_, _, err = Run(context.Background(), Config{
		ConfigPath:    filepath.Join(t.TempDir(), "config.json"),
		DefaultListen: addr,
		Getenv:        func(string) string { return "" },
		Timeout:       time.Second,
	})
	if err == nil {
		t.Fatal("expected an error when the service does not answer")
	}
	if !strings.Contains(err.Error(), addr) {
		t.Fatalf("error %q does not mention the address", err)
	}
}

func TestRunRejectsInvalidConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"system":{"adminListen":"not-an-address"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Run(context.Background(), Config{
		ConfigPath:    path,
		DefaultListen: ":3113",
		Getenv:        func(string) string { return "" },
	}); err == nil {
		t.Fatal("an invalid address must fail the probe")
	}
}
