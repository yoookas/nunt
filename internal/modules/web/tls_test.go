package web

import (
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"testing"
)

// A listener that requires a client certificate must not start when its CA
// bundle cannot be parsed.
func TestMTLSRequiresAValidCA(t *testing.T) {
	w := &Web{deps: &module.Deps{}}
	cfg := &model.Config{Web: model.WebConfig{
		Listeners: []model.WebListener{{
			ID:     "l1",
			Name:   "mtls",
			Listen: []string{":18443"},
			TLS:    model.WebTLS{Mode: model.TLSModeOff, ClientAuth: model.ClientAuthRequire, ClientCA: "not a pem"},
		}},
	}}
	_, plans, errs := w.compileWeb(cfg)
	if len(errs) == 0 {
		t.Fatal("an invalid client CA must be reported")
	}
	if _, ok := plans[":18443"]; ok {
		t.Fatal("the listener must not start without client certificate verification")
	}
}
