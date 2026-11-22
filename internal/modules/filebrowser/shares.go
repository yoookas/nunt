package filebrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/store"
	"github.com/nunt/nunt/internal/vfs"
)

// DefaultShareTTL is used when neither the request nor the rule sets a value.
const DefaultShareTTL = 24 * time.Hour

// maxShareTTL keeps a link from being created "forever" by accident.
const maxShareTTL = 365 * 24 * time.Hour

// Share is one public read-only link to a file or directory of a rule.
type Share struct {
	Token         string     `json:"token"`
	RuleID        string     `json:"ruleId"`
	Path          string     `json:"path"`
	AllowDownload bool       `json:"allowDownload"`
	CreatedAt     time.Time  `json:"createdAt"`
	ExpiresAt     time.Time  `json:"expiresAt"`
	Hits          int64      `json:"hits"`
	LastUsedAt    *time.Time `json:"lastUsedAt,omitempty"`
	// URL is filled in by the API; it is not persisted.
	URL string `json:"url,omitempty"`
}

// Expired reports whether the share is past its expiry.
func (s Share) Expired(now time.Time) bool {
	return !s.ExpiresAt.IsZero() && !now.Before(s.ExpiresAt)
}

// shareFile is the on disk representation of one rule's share list.
type shareFile struct {
	RuleID string  `json:"ruleId"`
	Shares []Share `json:"shares"`
}

// shareStore persists the shares of a single rule in
// <DataDir>/shares/<ruleId>.json with an atomic replace.
type shareStore struct {
	mu     sync.Mutex
	dir    string
	ruleID string
}

var (
	storeMu sync.Mutex
	stores  = map[string]*shareStore{}
)

// storeFor returns the (shared) store of a rule so that concurrent callers use
// the same lock.
func storeFor(dataDir, ruleID string) *shareStore {
	key := dataDir + "\x00" + ruleID
	storeMu.Lock()
	defer storeMu.Unlock()
	if st, ok := stores[key]; ok {
		return st
	}
	st := &shareStore{dir: sharesDir(dataDir), ruleID: ruleID}
	stores[key] = st
	return st
}

// sharesDir is the directory holding every rule's share file.
func sharesDir(dataDir string) string {
	if strings.TrimSpace(dataDir) == "" {
		dataDir = "."
	}
	return filepath.Join(dataDir, "shares")
}

// filePath is the JSON file of this rule. The rule id is sanitised because it
// ends up in a file name.
func (st *shareStore) filePath() string {
	return filepath.Join(st.dir, safeFileID(st.ruleID)+".json")
}

func safeFileID(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "rule"
	}
	if b.Len() > 64 {
		return b.String()[:64]
	}
	return b.String()
}

// load reads the active shares of the rule. Expired entries are dropped from
// the returned slice; the caller persists that cleanup on the next write.
func (st *shareStore) load(now time.Time) ([]Share, error) {
	var file shareFile
	err := store.ReadJSON(st.filePath(), &file)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read shares of rule %s: %w", st.ruleID, err)
	}
	out := make([]Share, 0, len(file.Shares))
	for _, sh := range file.Shares {
		if sh.Expired(now) {
			continue
		}
		sh.RuleID = st.ruleID
		out = append(out, sh)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (st *shareStore) save(shares []Share) error {
	if shares == nil {
		shares = []Share{}
	}
	file := shareFile{RuleID: st.ruleID, Shares: shares}
	if err := store.WriteJSONAtomic(st.filePath(), file, 0o600); err != nil {
		return fmt.Errorf("write shares of rule %s: %w", st.ruleID, err)
	}
	return nil
}

// list returns every active share of the rule.
func (st *shareStore) list() ([]Share, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.load(time.Now())
}

// add stores a new share, dropping expired entries on the way.
func (st *shareStore) add(share Share) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	shares, err := st.load(time.Now())
	if err != nil {
		return err
	}
	shares = append(shares, share)
	sort.Slice(shares, func(i, j int) bool { return shares[i].CreatedAt.After(shares[j].CreatedAt) })
	return st.save(shares)
}

