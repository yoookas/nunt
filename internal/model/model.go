// Package model holds every persisted type of the application.
//
// The whole configuration lives in a single JSON document so that backup,
// restore and atomic updates stay trivial. Runtime state (running listeners,
// last DDNS result, ...) is deliberately kept out of this package.
package model

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"
)

// Web rule types.
const (
	WebTypeProxy    = "proxy"
	WebTypeRedirect = "redirect"
	WebTypeStatic   = "static"
	WebTypeFiles    = "filebrowser"
	WebTypeWebDAV   = "webdav"
)

// TLS modes for a web rule.
const (
	TLSModeOff    = "off"
	TLSModeAuto   = "auto"
	TLSModeCustom = "custom"
)

// Access control modes.
const (
	AccessOff   = "off"
	AccessAllow = "allow"
	AccessDeny  = "deny"
)

// Config is the root document.
type Config struct {
	Version int           `json:"version"`
	System  SystemConfig  `json:"system"`
	Users   []User        `json:"users"`
	Tokens  []APIToken    `json:"tokens,omitempty"`
	Web     WebConfig     `json:"web"`
	Forward ForwardConfig `json:"forward"`
	DDNS    DDNSConfig    `json:"ddns"`
	ACME    ACMEConfig    `json:"acme"`
	Storage StorageConfig `json:"storage"`
	WAF     WAFConfig     `json:"waf"`
	Tasks   TaskConfig    `json:"tasks"`
	Notify  NotifyConfig  `json:"notify"`
}

// SystemConfig holds global options.
type SystemConfig struct {
	AdminListen     string   `json:"adminListen"`
	AdminAllowIPs   []string `json:"adminAllowIps,omitempty"`
	TrustProxy      bool     `json:"trustProxy"`
	LogLevel        string   `json:"logLevel"`
	SessionTTLHours int      `json:"sessionTtlHours"`
	LoginMaxFail    int      `json:"loginMaxFail"`
	LoginLockMin    int      `json:"loginLockMinutes"`
	Theme           string   `json:"theme"`
	CheckUpdate     bool     `json:"checkUpdate"`
	BaseURL         string   `json:"baseUrl,omitempty"`
}

// User is an administrator account.
type User struct {
	ID                 string     `json:"id"`
	Username           string     `json:"username"`
	PasswordHash       string     `json:"passwordHash,omitempty"`
	Role               string     `json:"role"`
	Enabled            bool       `json:"enabled"`
	MustChangePassword bool       `json:"mustChangePassword"`
	CreatedAt          time.Time  `json:"createdAt"`
	LastLogin          *time.Time `json:"lastLogin,omitempty"`
}

// APIToken is an open API credential (the plain token is shown once).
type APIToken struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	TokenHash string     `json:"tokenHash,omitempty"`
	Scopes    []string   `json:"scopes,omitempty"`
	Enabled   bool       `json:"enabled"`
	CreatedAt time.Time  `json:"createdAt"`
	LastUsed  *time.Time `json:"lastUsed,omitempty"`
}

// ---------------------------------------------------------------------------
// Web service (reverse proxy, redirect, static, file browser, webdav)
// ---------------------------------------------------------------------------

// WebConfig is the web service module configuration.
type WebConfig struct {
	Rules     []WebRule `json:"rules"`
	AccessLog bool      `json:"accessLog"`
	LogKeep   int       `json:"logKeep"`
	RealIP    bool      `json:"realIp"`
}

// WebRule routes one logical site/route.
type WebRule struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Enable    bool         `json:"enable"`
	Type      string       `json:"type"`
	Listen    []string     `json:"listen"`
	Domains   []string     `json:"domains,omitempty"`
	Path      string       `json:"path"`
	Priority  int          `json:"priority"`
	TLS       WebTLS       `json:"tls"`
	WAF       bool         `json:"waf"`
	Access    Access       `json:"access"`
	BasicAuth *BasicAuth   `json:"basicAuth,omitempty"`
	Proxy     *ProxyTarget `json:"proxy,omitempty"`
	Redirect  *RedirectTgt `json:"redirect,omitempty"`
	Static    *StaticTgt   `json:"static,omitempty"`
	Files     *FilesTgt    `json:"files,omitempty"`
	Remark    string       `json:"remark,omitempty"`
	CreatedAt time.Time    `json:"createdAt"`
	UpdatedAt time.Time    `json:"updatedAt"`
}

