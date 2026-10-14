package filebrowser

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/vfs"
)

const (
	// maxUploadSize is the per file upload limit (4 GiB).
	maxUploadSize = int64(4) << 30
	// maxFormValue bounds the non file multipart fields.
	maxFormValue = 4 << 10
)

var errTooLarge = errors.New("file is larger than the upload limit")

// uploadResult reports the outcome of one uploaded file.
type uploadResult struct {
	Name  string `json:"name"`
	Path  string `json:"path,omitempty"`
	Size  int64  `json:"size,omitempty"`
	Error string `json:"error,omitempty"`
	Code  string `json:"code,omitempty"`
}

// handleUpload streams a multipart body into the storage. Files are written one
// by one, so the request body never has to be buffered.
func (s *site) handleUpload(w http.ResponseWriter, r *http.Request) {
	if !s.can.Upload {
		rest.Fail(w, http.StatusForbidden, "该站点不允许上传文件")
		return
	}
	dir, ok := s.pathParam(w, r, "/")
	if !ok {
		return
	}
	if entry, err := s.fs.Stat(r.Context(), dir); err != nil {
		s.fail(w, "stat", err)
		return
	} else if !entry.Dir {
		rest.Fail(w, http.StatusBadRequest, "上传目标必须是目录")
		return
	}
	confirm := isTrue(r.URL.Query().Get("confirm"))

	reader, err := r.MultipartReader()
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "请使用 multipart/form-data 上传文件")
		return
	}

	saved := []uploadResult{}
	failed := []uploadResult{}
	fatal := ""
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fatal = "读取上传数据失败: " + err.Error()
			break
		}
		filename := part.FileName()
		if filename == "" {
			// A plain form field ("path", "confirm"); the query string is the
			// primary source, this is only a convenience.
			value, _ := io.ReadAll(io.LimitReader(part, maxFormValue))
			switch strings.ToLower(part.FormName()) {
			case "path", "dir":
				if clean, err := vfs.Clean(string(value)); err == nil && clean != "" {
					dir = clean
				}
			case "confirm", "overwrite":
				if isTrue(string(value)) {
					confirm = true
				}
			}
			continue
		}
		name, err := sanitizeName(filename)
		if err != nil {
			failed = append(failed, uploadResult{Name: filename, Error: err.Error(), Code: "invalid_name"})
			continue
		}
		target := path.Join(dir, name)
		if existing, statErr := s.fs.Stat(r.Context(), target); statErr == nil {
			if existing.Dir {
				failed = append(failed, uploadResult{Name: name, Error: "同名目录已存在", Code: "conflict"})
				continue
			}
			if !confirm {
				failed = append(failed, uploadResult{Name: name, Error: "文件已存在", Code: "exists"})
				continue
			}
		} else if !errors.Is(statErr, vfs.ErrNotExist) {
			failed = append(failed, uploadResult{Name: name, Error: "无法检查目标文件", Code: "stat"})
			continue
		}

		limited := &maxBytesReader{r: part, remaining: maxUploadSize}
		written, err := s.fs.Create(r.Context(), target, limited)
		if err != nil {
			// A failed upload must not leave a half written file behind.
			_ = s.fs.Remove(context.WithoutCancel(r.Context()), target, true)
			res := uploadResult{Name: name, Error: "写入失败"}
			switch {
			case errors.Is(err, errTooLarge):
				res.Error = "文件超过 4GB 上限"
				res.Code = "too_large"
			case errors.Is(err, vfs.ErrReadOnly):
				res.Error = "存储为只读"
				res.Code = "read_only"
			}
			if s.log != nil {
				s.log.Warn("upload failed", "path", target, "error", err)
			}
			failed = append(failed, res)
			continue
		}
		saved = append(saved, uploadResult{Name: name, Path: target, Size: written})
	}

	body := map[string]any{"dir": dir, "saved": saved, "failed": failed}
	if fatal != "" {
		body["error"] = fatal
	}
	switch {
	case len(saved) > 0:
		rest.OK(w, body)
	case len(failed) > 0:
		status := http.StatusBadRequest
		for _, f := range failed {
			if f.Code == "exists" || f.Code == "conflict" {
				status = http.StatusConflict
				break
			}
		}
		rest.JSON(w, status, body)
	default:
		rest.Fail(w, http.StatusBadRequest, "%s", firstNonEmpty(fatal, "没有收到任何文件"))
	}
}

