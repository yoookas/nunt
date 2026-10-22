package adminlisten

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func envFunc(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestResolve(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		env        map[string]string
		wantListen string
		wantSource Source
		wantVar    string
		wantErr    string
	}{
		{
			name:       "listen only wildcard",
			configured: ":16601",
			env:        map[string]string{EnvListen: ":8080"},
			wantListen: ":8080",
			wantSource: SourceEnv,
			wantVar:    EnvListen,
		},
		{
			name:       "listen only loopback",
			configured: ":16601",
			env:        map[string]string{EnvListen: "127.0.0.1:8080"},
			wantListen: "127.0.0.1:8080",
			wantSource: SourceEnv,
			wantVar:    EnvListen,
		},
		{
			name:       "listen only ipv6",
			configured: ":16601",
			env:        map[string]string{EnvListen: "[::1]:8080"},
			wantListen: "[::1]:8080",
			wantSource: SourceEnv,
			wantVar:    EnvListen,
		},
		{
			name:       "listen is trimmed and canonicalized",
			configured: ":16601",
			env:        map[string]string{EnvListen: " 127.0.0.1:08080 "},
			wantListen: "127.0.0.1:8080",
			wantSource: SourceEnv,
			wantVar:    EnvListen,
		},
		{
			name:       "port only",
			configured: ":16601",
			env:        map[string]string{EnvPort: "8080"},
			wantListen: ":8080",
			wantSource: SourceEnv,
			wantVar:    EnvPort,
		},
		{
			name:       "port is trimmed",
			configured: ":16601",
			env:        map[string]string{EnvPort: " 8080 "},
			wantListen: ":8080",
			wantSource: SourceEnv,
			wantVar:    EnvPort,
		},
		{
			name:       "listen wins over port",
			configured: ":16601",
			env: map[string]string{
				EnvListen: "127.0.0.1:8080",
				EnvPort:   "9090",
			},
			wantListen: "127.0.0.1:8080",
			wantSource: SourceEnv,
			wantVar:    EnvListen,
		},
		{
			name:       "empty listen falls back to port",
			configured: ":16601",
			env: map[string]string{
				EnvListen: "",
				EnvPort:   "9090",
			},
			wantListen: ":9090",
			wantSource: SourceEnv,
			wantVar:    EnvPort,
		},
		{
			name:       "blank env values fall back to config",
			configured: "127.0.0.1:16601",
			env: map[string]string{
				EnvListen: "   ",
				EnvPort:   "",
			},
			wantListen: "127.0.0.1:16601",
			wantSource: SourceConfig,
		},
		{
			name:       "no env uses config",
			configured: ":16601",
			env:        nil,
			wantListen: ":16601",
			wantSource: SourceConfig,
		},
		{
			name:       "config value is normalized",
			configured: "127.0.0.1:016601",
			env:        nil,
			wantListen: "127.0.0.1:16601",
			wantSource: SourceConfig,
		},
		{
			name:       "invalid listen abc",
			configured: ":16601",
			env:        map[string]string{EnvListen: "abc"},
			wantErr:    "invalid NUNT_ADMIN_LISTEN",
		},
		{
			name:       "invalid listen without port",
			configured: ":16601",
			env:        map[string]string{EnvListen: "127.0.0.1"},
			wantErr:    "invalid NUNT_ADMIN_LISTEN",
		},
		{
			name:       "invalid listen port zero",
			configured: ":16601",
			env:        map[string]string{EnvListen: ":0"},
			wantErr:    "invalid NUNT_ADMIN_LISTEN",
		},
		{
			name:       "invalid listen port out of range",
			configured: ":16601",
			env:        map[string]string{EnvListen: ":70000"},
			wantErr:    "invalid NUNT_ADMIN_LISTEN",
		},
		{
			name:       "invalid port not a number",
			configured: ":16601",
			env:        map[string]string{EnvPort: "abc"},
			wantErr:    "invalid NUNT_ADMIN_PORT",
		},
		{
			name:       "invalid port decimal",
			configured: ":16601",
			env:        map[string]string{EnvPort: "8080.5"},
			wantErr:    "invalid NUNT_ADMIN_PORT",
		},
		{
			name:       "invalid port zero",
			configured: ":16601",
			env:        map[string]string{EnvPort: "0"},
			wantErr:    "invalid NUNT_ADMIN_PORT",
		},
		{
			name:       "invalid port negative",
			configured: ":16601",
			env:        map[string]string{EnvPort: "-1"},
			wantErr:    "invalid NUNT_ADMIN_PORT",
		},
		{
			name:       "invalid port out of range",
			configured: ":16601",
			env:        map[string]string{EnvPort: "65536"},
			wantErr:    "invalid NUNT_ADMIN_PORT",
		},
		{
			name:       "invalid config without env",
			configured: "abc",
			env:        nil,
			wantErr:    "invalid system.adminListen",
		},
		{
			name:       "env overrides invalid config",
			configured: "abc",
			env:        map[string]string{EnvListen: ":8080"},
			wantListen: ":8080",
			wantSource: SourceEnv,
			wantVar:    EnvListen,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := Resolve(tc.configured, envFunc(tc.env))
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("Resolve() error = nil, want an error containing %q", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("Resolve() error = %q, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			if info.Listen != tc.wantListen {
				t.Errorf("Listen = %q, want %q", info.Listen, tc.wantListen)
			}
			if info.Source != tc.wantSource {
				t.Errorf("Source = %q, want %q", info.Source, tc.wantSource)
			}
			if info.ConfigListen != tc.configured {
				t.Errorf("ConfigListen = %q, want the configured value %q", info.ConfigListen, tc.configured)
			}
			if info.EnvVar != tc.wantVar {
				t.Errorf("EnvVar = %q, want %q", info.EnvVar, tc.wantVar)
			}
		})
	}
}

func TestResolvePortBoundaries(t *testing.T) {
	for _, port := range []string{"1", "65535"} {
		info, err := Resolve(":16601", envFunc(map[string]string{EnvPort: port}))
		if err != nil {
			t.Fatalf("port %s: %v", port, err)
		}
		if want := ":" + port; info.Listen != want {
			t.Fatalf("port %s: Listen = %q, want %q", port, info.Listen, want)
		}
	}
}

func TestWithInfo(t *testing.T) {
	want := Info{
		Listen:       "127.0.0.1:16777",
		ConfigListen: ":16601",
		Source:       SourceEnv,
		EnvVar:       EnvListen,
	}
	handler := WithInfo(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := FromContext(r.Context())
		if !ok {
			t.Fatal("FromContext() reported no info")
		}
		if got != want {
			t.Fatalf("FromContext() = %+v, want %+v", got, want)
		}
	}), want)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestFromContextWithoutInfo(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, ok := FromContext(req.Context()); ok {
		t.Fatal("FromContext() must report false when WithInfo was not used")
	}
}