// WebTLS describes how a rule terminates TLS.
type WebTLS struct {
	Mode   string `json:"mode"`
	CertID string `json:"certId,omitempty"`
	HSTS   bool   `json:"hsts"`
}

// Access is an IP / User-Agent filter.
type Access struct {
	Mode   string   `json:"mode"`
	IPs    []string `json:"ips,omitempty"`
	UAMode string   `json:"uaMode,omitempty"`
	UAs    []string `json:"uas,omitempty"`
}

// BasicAuth guards a rule with HTTP basic authentication.
type BasicAuth struct {
	Enable bool            `json:"enable"`
	Users  []BasicAuthUser `json:"users,omitempty"`
}

// BasicAuthUser stores an argon2id hash.
type BasicAuthUser struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// ProxyTarget is a reverse proxy upstream definition.
type ProxyTarget struct {
	Targets        []string          `json:"targets"`
	Balance        string            `json:"balance,omitempty"`
	HostHeader     string            `json:"hostHeader,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	RespHeaders    map[string]string `json:"respHeaders,omitempty"`
	PathPrefix     string            `json:"pathPrefix,omitempty"`
	PathReplace    string            `json:"pathReplace,omitempty"`
	TimeoutSec     int               `json:"timeoutSec,omitempty"`
	InsecureTLS    bool              `json:"insecureTls,omitempty"`
	DisableCompres bool              `json:"disableCompression,omitempty"`
	// H2C talks cleartext HTTP/2 to a plain http:// upstream, which is what
	// native gRPC servers expect.
	H2C bool `json:"h2c,omitempty"`
	// RateLimitPerSec caps the requests per second of one client address on
	// this rule. Zero (the default) means the rule is not throttled, so an
	// existing configuration keeps its behaviour.
	RateLimitPerSec int `json:"rateLimitPerSec,omitempty"`
	// MaxBodyBytes caps the size of a request body the rule forwards. Zero (the
	// default) means the body size is not limited.
	MaxBodyBytes int64 `json:"maxBodyBytes,omitempty"`
}

// RedirectTgt is a redirect / URL rewrite definition.
type RedirectTgt struct {
	To       string `json:"to"`
	Status   int    `json:"status"`
	KeepPath bool   `json:"keepPath"`
}

// StaticTgt serves a directory (or mounted storage) as static files.
type StaticTgt struct {
	Root         string   `json:"root,omitempty"`
	MountID      string   `json:"mountId,omitempty"`
	Index        []string `json:"index,omitempty"`
	Listing      bool     `json:"listing"`
	SPA          bool     `json:"spa"`
	CacheSeconds int      `json:"cacheSeconds,omitempty"`
}

// FilesTgt configures the built-in file browser / WebDAV endpoints.
type FilesTgt struct {
	MountID     string `json:"mountId,omitempty"`
	Root        string `json:"root,omitempty"`
	ReadOnly    bool   `json:"readOnly"`
	AllowUpload bool   `json:"allowUpload"`
	AllowDelete bool   `json:"allowDelete"`
	AllowMkdir  bool   `json:"allowMkdir"`
	AllowRename bool   `json:"allowRename"`
	ShowHidden  bool   `json:"showHidden"`
	ShareLinks  bool   `json:"shareLinks"`
	ShareTTLMin int    `json:"shareTtlMinutes,omitempty"`
	Title       string `json:"title,omitempty"`
}

// ---------------------------------------------------------------------------
// Port forwarding
// ---------------------------------------------------------------------------

// ForwardConfig is the port forward module configuration.
type ForwardConfig struct {
	Rules     []ForwardRule `json:"rules"`
	AccessLog bool          `json:"accessLog"`
}

// ForwardRule forwards TCP/UDP traffic from SrcAddr to DstAddr.
type ForwardRule struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Enable     bool   `json:"enable"`
	Protocol   string `json:"protocol"`
	SrcAddr    string `json:"srcAddr"`
	DstAddr    string `json:"dstAddr"`
	Access     Access `json:"access"`
	TimeoutSec int    `json:"timeoutSec,omitempty"`
	// MaxConns caps the concurrent connections the rule relays. Zero means the
	// rule does not cap its connections; a stored configuration is normalised
	// to a sane default.
	MaxConns int `json:"maxConns,omitempty"`
	// MaxConnsPerIP caps the concurrent connections a single client address may
	// open on the rule. Zero means the rule does not cap them per address.
	MaxConnsPerIP int       `json:"maxConnsPerIP,omitempty"`
	Remark        string    `json:"remark,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// ---------------------------------------------------------------------------
// DDNS
// ---------------------------------------------------------------------------

// DDNSConfig is the dynamic DNS module configuration.
type DDNSConfig struct {
	Rules []DDNSRule `json:"rules"`
}

// DDNSRule keeps one host up to date.
type DDNSRule struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Enable      bool              `json:"enable"`
	Provider    string            `json:"provider"`
	Creds       map[string]string `json:"creds,omitempty"`
	Domain      string            `json:"domain"`
	SubDomains  []string          `json:"subDomains"`
	RecordType  string            `json:"recordType"`
	TTL         int               `json:"ttl,omitempty"`
	IPv4        GetIP             `json:"ipv4"`
	IPv6        GetIP             `json:"ipv6"`
	IntervalSec int               `json:"intervalSec,omitempty"`
	Cron        string            `json:"cron,omitempty"`
	Callback    *CustomCallback   `json:"callback,omitempty"`
	Remark      string            `json:"remark,omitempty"`
	CreatedAt   time.Time         `json:"createdAt"`
	UpdatedAt   time.Time         `json:"updatedAt"`
}

