package api

import (
	"net/http"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
)

func (s *Server) registerStorage() {
	g := s.mux.Group("/api/v1/storage")
	g.Get("/mounts", s.handleListMounts)
	g.Post("/mounts", s.handleCreateMount)
	g.Put("/mounts/{id}", s.handleUpdateMount)
	g.Delete("/mounts/{id}", s.handleDeleteMount)
	g.Get("/mounts/{id}/list", s.handleBrowseMount)
	g.Post("/mounts/test", s.handleTestMount)
}

func (s *Server) handleListMounts(w http.ResponseWriter, r *http.Request) {
	mounts := s.opts.Cfg.Snapshot().Storage.Mounts
	if mounts == nil {
		mounts = []model.Mount{}
	}
	rest.OK(w, mounts)
}

func (s *Server) handleCreateMount(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req model.Mount
	if !jsonBody(w, r, &req) {
		return
	}
	req.ID = model.NewID()
	req.CreatedAt = time.Now()
	if req.Type == "" {
		req.Type = model.MountLocal
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		c.Storage.Mounts = append(c.Storage.Mounts, req)
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "无法保存存储挂载：%s", err)
		return
	}
	s.opts.Mounts.Invalidate()
	s.audit(r, "mount.create", "name", req.Name)
	rest.OK(w, map[string]any{"id": req.ID})
}

func (s *Server) handleUpdateMount(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := idParam(r, "id")
	var req model.Mount
	if !jsonBody(w, r, &req) {
		return
	}
	err := s.opts.Cfg.Update(func(c *model.Config) error {
		for i := range c.Storage.Mounts {
			if c.Storage.Mounts[i].ID != id {
				continue
			}
			created := c.Storage.Mounts[i].CreatedAt
			req.ID = id
			req.CreatedAt = created
			c.Storage.Mounts[i] = req
			return nil
		}
		return errNotFound
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "存储挂载不存在")
		return
	}
	s.opts.Mounts.Invalidate()
	s.audit(r, "mount.update", "id", id)
	rest.NoContent(w)
}

func (s *Server) handleDeleteMount(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := idParam(r, "id")
	err := s.opts.Cfg.Update(func(c *model.Config) error {
		out := c.Storage.Mounts[:0]
		removed := false
		for _, m := range c.Storage.Mounts {
			if m.ID == id {
				removed = true
				continue
			}
			out = append(out, m)
		}
		c.Storage.Mounts = out
		if !removed {
			return errNotFound
		}
		return nil
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "存储挂载不存在")
		return
	}
	s.opts.Mounts.Invalidate()
	s.audit(r, "mount.delete", "id", id)
	rest.NoContent(w)
}

func (s *Server) handleBrowseMount(w http.ResponseWriter, r *http.Request) {
	id := idParam(r, "id")
	fsys, mnt, release, err := s.opts.Mounts.Get(id)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	defer release()
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}
	entries, err := fsys.List(r.Context(), path, true)
	if err != nil {
		rest.Fail(w, http.StatusBadGateway, "无法列出 %s：%s", path, err)
		return
	}
	rest.OK(w, map[string]any{"mount": mnt.Name, "path": path, "entries": entries})
}

type mountTestRequest struct {
	Mount model.Mount `json:"mount"`
	ID    string      `json:"id"`
}

func (s *Server) handleTestMount(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req mountTestRequest
	if !jsonBody(w, r, &req) {
		return
	}
	mnt := req.Mount
	if mnt.ID == "" {
		mnt.ID = req.ID
	}
	if mnt.Type == "" {
		mnt.Type = model.MountLocal
	}
	if err := s.opts.Mounts.Test(mnt); err != nil {
		rest.Fail(w, http.StatusBadGateway, "连接失败：%s", err)
		return
	}
	rest.OK(w, map[string]any{"status": "ok"})
}
