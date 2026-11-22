package dnsprov

import (
	"strings"
	"testing"
)

// An ACME dns-01 validation publishes one TXT value per challenge; setting a
// new value must keep the pending ones alive.
func TestMergeTXTRecords(t *testing.T) {
	if got := mergeTXTRecords(nil, "abc"); len(got) != 1 || got[0] != "abc" {
		t.Fatalf("merge into an empty set = %v", got)
	}
	if got := mergeTXTRecords([]string{"one"}, "two"); strings.Join(got, ",") != "one,two" {
		t.Fatalf("merge = %v", got)
	}
	if got := mergeTXTRecords([]string{"one", "two"}, "two"); len(got) != 2 {
		t.Fatalf("a value was duplicated: %v", got)
	}
	// deSEC returns TXT values quoted; the quoting style is preserved.
	got := mergeTXTRecords([]string{`"one"`}, "two")
	if len(got) != 2 || got[0] != `"one"` || got[1] != `"two"` {
		t.Fatalf("quoted merge = %v", got)
	}
	if got := mergeTXTRecords([]string{`"two"`}, "two"); len(got) != 1 {
		t.Fatalf("a quoted value was duplicated: %v", got)
	}
}

// The Namecheap API replaces the whole host table, so the merge has to happen
// before the table is submitted.
func TestNameCheapTXTIsMergedAndOtherTypesAreReplaced(t *testing.T) {
	name := "h1"
	rec := Record{Domain: "example.com", SubDomain: name, Type: "TXT", Value: "new-value", TTL: 60}
	hosts := []nameCheapHost{
		{Name: name, Type: "TXT", Address: "old-value"},
		{Name: "other", Type: "TXT", Address: "keep"},
	}
	updated, ok := applyRecord(hosts, rec, false)
	if !ok || len(updated) != 3 {
		t.Fatalf("txt merge = %+v", updated)
	}
	values := map[string]int{}
	for _, h := range updated {
		// The Namecheap API pads short TXT values, so compare them trimmed.
		values[h.Name+"|"+strings.TrimSpace(h.Address)]++
	}
	if values["other|keep"] != 1 || values["h1|old-value"] != 1 || values["h1|new-value"] != 1 {
		t.Fatalf("txt merge lost or duplicated a value: %v", values)
	}

	// The same value is not added twice.
	again, _ := applyRecord(updated, rec, false)
	if len(again) != len(updated) {
		t.Fatalf("a duplicate TXT value was added: %+v", again)
	}

	// An A record replaces the previous address.
	aRec := Record{Domain: "example.com", SubDomain: name, Type: "A", Value: "192.0.2.2", TTL: 60}
	replaced, _ := applyRecord([]nameCheapHost{{Name: name, Type: "A", Address: "192.0.2.1"}}, aRec, false)
	if len(replaced) != 1 || replaced[0].Address != "192.0.2.2" {
		t.Fatalf("A record = %+v", replaced)
	}
}
