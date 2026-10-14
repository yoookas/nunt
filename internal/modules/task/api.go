package task

import (
	"errors"
	"net/http"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
)

// registerAPI mounts /api/v1/task/. Authentication, CSRF and rate limiting are
// applied by the parent mux.
func (t *Task) registerAPI(mux *rest.Mux) {
	g := mux.Group("/api/v1/task")
	g.Get("/items", t.handleList)
	g.Post("/items", t.handleCreate)
	g.Put("/items/{id}", t.handleUpdate)
	g.Delete("/items/{id}", t.handleDelete)
	g.Post("/items/{id}/toggle", t.handleToggle)
	g.Post("/items/{id}/run", t.handleRun)
}

func (t *Task) handleList(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, t.Items())
}

func (t *Task) handleCreate(w http.ResponseWriter, r *http.Request) {
	var item model.Task
	if err := rest.Decode(w, r, &item); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	withTaskDefaults(&item)
	if err := validateTask(item); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}

	err := t.update(func(c *model.Config) error {
		for _, existing := range c.Tasks.Items {
			if existing.ID == item.ID {
				return errors.New("a task with this id already exists")
			}
		}
		c.Tasks.Items = append(c.Tasks.Items, item)
		return nil
	})
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot save the task: %s", err)
		return
	}
	rest.JSON(w, http.StatusCreated, item)
}

func (t *Task) handleUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var item model.Task
	if err := rest.Decode(w, r, &item); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	item.ID = id
	withTaskDefaults(&item)
	if err := validateTask(item); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}

	found := false
	err := t.update(func(c *model.Config) error {
		for i := range c.Tasks.Items {
			if c.Tasks.Items[i].ID != id {
				continue
			}
			c.Tasks.Items[i] = item
			found = true
			return nil
		}
		return errors.New("task not found")
	})
	if err != nil {
		status := http.StatusBadRequest
		if !found {
			status = http.StatusNotFound
		}
		rest.Fail(w, status, "cannot update the task: %s", err)
		return
	}
	rest.OK(w, item)
}

func (t *Task) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := t.update(func(c *model.Config) error {
		for i := range c.Tasks.Items {
			if c.Tasks.Items[i].ID == id {
				c.Tasks.Items = append(c.Tasks.Items[:i], c.Tasks.Items[i+1:]...)
				return nil
			}
		}
		return errors.New("task not found")
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "cannot delete the task: %s", err)
		return
	}
	t.forget(id)
	rest.OK(w, map[string]any{"deleted": id})
}

// handleToggle flips a task. The body is optional: {"enable":true} sets an
// explicit state, an empty body toggles the current one.
func (t *Task) handleToggle(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	requested, ok, err := decodeEnable(w, r)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}

	var updated model.Task
	found := false
	err = t.update(func(c *model.Config) error {
		for i := range c.Tasks.Items {
			if c.Tasks.Items[i].ID != id {
				continue
			}
			next := !c.Tasks.Items[i].Enable
			if ok {
				next = requested
			}
			c.Tasks.Items[i].Enable = next
			updated = c.Tasks.Items[i]
			found = true
			return nil
		}
		return errors.New("task not found")
	})
	if err != nil {
		status := http.StatusBadRequest
		if !found {
			status = http.StatusNotFound
		}
		rest.Fail(w, status, "cannot toggle the task: %s", err)
		return
	}
	rest.OK(w, updated)
}

// handleRun executes a task immediately, out of band. The response returns as
// soon as the run has been queued.
func (t *Task) handleRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	item, ok := t.taskByID(id)
	if !ok {
		rest.Fail(w, http.StatusNotFound, "task %q does not exist", id)
		return
	}
	if !t.acceptManual(id) {
		rest.Fail(w, http.StatusTooManyRequests, "task %q was just started, please wait", id)
		return
	}
	t.run(r.Context(), item)
	rest.JSON(w, http.StatusAccepted, map[string]any{"started": true, "id": id})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// decodeEnable reads an optional {"enable":bool} toggle body.
func decodeEnable(w http.ResponseWriter, r *http.Request) (bool, bool, error) {
	if r.Body == nil || r.ContentLength == 0 {
		return false, false, nil
	}
	var body struct {
		Enable *bool `json:"enable"`
	}
	if err := rest.Decode(w, r, &body); err != nil {
		return false, false, err
	}
	if body.Enable == nil {
		return false, false, nil
	}
	return *body.Enable, true, nil
}

// update writes the configuration and reloads the scheduler immediately. The
// store notifies the modules as well; the extra reload is idempotent.
func (t *Task) update(fn func(*model.Config) error) error {
	if t.deps.Cfg == nil {
		return errors.New("the configuration store is unavailable")
	}
	if err := t.deps.Cfg.Update(fn); err != nil {
		return err
	}
	t.Reload(t.deps.Cfg.Snapshot())
	return nil
}

// forget drops the runtime state of a removed task.
func (t *Task) forget(id string) {
	t.mu.Lock()
	delete(t.states, id)
	delete(t.manual, id)
	t.mu.Unlock()
}

// acceptManual rate limits the "run now" endpoint.
func (t *Task) acceptManual(id string) bool {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if last, ok := t.manual[id]; ok && now.Sub(last) < manualRetention {
		return false
	}
	t.manual[id] = now
	if len(t.manual) > 512 {
		for key, ts := range t.manual {
			if now.Sub(ts) > manualRetention {
				delete(t.manual, key)
			}
		}
	}
	return true
}
