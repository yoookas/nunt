// Package webui embeds the single page admin interface.
//
// The bundle is built from frontend/ (Vue 3 + Arco Design + Vite) and committed
// under assets/, so the binary stays self contained and "go build" needs no
// node toolchain; the container image rebuilds it in its web stage.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:assets
var assets embed.FS

// FS returns the asset file system rooted at the asset directory.
func FS() (fs.FS, error) {
	return fs.Sub(assets, "assets")
}

// Handler serves the SPA: an embedded asset when the path matches one, the
// index.html shell for client side routes.
//
// 文本资源在第一次被请求时压缩一次并留在内存里，见 compress.go。
func Handler() http.Handler {
	sub, err := FS()
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "admin interface is unavailable", http.StatusInternalServerError)
		})
	}
	return newAssetHandler(sub)
}
