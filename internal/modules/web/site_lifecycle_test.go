package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A site that owns storage must not release it while a request is still being
// served: the request may read from that storage. New requests are refused once
// the site is closed, so no new reader can appear.
func TestStorageSiteReleasesAfterInFlightRequests(t *testing.T) {
	started := make(chan struct{})
	finish := make(chan struct{})
	released := make(chan struct{})

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-finish
		_, _ = w.Write([]byte("done"))
	})
	site := &webSite{handler: inner, closer: func() error {
		close(released)
		return nil
	}}
	site.handler = site.guard(inner)

	go func() {
		rec := httptest.NewRecorder()
		site.handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	}()
	<-started

	site.detach()
	select {
	case <-released:
		t.Fatal("the storage was released while a request was running")
	case <-time.After(20 * time.Millisecond):
	}

	close(finish)
	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("the storage was not released after the request finished")
	}

	// A request that arrives after the close is refused instead of reading from
	// a released handle.
	rec := httptest.NewRecorder()
	site.handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("request after close = %d, want 503", rec.Code)
	}
}

// Releasing twice (close after detach, or Stop after a reload) must be safe.
func TestStorageSiteReleasesOnce(t *testing.T) {
	var calls int
	site := &webSite{handler: http.NotFoundHandler(), closer: func() error {
		calls++
		return nil
	}}
	site.handler = site.guard(site.handler)
	site.detach()
	site.close()
	if calls != 1 {
		t.Fatalf("closer called %d times, want 1", calls)
	}
}
