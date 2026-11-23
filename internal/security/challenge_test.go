package security

import (
	"testing"
	"time"
)

func TestChallengeIssueAndGet(t *testing.T) {
	s := NewChallengeStore(time.Minute)
	c, err := s.Issue("u1", "192.0.2.1", "browser")
	if err != nil {
		t.Fatal(err)
	}
	if c.Token == "" {
		t.Fatal("empty token")
	}
	got, ok := s.Get(c.Token)
	if !ok {
		t.Fatal("challenge not found")
	}
	if got.UserID != "u1" || got.IP != "192.0.2.1" || got.UserAgent != "browser" {
		t.Fatalf("challenge = %+v", got)
	}
	if s.Len() != 1 {
		t.Fatalf("len = %d, want 1", s.Len())
	}
}

func TestChallengeExpires(t *testing.T) {
	s := NewChallengeStore(time.Minute)
	now := time.Unix(1700000000, 0)
	s.now = func() time.Time { return now }

	c, err := s.Issue("u1", "192.0.2.1", "ua")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(59 * time.Second)
	if _, ok := s.Get(c.Token); !ok {
		t.Fatal("challenge must still be valid before its deadline")
	}
	now = now.Add(2 * time.Second)
	if _, ok := s.Get(c.Token); ok {
		t.Fatal("challenge must expire")
	}
	if s.Len() != 0 {
		t.Fatalf("len = %d, want 0 after expiry", s.Len())
	}
}

func TestChallengeFailuresRemoveIt(t *testing.T) {
	s := NewChallengeStore(time.Minute)
	c, _ := s.Issue("u1", "192.0.2.1", "ua")

	if left := s.Fail(c.Token, 3); left != 2 {
		t.Fatalf("left = %d, want 2", left)
	}
	if left := s.Fail(c.Token, 3); left != 1 {
		t.Fatalf("left = %d, want 1", left)
	}
	if left := s.Fail(c.Token, 3); left != 0 {
		t.Fatalf("left = %d, want 0", left)
	}
	if _, ok := s.Get(c.Token); ok {
		t.Fatal("an exhausted challenge must be gone")
	}
	if left := s.Fail("missing", 3); left != 0 {
		t.Fatalf("failing an unknown token = %d", left)
	}
}

func TestChallengeDelete(t *testing.T) {
	s := NewChallengeStore(time.Minute)
	c, _ := s.Issue("u1", "192.0.2.1", "ua")
	s.Delete(c.Token)
	if _, ok := s.Get(c.Token); ok {
		t.Fatal("deleted challenge must be gone")
	}
}