// GetIP describes how the public address is discovered.
type GetIP struct {
	Enable bool   `json:"enable"`
	Mode   string `json:"mode"` // interface | url | static
	Value  string `json:"value,omitempty"`
	Iface  string `json:"iface,omitempty"`
	Regex  string `json:"regex,omitempty"`
}

// CustomCallback implements the "custom provider" escape hatch.
type CustomCallback struct {
	Enable      bool              `json:"enable"`
	URL         string            `json:"url"`
	Method      string            `json:"method"`
	Headers     map[string]string `json:"headers,omitempty"`
	Body        string            `json:"body,omitempty"`
	BasicUser   string            `json:"basicUser,omitempty"`
	BasicPass   string            `json:"basicPass,omitempty"`
	ContentType string            `json:"contentType,omitempty"`
	SuccessCode []int             `json:"successCode,omitempty"`
}

// ---------------------------------------------------------------------------
// ACME
// ---------------------------------------------------------------------------

// ACMEConfig is the certificate module configuration.
type ACMEConfig struct {
	Email       string    `json:"email"`
	CA          string    `json:"ca"`
	CACustomURL string    `json:"caCustomUrl,omitempty"`
	KeyType     string    `json:"keyType"`
	Jobs        []CertJob `json:"jobs"`
}

// CertJob is one certificate to keep issued and renewed.
type CertJob struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Enable       bool              `json:"enable"`
	Domains      []string          `json:"domains"`
	KeyType      string            `json:"keyType,omitempty"`
	Challenge    string            `json:"challenge"`
	DNSProvider  string            `json:"dnsProvider,omitempty"`
	DNSCreds     map[string]string `json:"dnsCreds,omitempty"`
	DNSResolvers []string          `json:"dnsResolvers,omitempty"`
	RenewDays    int               `json:"renewDays,omitempty"`
	Remark       string            `json:"remark,omitempty"`
	CreatedAt    time.Time         `json:"createdAt"`
}

