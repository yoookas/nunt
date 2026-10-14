// Package webui embeds the single page admin interface.
//
// The assets are plain HTML/CSS/JavaScript without a build step so the binary
// stays self contained and the container image needs no node toolchain.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:assets
var assets embed.FS

// FS returns the asset file system rooted at the asset directory.
func FS() (fs.FS, error) {
	return fs.Sub(assets, "assets")
}

// Handler serves the SPA, falling back to index.html for client side routes.
func Handler() http.Handler {
	sub, err := FS()
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "admin interface is unavailable", http.StatusInternalServerError)
		})
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if strings.HasPrefix(p, "api/") || strings.HasPrefix(p, "healthz") {
			http.NotFound(w, r)
			return
		}
		if _, err := fs.Stat(sub, p); err != nil {
			// Client side route: serve the shell.
			r = r.Clone(r.Context())
			r.URL.Path = "/"
			serveIndex(sub, w, r)
			return
		}
		if strings.HasSuffix(p, ".html") {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=600")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func serveIndex(sub fs.FS, w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		http.Error(w, "admin interface is unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}
