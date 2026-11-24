package security

import (
	"strings"
	"testing"
	"time"
)

func TestPasswordHashRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("unexpected hash format %q", hash)
	}
	if !VerifyPassword(hash, "correct horse battery staple") {
		t.Fatal("the correct password must verify")
	}
	if VerifyPassword(hash, "wrong") {
		t.Fatal("a wrong password must not verify")
	}
	if VerifyPassword("garbage", "whatever") {
		t.Fatal("an invalid hash must not verify")
	}
	other, _ := HashPassword("correct horse battery staple")
	if hash == other {
		t.Fatal("hashes must be salted")
	}
}

func TestRandomHelpers(t *testing.T) {
	pw, err := RandomPassword(20)
	if err != nil || len(pw) != 20 {
		t.Fatalf("RandomPassword: %q %v", pw, err)
	}
	token, err := RandomToken(16)
	if err != nil || len(token) != 32 {
		t.Fatalf("RandomToken: %q %v", token, err)
	}
	if !ConstantTimeEqual(token, token) || ConstantTimeEqual(token, token+"x") {
		t.Fatal("ConstantTimeEqual misbehaves")
	}
}

func TestSessionStore(t *testing.T) {
	store := NewSessionStore()
	defer store.Close()
	sess, token, err := store.Create("user-1", "127.0.0.1", "test", time.Minute)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, ok := store.Get(token)
	if !ok || got.UserID != "user-1" || got.CSRF != sess.CSRF {
		t.Fatal("the created session must be retrievable")
	}
	store.DeleteUser("user-1")
	if _, ok := store.Get(token); ok {
		t.Fatal("sessions must be invalidated when the user is deleted")
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(2, 50*time.Millisecond, time.Minute)
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("the first attempt must be allowed")
	}
	l.Fail("k")
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("one failure must not lock")
	}
	if lock := l.Fail("k"); lock <= 0 {
		t.Fatal("the second failure must lock the key")
	}
	if ok, wait := l.Allow("k"); ok || wait <= 0 {
		t.Fatal("a locked key must report a wait time")
	}
	l.Reset("k")
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("reset must clear the lock")
	}
}

func TestRateLimiter(t *testing.T) {
	r := NewRateLimiter(1, 2)
	if !r.Allow("a") || !r.Allow("a") {
		t.Fatal("the burst must be allowed")
	}
	if r.Allow("a") {
		t.Fatal("the third immediate call must be throttled")
	}
	if !r.Allow("b") {
		t.Fatal("keys must be independent")
	}
}
