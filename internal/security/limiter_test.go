package security

import (
	"testing"
	"time"
)

func TestLimiterConfigureAtRuntime(t *testing.T) {
	l := NewLimiter(5, time.Minute, time.Hour)
	l.Configure(1, time.Minute)
	if wait := l.Fail("k"); wait <= 0 {
		t.Fatal("the new limit was not applied")
	}
	if ok, _ := l.Allow("k"); ok {
		t.Fatal("the key must be locked after one failure with maxFails=1")
	}
}
