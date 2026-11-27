package forward

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/nunt/nunt/internal/model"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestValidateRule(t *testing.T) {
	base := model.ForwardRule{Protocol: protoTCP, SrcAddr: "127.0.0.1:8080", DstAddr: "127.0.0.1:80"}
	if err := validateRule(base); err != nil {
		t.Fatalf("valid rule rejected: %v", err)
	}
	bad := base
	bad.Protocol = "icmp"
	if err := validateRule(bad); err == nil {
		t.Fatal("an unsupported protocol must be rejected")
	}
	bad = base
	bad.DstAddr = "no-port"
	if err := validateRule(bad); err == nil {
		t.Fatal("a destination without a port must be rejected")
	}
}

func TestRuleViewsCarryCounters(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)
	srcPort := freePort(t, "tcp")
	setRules(t, store, model.ForwardRule{
		ID: "r1", Name: "counted", Enable: true, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", srcPort), DstAddr: target,
	})

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	if err := pingForwarder(srcPort); err != nil {
		t.Fatalf("forwarder not reachable: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		views := f.ruleViews()
		if len(views) == 1 && views[0].TotalConns > 0 && views[0].UpBytes > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("counters did not move: %+v", views)
		}
		time.Sleep(10 * time.Millisecond)
	}

	views := f.ruleViews()
	if !views[0].Listening {
		t.Fatal("the rule is not reported as listening")
	}

	// Listing through the handler must return the same enriched view.
	rec := httptest.NewRecorder()
	f.handleListRules(rec, httptest.NewRequest(http.MethodGet, "/api/v1/forward/rules", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}
	var listed []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("listed %d rules, want 1", len(listed))
	}
	if _, ok := listed[0]["activeConns"]; !ok {
		t.Fatalf("the list response has no per rule counters: %v", listed[0])
	}
	if _, ok := listed[0]["srcAddr"]; !ok {
		t.Fatalf("the embedded rule fields were lost: %v", listed[0])
	}
}

// Editing the access rule has to change the proxy fingerprint: a rule that keeps
// its old fingerprint never gets rebuilt, so the forwarded port would keep using
// the previous filter. The order of the entries changes the verdict too, so it
// must not be sorted away.
func TestFingerprintTracksTheAccessRule(t *testing.T) {
	base := model.ForwardRule{Protocol: "tcp", SrcAddr: ":8080", DstAddr: "10.0.0.1:80"}
	withAccess := func(entries ...model.AccessEntry) model.ForwardRule {
		rule := base
		rule.Access = model.Access{
			Mode: model.AccessRules,
			IP:   model.AccessList{Rest: model.AccessDeny, Entries: entries},
			UA:   model.AccessList{Rest: model.AccessAllow},
		}
		return rule
	}

	allow := withAccess(model.AccessEntry{Action: model.AccessAllow, Kind: model.AccessKindIP, Value: "10.0.0.0/8"})
	changed := withAccess(model.AccessEntry{Action: model.AccessAllow, Kind: model.AccessKindIP, Value: "10.1.0.0/16"})
	reordered := withAccess(
		model.AccessEntry{Action: model.AccessDeny, Kind: model.AccessKindIP, Value: "10.0.0.66/32"},
		model.AccessEntry{Action: model.AccessAllow, Kind: model.AccessKindIP, Value: "10.0.0.0/8"},
	)
	same := withAccess(model.AccessEntry{Action: model.AccessAllow, Kind: model.AccessKindIP, Value: "10.0.0.0/8"})

	if fingerprint(allow) != fingerprint(same) {
		t.Fatal("identical rules must share a fingerprint")
	}
	if fingerprint(allow) == fingerprint(changed) {
		t.Fatal("a changed entry must change the fingerprint")
	}
	if fingerprint(allow) == fingerprint(reordered) {
		t.Fatal("the entry order must be part of the fingerprint")
	}
}