// remove deletes one share by token and reports whether it existed.
func (st *shareStore) remove(token string) (bool, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	shares, err := st.load(time.Now())
	if err != nil {
		return false, err
	}
	out := shares[:0]
	found := false
	for _, sh := range shares {
		if security.ConstantTimeEqual(sh.Token, token) {
			found = true
			continue
		}
		out = append(out, sh)
	}
	if !found {
		return false, nil
	}
	return true, st.save(out)
}

// get resolves a token. Misses and expired links are reported as not found and
// expired entries are pruned from the file.
func (st *shareStore) get(token string) (Share, bool, error) {
	if token == "" {
		return Share{}, false, nil
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	shares, err := st.load(time.Now())
	if err != nil {
		return Share{}, false, err
	}
	now := time.Now()
	for i := range shares {
		if !security.ConstantTimeEqual(shares[i].Token, token) {
			continue
		}
		share := shares[i]
		// Update the usage counters at most once a minute: a public link may be
		// requested far more often than the file has to be rewritten.
		if share.LastUsedAt == nil || now.Sub(*share.LastUsedAt) > time.Minute {
			shares[i].Hits++
			last := now
			shares[i].LastUsedAt = &last
			if err := st.save(shares); err != nil {
				// Usage bookkeeping must never break a download.
				return share, true, nil
			}
			share.Hits = shares[i].Hits
			share.LastUsedAt = &last
		}
		return share, true, nil
	}
	// Persist the removal of expired entries when there was anything to prune.
	if len(shares) == 0 {
		if _, statErr := os.Stat(st.filePath()); statErr == nil {
			_ = st.save(nil)
		}
	}
	return Share{}, false, nil
}

// purgeExpired rewrites the file without the expired entries.
func (st *shareStore) purgeExpired() error {
	st.mu.Lock()
	defer st.mu.Unlock()
	shares, err := st.load(time.Now())
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(st.filePath()); statErr != nil && len(shares) == 0 {
		return nil
	}
	return st.save(shares)
}

// ---------------------------------------------------------------------------
// admin API
// ---------------------------------------------------------------------------

// registeredMuxes guards against mounting the share routes twice on the same
// mux (both the file manager and the WebDAV service offer RegisterAPI).
var registeredMuxes sync.Map

// RegisterFilesAPI mounts the storage helper endpoints below /api/v1/files:
// the share link management and the direct mount download. It is idempotent
// per mux, so both the file browser and the WebDAV service may call it.
func RegisterFilesAPI(mux *rest.Mux, deps *module.Deps) {
	if mux == nil || deps == nil {
		return
	}
	if _, loaded := registeredMuxes.LoadOrStore(mux, struct{}{}); loaded {
		return
	}
	g := mux.Group("/api/v1/files")
	g.Get("/shares", func(w http.ResponseWriter, r *http.Request) {
		shares, err := listShares(r, deps, r.URL.Query().Get("rule"))
		if err != nil {
			rest.Fail(w, http.StatusInternalServerError, "%s", err.Error())
			return
		}
		rest.OK(w, map[string]any{"items": shares})
	})
	g.Post("/shares", func(w http.ResponseWriter, r *http.Request) {
		var req shareRequest
		if err := decodeJSON(w, r, &req); err != nil {
			rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
			return
		}
		rule, ok := findRule(deps, req.Rule)
		if !ok {
			rest.Fail(w, http.StatusNotFound, "the web rule does not exist")
			return
		}
		if rule.Files == nil || !rule.Files.ShareLinks {
			rest.Fail(w, http.StatusBadRequest, "share links are disabled for this rule")
			return
		}
		share, err := createShare(r.Context(), deps, rule, req)
		if err != nil {
			rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
			return
		}
		reload(deps)
		share.URL = absoluteShareURL(r, rule, share.Token)

		rest.OK(w, share)
	})
	g.Get("/download", mountDownload(deps))

	g.Delete("/shares/{token}", func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("token")
		removed := false
		for _, rule := range rulesWithFiles(deps) {
			ok, err := storeFor(deps.DataDir, rule.ID).remove(token)
			if err != nil {
				rest.Fail(w, http.StatusInternalServerError, "%s", err.Error())
				return
			}
			if ok {
				removed = true
				break
			}
		}
		if !removed {
			rest.Fail(w, http.StatusNotFound, "the share link does not exist")
			return
		}
		reload(deps)
		rest.NoContent(w)
	})
}

