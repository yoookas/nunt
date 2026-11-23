package api

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/backup"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
)

func (s *Server) registerBackup() {
	s.mux.Get("/api/v1/system/backup", s.handleBackupDownload)
	s.mux.Get("/api/v1/system/backup/files", s.handleBackupFiles)
	s.mux.Get("/api/v1/system/backup/config", s.handleGetBackupConfig)
	s.mux.Put("/api/v1/system/backup/config", s.handleUpdateBackupConfig)
}

// backupDir returns where archives live for the current configuration.
func (s *Server) backupDir(cfg *model.Config) string {
	return backup.Dir(s.opts.DataDir, cfg.Backup.Dir)
}

// handleBackupDownload writes a fresh archive and streams it. The archive stays
// on disk as a regular backup, so a manual download and the scheduled run share
// the retention policy.
func (s *Server) handleBackupDownload(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	cfg := s.opts.Cfg.Snapshot()
	path, err := backup.Create(s.opts.DataDir, s.backupDir(cfg), cfg.Backup.Keep, time.Now())
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法生成备份：%s", err)
		return
	}
	s.audit(r, "system.backup.create", "file", filepath.Base(path))
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(path)))
	w.Header().Set("Content-Type", "application/gzip")
	http.ServeFile(w, r, path)
}

func (s *Server) handleBackupFiles(w http.ResponseWriter, r *http.Request) {
	cfg := s.opts.Cfg.Snapshot()
	dir := s.backupDir(cfg)
	files, err := backup.List(dir)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法读取备份目录：%s", err)
		return
	}
	rest.OK(w, map[string]any{
		"dir":    dir,
		"files":  files,
		"config": cfg.Backup,
	})
}

func (s *Server) handleGetBackupConfig(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, s.opts.Cfg.Snapshot().Backup)
}

func (s *Server) handleUpdateBackupConfig(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req model.BackupConfig
	if !jsonBody(w, r, &req) {
		return
	}
	req.Dir = strings.TrimSpace(req.Dir)
	if req.IntervalHours < 1 || req.IntervalHours > 24*30 {
		rest.Fail(w, http.StatusBadRequest, "备份间隔必须在 1 到 720 小时之间")
		return
	}
	if req.Keep < 1 || req.Keep > 60 {
		rest.Fail(w, http.StatusBadRequest, "保留份数必须在 1 到 60 之间")
		return
	}
	if req.Dir != "" {
		if !filepath.IsAbs(req.Dir) {
			rest.Fail(w, http.StatusBadRequest, "备份目录必须是绝对路径")
			return
		}
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		c.Backup = req
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法保存备份设置：%s", err)
		return
	}
	s.audit(r, "system.backup.config", "enabled", req.Enabled, "intervalHours", req.IntervalHours, "keep", req.Keep)
	rest.OK(w, s.opts.Cfg.Snapshot().Backup)
}
