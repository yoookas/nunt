package api

import (
	"context"
	"net/http"
	"time"

	"github.com/nunt/nunt/internal/rest"
)

func (s *Server) registerModules() {
	g := s.mux.Group("/api/v1/modules")
	g.Get("", s.handleListModules)
	g.Post("/{name}/start", s.handleModuleAction("start"))
	g.Post("/{name}/stop", s.handleModuleAction("stop"))
	g.Post("/{name}/restart", s.handleModuleAction("restart"))
}

func (s *Server) handleListModules(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, s.opts.Registry.Statuses())
}

func (s *Server) handleModuleAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		name := idParam(r, "name")
		mod, ok := s.opts.Registry.Get(name)
		if !ok {
			rest.Fail(w, http.StatusNotFound, "模块 %q 不存在", name)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		var err error
		switch action {
		case "start":
			err = mod.Start(ctx)
		case "stop":
			err = mod.Stop(ctx)
		case "restart":
			if err = mod.Stop(ctx); err == nil {
				err = mod.Start(ctx)
			}
		}
		if err != nil {
			rest.Fail(w, http.StatusInternalServerError, "%s %s 失败：%s", action, name, err)
			return
		}
		s.audit(r, "module."+action, "module", name)
		rest.OK(w, mod.Status())
	}
}