// maxBytesReader fails the read as soon as the limit is exceeded instead of
// silently truncating the upload.
type maxBytesReader struct {
	r         io.Reader
	remaining int64
}

func (m *maxBytesReader) Read(p []byte) (int, error) {
	if m.remaining <= 0 {
		return 0, errTooLarge
	}
	if int64(len(p)) > m.remaining {
		p = p[:m.remaining]
	}
	n, err := m.r.Read(p)
	m.remaining -= int64(n)
	return n, err
}

type mkdirRequest struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

func (s *site) handleMkdir(w http.ResponseWriter, r *http.Request) {
	if !s.can.Mkdir {
		rest.Fail(w, http.StatusForbidden, "该站点不允许新建文件夹")
		return
	}
	var req mkdirRequest
	if err := decodeJSON(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	dir, raw, err := requestTarget(req.Path, req.Name, "/")
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	name, err := sanitizeName(raw)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	target := path.Join(dir, name)
	target, err = vfs.Clean(target)
	if err != nil || target == "/" {
		rest.Fail(w, http.StatusBadRequest, "路径无效")
		return
	}
	if _, err := s.fs.Stat(r.Context(), target); err == nil {
		rest.Fail(w, http.StatusConflict, "同名文件或目录已存在")
		return
	} else if !errors.Is(err, vfs.ErrNotExist) {
		s.fail(w, "stat", err)
		return
	}
	if err := s.fs.Mkdir(r.Context(), target); err != nil {
		s.fail(w, "mkdir", err)
		return
	}
	rest.OK(w, map[string]any{"path": target, "name": name})
}

type renameRequest struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

func (s *site) handleRename(w http.ResponseWriter, r *http.Request) {
	if !s.can.Rename {
		rest.Fail(w, http.StatusForbidden, "该站点不允许重命名")
		return
	}
	var req renameRequest
	if err := decodeJSON(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	src, err := vfs.Clean(req.Path)
	if err != nil || src == "/" {
		rest.Fail(w, http.StatusBadRequest, "路径无效")
		return
	}
	name, err := sanitizeName(req.Name)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	target := path.Join(path.Dir(src), name)
	if target == src {
		rest.OK(w, map[string]any{"path": src, "name": name})
		return
	}
	if _, err := s.fs.Stat(r.Context(), src); err != nil {
		s.fail(w, "stat", err)
		return
	}
	if _, err := s.fs.Stat(r.Context(), target); err == nil {
		rest.Fail(w, http.StatusConflict, "目标名称已存在")
		return
	} else if !errors.Is(err, vfs.ErrNotExist) {
		s.fail(w, "stat", err)
		return
	}
	if err := s.fs.Rename(r.Context(), src, target); err != nil {
		s.fail(w, "rename", err)
		return
	}
	rest.OK(w, map[string]any{"path": target, "name": name})
}

type deleteRequest struct {
	Path  string   `json:"path"`
	Paths []string `json:"paths"`
}

func (s *site) handleDelete(w http.ResponseWriter, r *http.Request) {
	if !s.can.Delete {
		rest.Fail(w, http.StatusForbidden, "该站点不允许删除")
		return
	}
	var req deleteRequest
	if err := decodeJSON(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	targets := req.Paths
	if strings.TrimSpace(req.Path) != "" {
		targets = append(targets, req.Path)
	}
	if len(targets) == 0 {
		rest.Fail(w, http.StatusBadRequest, "没有指定要删除的路径")
		return
	}
	removed := []string{}
	failed := []uploadResult{}
	for _, raw := range targets {
		clean, err := vfs.Clean(raw)
		if err != nil || clean == "/" {
			failed = append(failed, uploadResult{Name: raw, Error: "路径无效", Code: "invalid"})
			continue
		}
		entry, err := s.fs.Stat(r.Context(), clean)
		if err != nil {
			failed = append(failed, uploadResult{Name: clean, Error: vfsMessage(vfsStatus(err)), Code: "stat"})
			continue
		}
		if err := s.fs.Remove(r.Context(), clean, entry.Dir); err != nil {
			failed = append(failed, uploadResult{Name: clean, Error: vfsMessage(vfsStatus(err)), Code: "remove"})
			if s.log != nil {
				s.log.Warn("delete failed", "path", clean, "error", err)
			}
			continue
		}
		removed = append(removed, clean)
	}
	body := map[string]any{"removed": removed, "failed": failed}
	if len(removed) > 0 {
		rest.OK(w, body)
		return
	}
	rest.JSON(w, http.StatusBadRequest, body)
}

// ---------------------------------------------------------------------------
// share links of this site
// ---------------------------------------------------------------------------

func (s *site) handleShareCreate(w http.ResponseWriter, r *http.Request) {
	if !s.can.Share {
		rest.Fail(w, http.StatusForbidden, "该站点未启用分享链接")
		return
	}
	var req shareRequest
	if err := decodeJSON(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	req.Rule = s.rule.ID
	share, err := createShare(r.Context(), s.deps, s.rule, req)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	share.URL = absoluteShareURL(r, s.rule, share.Token)
	rest.OK(w, share)
}

func (s *site) handleShareList(w http.ResponseWriter, r *http.Request) {
	if !s.can.Share {
		rest.Fail(w, http.StatusForbidden, "该站点未启用分享链接")
		return
	}
	shares, err := s.shares.list()
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法读取分享链接")
		return
	}
	for i := range shares {
		shares[i].URL = absoluteShareURL(r, s.rule, shares[i].Token)
	}
	rest.OK(w, map[string]any{"items": shares, "now": time.Now()})
}

func (s *site) handleShareDelete(w http.ResponseWriter, r *http.Request) {
	if !s.can.Share {
		rest.Fail(w, http.StatusForbidden, "该站点未启用分享链接")
		return
	}
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		rest.Fail(w, http.StatusBadRequest, "缺少 token 参数")
		return
	}
	removed, err := s.shares.remove(token)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法删除分享链接")
		return
	}
	if !removed {
		rest.Fail(w, http.StatusNotFound, "分享链接不存在")
		return
	}
	rest.NoContent(w)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// requestTarget combines a directory and a name into a directory/new name pair.
func requestTarget(dirParam, nameParam, def string) (string, string, error) {
	dir, err := vfs.Clean(dirParam)
	if err != nil {
		return "", "", errors.New("路径无效")
	}
	if strings.TrimSpace(dirParam) == "" {
		dir = def
	}
	name := strings.TrimSpace(nameParam)
	if name == "" {
		// Only a full path was given: split it into directory and name.
		name = path.Base(dir)
		dir = path.Dir(dir)
	}
	if name == "" || name == "." || name == "/" {
		return "", "", errors.New("名称不能为空")
	}
	return dir, name, nil
}

// sanitizeName cleans a client supplied file name. Illegal characters are
// replaced instead of rejected so drag and drop from Windows keeps working.
func sanitizeName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)
	name = strings.Map(func(r rune) rune {
		switch {
		case r < 0x20 || r == 0x7f:
			return -1
		case strings.ContainsRune("<>:\"/\\|?*", r):
			return '_'
		default:
			return r
		}
	}, name)
	name = strings.TrimRight(name, ". ")
	if name == "" || name == "." || name == ".." {
		return "", errors.New("文件名不合法")
	}
	if len(name) > 200 {
		return "", errors.New("文件名过长")
	}
	if isReservedName(name) {
		name = "_" + name
	}
	return name, nil
}

// isReservedName reports Windows device names, which cannot be created on a
// Windows host.
func isReservedName(name string) bool {
	base := strings.ToUpper(strings.TrimSuffix(name, path.Ext(name)))
	switch base {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(base) == 4 {
		switch base[:3] {
		case "COM", "LPT":
			if base[3] >= '1' && base[3] <= '9' {
				return true
			}
		}
	}
	return false
}

// shareTTLMinutes is the default share lifetime shown in the UI.
func shareTTLMinutes(files *model.FilesTgt) int {
	if files == nil || files.ShareTTLMin <= 0 {
		return int(DefaultShareTTL / time.Minute)
	}
	return files.ShareTTLMin
}

func isTrue(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on", "y":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
