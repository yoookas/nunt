// Package waf wraps the Coraza engine used to protect the web service.
package waf

import (
	"bufio"
	"bytes"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	coreruleset "github.com/corazawaf/coraza-coreruleset/v4"
)

// Names inside the embedded CORERULESET file system.
const (
	crsRootDir        = "@owasp_crs"
	crsRecommendedCfg = "@coraza.conf-recommended"
	crsSetupCfg       = "@crs-setup.conf.example"
)

// ruleFile is one SecLang file that can be loaded into the engine.
type ruleFile struct {
	// File is the path handed to the SecLang "Include" directive.
	File string `json:"file"`
	// Name is the base file name without directory.
	Name string `json:"name"`
	// Group is "request", "response" or "setup".
	Group string `json:"group"`
	// Title is the short Chinese label shown in the UI.
	Title string `json:"title"`
	// TitleEn is the English description taken from the file name.
	TitleEn string `json:"titleEn,omitempty"`
	// Tag is the most specific OWASP_CRS tag found in the file.
	Tag string `json:"tag,omitempty"`
	// Rules is the number of SecRule/SecAction directives in the file.
	Rules int `json:"rules"`
	// MinID and MaxID bound the rule ids of the file; the range can be added
	// to DisabledRules to switch the whole file off.
	MinID int `json:"minId,omitempty"`
	MaxID int `json:"maxId,omitempty"`
	// DisableRange is the value to put in DisabledRules to disable the file.
	DisableRange string `json:"disableRange,omitempty"`
	// Required marks files that cannot be disabled individually.
	Required bool `json:"required,omitempty"`
	// Builtin is false for files loaded from disk.
	Builtin bool `json:"builtin"`
}

// idRange returns the inclusive rule id range covered by the file.
func (f ruleFile) idRange() (int, int) { return f.MinID, f.MaxID }

// crsTitles maps the CRS rule file number to a short Chinese label.
var crsTitles = map[string]string{
	"901": "初始化与默认值",
	"905": "通用例外（前置）",
	"911": "请求方法限制",
	"913": "扫描器检测",
	"920": "协议约束",
	"921": "协议攻击",
	"922": "多部分请求攻击",
	"930": "本地文件包含（LFI）",
	"931": "远程文件包含（RFI）",
	"932": "命令注入（RCE）",
	"933": "PHP 注入",
	"934": "通用攻击检测",
	"941": "XSS 跨站脚本",
	"942": "SQL 注入",
	"943": "会话固定",
	"944": "Java 攻击",
	"949": "入站阻断评估",
	"999": "通用例外（后置）",
	"950": "数据泄露",
	"951": "SQL 错误泄露",
	"952": "Java 错误泄露",
	"953": "PHP 错误泄露",
	"954": "IIS 错误泄露",
	"955": "WebShell 上传",
	"956": "Ruby 错误泄露",
	"959": "出站阻断评估",
	"980": "关联事件",
}

var (
	fileNameRe   = regexp.MustCompile(`^([A-Z]+)-([0-9]{3})-([A-Z0-9-]+)\.conf$`)
	ruleIDRe     = regexp.MustCompile(`(?:^|,)\s*id:'?([0-9]{1,9})'?`)
	ruleLineRe   = regexp.MustCompile(`(?m)^\s*Sec(Rule|Action|Marker)\b`)
	crsTagRe     = regexp.MustCompile(`tag:'OWASP_CRS/([A-Za-z0-9_./-]+)'`)
	crsVersionRe = regexp.MustCompile(`OWASP CRS ver\.([0-9]+\.[0-9]+\.[0-9]+)`)
)

// firstCommentTitle returns the first meaningful comment line of a rule file.
// Boilerplate lines (separators, copyright and licence notices) are skipped.
func firstCommentTitle(data []byte) string {
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64*1024), 64*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || !strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimLeft(line, "#"))
		line = strings.Trim(line, "-= ")
		if line == "" || strings.HasPrefix(line, "Copyright") || strings.HasPrefix(line, "OWASP") {
			continue
		}
		return truncate(line, 80)
	}
	return ""
}

