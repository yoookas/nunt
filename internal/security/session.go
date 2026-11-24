package security

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

// Session is an authenticated browser session.
type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	IP        string    `json:"ip"`
	UserAgent string    `json:"userAgent"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	CSRF      string    `json:"csrf"`
}

// SessionStore keeps sessions in memory. Tokens are stored hashed so a memory
// dump does not hand over usable cookies.
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	stop     chan struct{}
}

// NewSessionStore creates an empty store and starts its janitor.
func NewSessionStore() *SessionStore {
	s := &SessionStore{sessions: map[string]*Session{}, stop: make(chan struct{})}
	go s.janitor()
	return s
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Create registers a new session and returns the opaque token.
func (s *SessionStore) Create(userID, ip, ua string, ttl time.Duration) (*Session, string, error) {
	token, err := RandomToken(32)
	if err != nil {
		return nil, "", err
	}
	csrf, err := RandomToken(32)
	if err != nil {
		return nil, "", err
	}
	now := time.Now()
	sess := &Session{
		ID:        hashToken(token),
		UserID:    userID,
		IP:        ip,
		UserAgent: ua,
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
		CSRF:      csrf,
	}
	s.mu.Lock()
	s.sessions[sess.ID] = sess
	s.mu.Unlock()
	return sess, token, nil
}

// Get returns the session for a token when it is still valid.
func (s *SessionStore) Get(token string) (*Session, bool) {
	if token == "" {
		return nil, false
	}
	id := hashToken(token)
	s.mu.RLock()
	sess, ok := s.sessions[id]
	s.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if time.Now().After(sess.ExpiresAt) {
		s.Delete(token)
		return nil, false
	}
	copied := *sess
	return &copied, true
}

// Delete removes a session by token.
func (s *SessionStore) Delete(token string) {
	id := hashToken(token)
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

// DeleteByID removes a session by its hashed id.
func (s *SessionStore) DeleteByID(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

// Clear invalidates every session. Importing a configuration can replace the
// administrator account, so nobody may keep a session that was issued under
// the previous credentials.
func (s *SessionStore) Clear() {
	s.mu.Lock()
	s.sessions = map[string]*Session{}
	s.mu.Unlock()
}

// List returns all live sessions.
func (s *SessionStore) List() []Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		out = append(out, *sess)
	}
	return out
}

// Count returns the number of live sessions.
func (s *SessionStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.sessions)
}

func (s *SessionStore) janitor() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			now := time.Now()
			s.mu.Lock()
			for id, sess := range s.sessions {
				if now.After(sess.ExpiresAt) {
					delete(s.sessions, id)
				}
			}
			s.mu.Unlock()
		}
	}
}

// Close stops the janitor.
func (s *SessionStore) Close() { close(s.stop) }
