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
)

// Client certificate modes for a TLS listener.
const (
	ClientAuthOff     = "off"
	ClientAuthRequest = "request"
	ClientAuthRequire = "require"
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
	Web     WebConfig     `json:"web"`
	Forward ForwardConfig `json:"forward"`
	DDNS    DDNSConfig    `json:"ddns"`
	ACME    ACMEConfig    `json:"acme"`
	WAF     WAFConfig     `json:"waf"`
	Logs    LogConfig     `json:"logs"`
	Backup  BackupConfig  `json:"backup"`
}

// BackupConfig controls the periodic archive of the data directory.
type BackupConfig struct {
	// Enabled turns the scheduled archive on. It is off by default: writing
	// archives to disk is something the operator should choose.
	Enabled bool `json:"enabled"`
	// IntervalHours is how often an archive is written (default 24).
	IntervalHours int `json:"intervalHours"`
	// Keep is how many archives are kept (default 7).
	Keep int `json:"keep"`
	// Dir overrides where archives are written (default <dataDir>/backups).
	Dir string `json:"dir,omitempty"`
}

// LogConfig holds the retention settings of both log streams.
type LogConfig struct {
	// Access is the persistent access log (web, port forward and WAF).
	Access AccessLogConfig `json:"access"`
	// App is the process log written to <dataDir>/logs/nunt.log.
	App AppLogConfig `json:"app"`
}

// AccessLogConfig controls how access records are stored on disk. The in
// memory ring buffers of the modules are independent of it.
type AccessLogConfig struct {
	// Persist keeps the records on disk. Turning it off stops writing but
	// keeps whatever is already stored.
	Persist   bool `json:"persist"`
	KeepDays  int  `json:"keepDays"`
	MaxFileMB int  `json:"maxFileMb"`
}

// AppLogConfig controls the rotation of the process log file.
type AppLogConfig struct {
	MaxFileMB int `json:"maxFileMb"`
	KeepFiles int `json:"keepFiles"`
}

// SystemConfig holds global options.
type SystemConfig struct {
	AdminListen     string   `json:"adminListen"`
	AdminAllowIPs   []string `json:"adminAllowIps,omitempty"`
	TrustProxy      bool     `json:"trustProxy"`
	LogLevel        string   `json:"logLevel"`
	SessionTTLHours int      `json:"sessionTtlHours"`
	LoginMaxFail    int      `json:"loginMaxFail"`
	// SessionBindIP also binds a browser session to the client address it was
	// created from. It is off by default because clients on mobile networks
	// change address often; the user agent is always compared.
	SessionBindIP bool   `json:"sessionBindIp,omitempty"`
	LoginLockMin  int    `json:"loginLockMinutes"`
	Theme         string `json:"theme"`
	BaseURL       string `json:"baseUrl,omitempty"`
	// IP2RegionDB is the path of the ip2region xdb database used by the
	// country/province access filters.
	IP2RegionDB string `json:"ip2regionDb,omitempty"`
}

// User is the single administrator account. There is no user name: the
// deployment has exactly one password (plus an optional second factor).
type User struct {
	ID                 string     `json:"id"`
	PasswordHash       string     `json:"passwordHash,omitempty"`
	MustChangePassword bool       `json:"mustChangePassword"`
	CreatedAt          time.Time  `json:"createdAt"`
	LastLogin          *time.Time `json:"lastLogin,omitempty"`
	TOTP               TOTP       `json:"totp,omitempty"`
}

// TOTP is the second factor of one account. The secret is sealed with the
// deployment key before it is written, so config.json never holds a usable
// seed; the recovery codes are stored as SHA-256 hashes.
type TOTP struct {
	Enabled bool   `json:"enabled"`
	Secret  string `json:"secret,omitempty"`
	// Codes are one-time recovery codes (SHA-256 hex), each removed on use.
	Codes []string `json:"codes,omitempty"`
	// EnrolledAt records when the factor was confirmed.
	EnrolledAt *time.Time `json:"enrolledAt,omitempty"`
	// LastStep is the last accepted time step, which makes a code single use
	// even inside its 30 second window.
	LastStep int64 `json:"lastStep,omitempty"`
}

// ---------------------------------------------------------------------------
// Web service (reverse proxy, redirect, static)
// ---------------------------------------------------------------------------