// crsVersionOf extracts the CRS version from the header comment of a rule file.
func crsVersionOf(data []byte) string {
	if m := crsVersionRe.FindSubmatch(data); m != nil {
		return string(m[1])
	}
	return ""
}

// describeRuleFile fills the derived fields of one SecLang file.
func describeRuleFile(file, name string, data []byte, builtin bool) ruleFile {
	out := ruleFile{File: file, Name: name, Builtin: builtin}
	if m := fileNameRe.FindStringSubmatch(name); m != nil {
		switch m[1] {
		case "REQUEST":
			out.Group = "request"
		case "RESPONSE":
			out.Group = "response"
		}
		out.Title = crsTitles[m[2]]
		out.TitleEn = strings.Join(strings.Split(strings.ToLower(m[3]), "-"), " ")
		if out.Title == "" {
			out.Title = m[3]
		}
		if start, err := strconv.Atoi(m[2] + "000"); err == nil {
			out.MinID, out.MaxID = start, start+999
			out.DisableRange = fmt.Sprintf("%d-%d", out.MinID, out.MaxID)
		}
	}
	if out.Title == "" {
		// Custom rule files carry no CRS naming convention: fall back to the
		// first meaningful comment line.
		if title := firstCommentTitle(data); title != "" {
			out.Title = title
		} else {
			out.Title = name
		}
	}
	if m := crsTagRe.FindSubmatch(data); m != nil {
		out.Tag = string(m[1])
	}
	out.Rules = len(ruleLineRe.FindAllIndex(data, -1))
	min, max := 0, 0
	for _, m := range ruleIDRe.FindAllSubmatch(data, -1) {
		id, err := strconv.Atoi(string(m[1]))
		if err != nil || id <= 0 {
			continue
		}
		if min == 0 || id < min {
			min = id
		}
		if id > max {
			max = id
		}
	}
	if out.MinID == 0 {
		out.MinID, out.MaxID = min, max
		if min > 0 && max > 0 {
			out.DisableRange = fmt.Sprintf("%d-%d", min, max)
		}
	}
	return out
}

// builtinRuleFiles lists the rule files shipped inside the binary, in the order
// CRS expects them: base configuration, setup template, request rules and
// finally the response rules. The second result is the CRS version.
func builtinRuleFiles() ([]ruleFile, string, error) {
	var out []ruleFile
	version := ""

	base, err := fs.ReadFile(coreruleset.FS, crsRecommendedCfg)
	if err != nil {
		return nil, "", fmt.Errorf("reading %s: %w", crsRecommendedCfg, err)
	}
	setup, err := fs.ReadFile(coreruleset.FS, crsSetupCfg)
	if err != nil {
		return nil, "", fmt.Errorf("reading %s: %w", crsSetupCfg, err)
	}
	baseFile := describeRuleFile(crsRecommendedCfg, crsRecommendedCfg, base, true)
	baseFile.Group, baseFile.Title, baseFile.TitleEn = "setup", "Coraza 基础配置", "coraza recommended configuration"
	baseFile.Required, baseFile.DisableRange = true, ""
	setupFile := describeRuleFile(crsSetupCfg, crsSetupCfg, setup, true)
	setupFile.Group, setupFile.Title, setupFile.TitleEn = "setup", "CRS 参数模板", "crs setup template"
	setupFile.Required, setupFile.DisableRange = true, ""
	out = append(out, baseFile, setupFile)

	names, err := fs.Glob(coreruleset.FS, crsRootDir+"/*.conf")
	if err != nil {
		return nil, "", fmt.Errorf("listing %s: %w", crsRootDir, err)
	}
	sort.Strings(names)
	for _, name := range names {
		data, err := fs.ReadFile(coreruleset.FS, name)
		if err != nil {
			return nil, "", fmt.Errorf("reading %s: %w", name, err)
		}
		if v := crsVersionOf(data); v != "" && version == "" {
			version = v
		}
		out = append(out, describeRuleFile(name, path.Base(name), data, true))
	}
	if len(out) <= 2 {
		return nil, "", fmt.Errorf("the embedded rule set is empty")
	}
	return out, version, nil
}