// shareRequest is the body of both the admin and the site share endpoint.
type shareRequest struct {
	Rule          string `json:"rule,omitempty"`
	Path          string `json:"path"`
	TTLMinutes    int    `json:"ttlMinutes,omitempty"`
	AllowDownload *bool  `json:"allowDownload,omitempty"`
}

// createShare validates the request and stores a new share record.
func createShare(ctx context.Context, deps *module.Deps, rule *model.WebRule, req shareRequest) (Share, error) {
	clean, err := vfs.Clean(req.Path)
	if err != nil {
		return Share{}, fmt.Errorf("invalid path")
	}
	if err := checkExists(ctx, deps, rule, clean); err != nil {
		return Share{}, err
	}
	token, err := security.RandomToken(16)
	if err != nil {
		return Share{}, fmt.Errorf("generate share token: %w", err)
	}
	ttl := shareTTL(rule.Files, req.TTLMinutes)
	allowDownload := true
	if req.AllowDownload != nil {
		allowDownload = *req.AllowDownload
	}
	now := time.Now()
	share := Share{
		Token:         token,
		RuleID:        rule.ID,
		Path:          clean,
		AllowDownload: allowDownload,
		CreatedAt:     now,
		ExpiresAt:     now.Add(ttl),
	}
	if err := storeFor(deps.DataDir, rule.ID).add(share); err != nil {
		return Share{}, err
	}
	share.URL = shareURL(rule, token)
	return share, nil
}

// checkExists verifies that the shared path is reachable inside the rule.
func checkExists(ctx context.Context, deps *module.Deps, rule *model.WebRule, clean string) error {
	fsys, _, _, release, err := openTarget(deps, rule)
	if err != nil {
		return err
	}
	defer release()
	if ctx == nil {
		ctx = context.Background()
	}
	if _, err := fsys.Stat(ctx, clean); err != nil {
		return fmt.Errorf("路径 %s 不存在", clean)
	}
	return nil
}

// shareTTL returns the requested lifetime, the rule default or the built in
// default, clamped to a sane maximum.
func shareTTL(files *model.FilesTgt, minutes int) time.Duration {
	if minutes <= 0 && files != nil {
		minutes = files.ShareTTLMin
	}
	ttl := DefaultShareTTL
	switch {
	case minutes > 0:
		ttl = time.Duration(minutes) * time.Minute
	case files != nil && files.ShareTTLMin > 0:
		ttl = time.Duration(files.ShareTTLMin) * time.Minute
	}
	if ttl > maxShareTTL {
		ttl = maxShareTTL
	}
	if ttl < time.Minute {
		ttl = time.Minute
	}
	return ttl
}

// shareURL builds the site relative link of a share.
func shareURL(rule *model.WebRule, token string) string {
	base := model.NormalizePath(rule.Path)
	if base == "/" {
		return "/_share/" + token
	}
	return base + "/_share/" + token
}

// findRule returns a web rule by id.
func findRule(deps *module.Deps, id string) (*model.WebRule, bool) {
	if deps == nil || deps.Cfg == nil || id == "" {
		return nil, false
	}
	cfg := deps.Cfg.Snapshot()
	for i := range cfg.Web.Rules {
		if cfg.Web.Rules[i].ID == id {
			rule := cfg.Web.Rules[i]
			return &rule, true
		}
	}
	return nil, false
}

// rulesWithFiles returns every rule that serves a file system.
func rulesWithFiles(deps *module.Deps) []*model.WebRule {
	if deps == nil || deps.Cfg == nil {
		return nil
	}
	cfg := deps.Cfg.Snapshot()
	out := make([]*model.WebRule, 0, len(cfg.Web.Rules))
	for i := range cfg.Web.Rules {
		if cfg.Web.Rules[i].Files == nil {
			continue
		}
		rule := cfg.Web.Rules[i]
		out = append(out, &rule)
	}
	return out
}

// listShares collects the shares of one rule or of every rule.
func listShares(req *http.Request, deps *module.Deps, ruleID string) ([]Share, error) {
	rules := rulesWithFiles(deps)
	out := []Share{}
	for _, rule := range rules {
		if ruleID != "" && rule.ID != ruleID {
			continue
		}
		shares, err := storeFor(deps.DataDir, rule.ID).list()
		if err != nil {
			return nil, err
		}
		for i := range shares {
			shares[i].URL = absoluteShareURL(req, rule, shares[i].Token)
			out = append(out, shares[i])
		}
	}
	return out, nil
}

