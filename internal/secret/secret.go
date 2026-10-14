// Package secret encrypts credentials at rest.
//
// Values are sealed with AES-256-GCM using a key stored next to the
// configuration in a 0600 file, so a leaked configuration backup alone is not
// enough to recover DNS tokens or storage passwords.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"github.com/nunt/nunt/internal/store"
)

const prefix = "enc:v1:"

// Box seals and opens secret strings.
type Box struct {
	aead cipher.AEAD
}

// Open loads the key from keyPath, creating it on first use.
func Open(keyPath string) (*Box, error) {
	key, err := loadOrCreateKey(keyPath)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create gcm: %w", err)
	}
	return &Box{aead: aead}, nil
}

func loadOrCreateKey(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err == nil && len(data) >= 32 {
		return data[:32], nil
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}
	if err := store.WriteFileAtomic(path, key, 0o600); err != nil {
		return nil, fmt.Errorf("persist key: %w", err)
	}
	return key, nil
}

// IsSealed reports whether v was produced by Seal.
func IsSealed(v string) bool { return strings.HasPrefix(v, prefix) }

// Seal encrypts plain. Empty and already sealed values are returned as is.
func (b *Box) Seal(plain string) (string, error) {
	if plain == "" || IsSealed(plain) || b == nil {
		return plain, nil
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := b.aead.Seal(nonce, nonce, []byte(plain), nil)
	return prefix + base64.RawURLEncoding.EncodeToString(out), nil
}

// Open decrypts a value produced by Seal. Plain values pass through
// unchanged so hand written configuration files keep working.
func (b *Box) Open(sealed string) (string, error) {
	if sealed == "" || b == nil {
		return "", nil
	}
	if !IsSealed(sealed) {
		return sealed, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(sealed, prefix))
	if err != nil {
		return "", fmt.Errorf("decode secret: %w", err)
	}
	if len(raw) < b.aead.NonceSize() {
		return "", fmt.Errorf("secret is truncated")
	}
	nonce, data := raw[:b.aead.NonceSize()], raw[b.aead.NonceSize():]
	plain, err := b.aead.Open(nil, nonce, data, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt secret: %w", err)
	}
	return string(plain), nil
}

// SealMap seals every value of a credential map.
func (b *Box) SealMap(in map[string]string) (map[string]string, error) {
	if len(in) == 0 {
		return in, nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		s, err := b.Seal(v)
		if err != nil {
			return nil, err
		}
		out[k] = s
	}
	return out, nil
}

// OpenMap opens every value of a credential map.
func (b *Box) OpenMap(in map[string]string) (map[string]string, error) {
	if len(in) == 0 {
		return map[string]string{}, nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		s, err := b.Open(v)
		if err != nil {
			return nil, fmt.Errorf("field %s: %w", k, err)
		}
		out[k] = s
	}
	return out, nil
}

// Mask hides a secret for API responses, keeping a short hint.
func Mask(v string) string {
	if v == "" {
		return ""
	}
	if IsSealed(v) {
		return "********"
	}
	if len(v) <= 6 {
		return "********"
	}
	return v[:3] + "********" + v[len(v)-2:]
}