// ---------------------------------------------------------------------------
// Storage mounts
// ---------------------------------------------------------------------------

// StorageConfig holds the mounts shared by static/files/webdav rules.
type StorageConfig struct {
	Mounts []Mount `json:"mounts"`
}

// Mount types.
const (
	MountLocal  = "local"
	MountWebDAV = "webdav"
)

// Mount is a storage backend addressable by id.
type Mount struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Enable      bool      `json:"enable"`
	Type        string    `json:"type"`
	Root        string    `json:"root,omitempty"`
	URL         string    `json:"url,omitempty"`
	Username    string    `json:"username,omitempty"`
	Password    string    `json:"password,omitempty"`
	InsecureTLS bool      `json:"insecureTls,omitempty"`
	ReadOnly    bool      `json:"readOnly"`
	Remark      string    `json:"remark,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

// ---------------------------------------------------------------------------
// WAF
// ---------------------------------------------------------------------------

// WAF modes.
const (
	WAFModeDetect = "detect"
	WAFModeBlock  = "block"
)

// WAFConfig configures the embedded Coraza engine.
type WAFConfig struct {
	Enable            bool     `json:"enable"`
	Mode              string   `json:"mode"`
	UseCRS            bool     `json:"useCrs"`
	ParanoiaLevel     int      `json:"paranoiaLevel"`
	ExecutingLevel    int      `json:"executingLevel,omitempty"`
	InboundThreshold  int      `json:"inboundThreshold,omitempty"`
	OutboundThreshold int      `json:"outboundThreshold,omitempty"`
	DisabledRules     []string `json:"disabledRules,omitempty"`
	RuleFiles         []string `json:"ruleFiles,omitempty"`
	ExtraRules        string   `json:"extraRules,omitempty"`
	AdminProtect      bool     `json:"adminProtect"`
	BodyLimitKB       int      `json:"bodyLimitKb,omitempty"`
	LogOnly           bool     `json:"logOnly,omitempty"`
}

// ---------------------------------------------------------------------------
// Scheduled tasks & notifications
// ---------------------------------------------------------------------------

// TaskConfig is the scheduler configuration.
type TaskConfig struct {
	Items []Task `json:"items"`
	// AllowShell must be enabled explicitly before a "shell.exec" task action
	// may run; every other action type works without it.
	AllowShell bool `json:"allowShell"`
}

// Task is one cron scheduled job.
type Task struct {
	ID      string       `json:"id"`
	Name    string       `json:"name"`
	Enable  bool         `json:"enable"`
	Cron    string       `json:"cron"`
	Actions []TaskAction `json:"actions"`
	Remark  string       `json:"remark,omitempty"`
}

// Task action types.
const (
	ActionModuleToggle = "module.toggle"
	ActionRuleToggle   = "rule.toggle"
	ActionHTTP         = "http.request"
	ActionShell        = "shell.exec"
	ActionNotify       = "notify.webhook"
)

// TaskAction is a single step of a task.
type TaskAction struct {
	Type    string            `json:"type"`
	Target  string            `json:"target,omitempty"`
	Value   string            `json:"value,omitempty"`
	URL     string            `json:"url,omitempty"`
	Method  string            `json:"method,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
	Command string            `json:"command,omitempty"`
}

// NotifyConfig holds outbound notification targets.
type NotifyConfig struct {
	Webhooks []Webhook `json:"webhooks,omitempty"`
}

// Webhook is a generic notification endpoint (JSON POST).
type Webhook struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Enable  bool              `json:"enable"`
	URL     string            `json:"url"`
	Method  string            `json:"method,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Events  []string          `json:"events,omitempty"`
}

// NewID returns a short random identifier.
func NewID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(b[:])
}

// NormalizePath makes sure a rule path starts with "/" and has no trailing
// slash (except for the root path).
func NormalizePath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return "/"
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if len(p) > 1 {
		p = strings.TrimSuffix(p, "/")
	}
	if p == "" {
		return "/"
	}
	return p
}