// reload asks the registry to push the current configuration to every module.
// Share administration does not change the configuration, but the web module
// may cache per rule handlers, so a cheap idempotent reload keeps it fresh.
func reload(deps *module.Deps) {
	if deps == nil || deps.Registry == nil || deps.Cfg == nil {
		return
	}
	deps.Registry.Reload(deps.Cfg.Snapshot())
}

// mountDownload streams a file of a mount directly, without a web rule. The
// storage page of the admin UI uses it to look into a backend.
func mountDownload(deps *module.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mountID := strings.TrimSpace(r.URL.Query().Get("mount"))
		if mountID == "" {
			rest.Fail(w, http.StatusNotFound, "缺少 mount 参数")
			return
		}
		if deps.Mounts == nil {
			rest.Fail(w, http.StatusNotFound, "存储管理器不可用")
			return
		}
		fsys, _, release, err := deps.Mounts.Get(mountID)
		if err != nil {
			rest.Fail(w, http.StatusNotFound, "存储挂载不存在或不可用")
			return
		}
		defer release()
		clean, err := vfs.Clean(r.URL.Query().Get("path"))
		if err != nil {
			rest.Fail(w, http.StatusNotFound, "路径无效")
			return
		}
		entry, err := fsys.Stat(r.Context(), clean)
		if err != nil {
			rest.Fail(w, http.StatusNotFound, "路径不存在")
			return
		}
		if entry.Dir {
			rest.Fail(w, http.StatusBadRequest, "不能直接下载目录")
			return
		}
		start, length, partial, err := parseRange(r.Header.Get("Range"), entry.Size)
		if err != nil {
			w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(entry.Size, 10))
			rest.Fail(w, http.StatusRequestedRangeNotSatisfiable, "请求的字节范围无效")
			return
		}
		rc, entry, err := fsys.Open(r.Context(), clean, start, length)
		if err != nil {
			rest.Fail(w, http.StatusBadGateway, "读取文件失败")
			return
		}
		defer func() { _ = rc.Close() }()

		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Accept-Ranges", "bytes")
		h.Set("Content-Type", contentTypeOf(entry.Name))
		h.Set("Content-Disposition", contentDisposition(entry.Name, false))
		h.Set("Last-Modified", entry.ModTime.UTC().Format(http.TimeFormat))
		if partial {
			h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, entry.Size))
			h.Set("Content-Length", strconv.FormatInt(length, 10))
			w.WriteHeader(http.StatusPartialContent)
		} else {
			h.Set("Content-Length", strconv.FormatInt(entry.Size, 10))
			w.WriteHeader(http.StatusOK)
		}
		// The status line is already on the wire, so a read failure can only be
		// recorded by the caller.
		_, _ = io.Copy(w, rc)
	}
}

// absoluteShareURL builds the full link of a share from the host of the
// current request; it falls back to the site relative path when the host
// header looks unusable.
func absoluteShareURL(req *http.Request, rule *model.WebRule, token string) string {
	rel := shareURL(rule, token)
	if req == nil || !validHost(req.Host) {
		return rel
	}
	scheme := "http"
	if req.TLS != nil {
		scheme = "https"
	} else if proto := strings.TrimSpace(req.Header.Get("X-Forwarded-Proto")); strings.EqualFold(proto, "https") {
		scheme = "https"
	}
	return scheme + "://" + req.Host + rel
}

// validHost accepts a host[:port] value that is safe to embed in a URL.
func validHost(host string) bool {
	if host == "" || len(host) > 255 {
		return false
	}
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '-' || r == ':' || r == '[' || r == ']' || r == '_':
		default:
			return false
		}
	}
	return true
}

// decodeJSON reads a JSON request body while ignoring unknown fields, so a
// newer frontend cannot break an older backend.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	if r.Body == nil {
		return errors.New("请求体为空")
	}
	if ct := r.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(strings.ToLower(ct), "application/json") {
		return fmt.Errorf("不支持的 Content-Type %q", ct)
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, rest.MaxBodyBytes))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("请求体解析失败: %w", err)
	}
	return nil
}