// WebConfig is the web service module configuration.
type WebConfig struct {
	// Listeners own the sockets and TLS settings; routes attach to them by ID.
	Listeners []WebListener `json:"listeners"`
	Rules     []WebRule     `json:"rules"`
	AccessLog bool          `json:"accessLog"`
	LogKeep   int           `json:"logKeep"`
}

// WebListener is one set of sockets and its TLS configuration. Every route
// below it shares the same listen addresses and TLS mode.
type WebListener struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Disabled marks a listener that was stopped, for example because its
	// port is already taken. It is skipped until the operator enables it.
	Disabled  bool      `json:"disabled,omitempty"`
	Listen    []string  `json:"listen"`
	TLS       WebTLS    `json:"tls"`
	Remark    string    `json:"remark,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// WebRule routes one logical site/route.
type WebRule struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Enable bool   `json:"enable"`
	Type   string `json:"type"`
	// ListenerID selects the WebListener that owns the sockets and TLS
	// settings of this route.
	ListenerID string       `json:"listenerId"`
	Domains    []string     `json:"domains,omitempty"`
	Path       string       `json:"path"`
	Priority   int          `json:"priority"`
	WAF        bool         `json:"waf"`
	Access     Access       `json:"access"`
	BasicAuth  *BasicAuth   `json:"basicAuth,omitempty"`
	Proxy      *ProxyTarget `json:"proxy,omitempty"`
	Redirect   *RedirectTgt `json:"redirect,omitempty"`
	Static     *StaticTgt   `json:"static,omitempty"`
	Remark     string       `json:"remark,omitempty"`
	CreatedAt  time.Time    `json:"createdAt"`
	UpdatedAt  time.Time    `json:"updatedAt"`
}

// WebTLS describes how a rule terminates TLS.
type WebTLS struct {
	Mode   string `json:"mode"`
	CertID string `json:"certId,omitempty"`
	HSTS   bool   `json:"hsts"`
	// ClientAuth is off, request or require. "require" only completes the
	// handshake for a certificate signed by ClientCA.
	ClientAuth string `json:"clientAuth,omitempty"`
	// ClientCA is the PEM bundle that signs client certificates. It may hold
	// multiple certificates.
	ClientCA string `json:"clientCa,omitempty"`
}

// Access is an IP / User-Agent filter.
type Access struct {
	Mode string   `json:"mode"`
	IPs  []string `json:"ips,omitempty"`
	// Countries and Provinces are matched against the ip2region database and
	// combined with IPs as a union under the same mode.
	Countries []string `json:"countries,omitempty"`
	Provinces []string `json:"provinces,omitempty"`
	UAMode    string   `json:"uaMode,omitempty"`
	UAs       []string `json:"uas,omitempty"`
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
	// CORS answers cross-origin requests and preflight checks in front of the
	// upstream. Nil keeps the upstream in charge of its own CORS headers.
	CORS *CORS `json:"cors,omitempty"`
}

// CORS is the cross-origin policy of one proxy rule. Origins accepts exact
// origins ("https://app.example.com") or "*"; methods and headers are the
// values echoed to the preflight request.
type CORS struct {
	Origins     []string `json:"origins"`
	Methods     []string `json:"methods,omitempty"`
	Headers     []string `json:"headers,omitempty"`
	Credentials bool     `json:"credentials,omitempty"`
	MaxAge      int      `json:"maxAge,omitempty"`
}

// RedirectTgt is a redirect / URL rewrite definition.
type RedirectTgt struct {
	To       string `json:"to"`
	Status   int    `json:"status"`
	KeepPath bool   `json:"keepPath"`
}

// StaticTgt serves a local directory as static files.
type StaticTgt struct {
	Root         string   `json:"root,omitempty"`
	Index        []string `json:"index,omitempty"`
	Listing      bool     `json:"listing"`
	SPA          bool     `json:"spa"`
	CacheSeconds int      `json:"cacheSeconds,omitempty"`
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
	Email   string `json:"email"`
	KeyType string `json:"keyType"`
	// Staging switches the account and the orders to the Let's Encrypt staging
	// directory. The certificates it returns are not trusted by browsers; it
	// exists to debug a challenge without spending the production rate limits.
	Staging bool      `json:"staging,omitempty"`
	Jobs    []CertJob `json:"jobs"`
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
