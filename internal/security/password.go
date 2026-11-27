// Package security implements the credential, session and throttling
// primitives used by the admin API.
package security

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters. They are stored inside every hash so they can be
// raised later without invalidating existing passwords.
const (
	argonTime    = 2
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32
)

// Route level basic auth users are verified on the request path of a public
// site, so they use a cheaper parameter set than the administrator account:
// the OWASP minimum recommendation (19 MiB, t=2, p=1). That is still a memory
// hard hash with roughly a third of the footprint; with one lane instead of
// four the wall clock cost stays in the same order as the administrator hash.
// The parameters travel inside the PHC string, so existing 64 MiB hashes keep
// working and are replaced the next time the password is set.
const (
	routeArgonTime    = 2
	routeArgonMemory  = 19 * 1024
	routeArgonThreads = 1
)

// ErrInvalidHash is returned when a stored hash cannot be parsed.
var ErrInvalidHash = errors.New("invalid password hash")

// HashPassword returns an argon2id PHC string for the administrator account.
func HashPassword(password string) (string, error) {
	return hashPassword(password, argonMemory, argonTime, argonThreads)
}

// HashPasswordRoute returns a hash for a route level basic auth user. See the
// parameter comments above: it trades offline cracking cost for a smaller
// per-attempt footprint on the request path.
func HashPasswordRoute(password string) (string, error) {
	return hashPassword(password, routeArgonMemory, routeArgonTime, routeArgonThreads)
}

// hashPassword returns an argon2id PHC string with explicit parameters.
func hashPassword(password string, memory, time uint32, threads uint8) (string, error) {
	if strings.TrimSpace(password) == "" {
		return "", errors.New("password must not be empty")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("read random salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, time, memory, threads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, memory, time, threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// passwordSlot serialises password hashing. One argon2id verification needs up
// to 64 MiB (administrator parameters), so without a slot a burst of
// concurrent login or basic auth requests allocates one buffer each and can
// exhaust the memory of the process. A single slot turns the burst into a
// queue and caps the footprint at one buffer.
var passwordSlot = make(chan struct{}, 1)

// AcquirePasswordSlot blocks until the password hashing slot is free or ctx is
// done. The returned release function must be called exactly once when the
// caller is done hashing or verifying; it is safe to call on the error path.
func AcquirePasswordSlot(ctx context.Context) (func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case passwordSlot <- struct{}{}:
		return func() { <-passwordSlot }, nil
	case <-ctx.Done():
		return func() {}, ctx.Err()
	}
}

// VerifyPassword checks password against an argon2id PHC string. It waits for
// the global password slot, so callers that already hold it (for example a
// handler that re-checks a limiter after queueing) must use
// VerifyPasswordHeld instead.
func VerifyPassword(encoded, password string) bool {
	release, err := AcquirePasswordSlot(context.Background())
	if err != nil {
		return false
	}
	defer release()
	return VerifyPasswordHeld(encoded, password)
}

// VerifyPasswordHeld is VerifyPassword for callers that already hold the
// password slot. It never blocks.
func VerifyPasswordHeld(encoded, password string) bool {
	memory, time, threads, salt, key, err := decodeHash(encoded)
	if err != nil {
		return false
	}
	other := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(key)))
	return subtle.ConstantTimeCompare(key, other) == 1
}

func decodeHash(encoded string) (memory, time uint32, threads uint8, salt, key []byte, err error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return 0, 0, 0, nil, nil, ErrInvalidHash
	}
	if _, err = fmt.Sscanf(parts[2], "v=%d", new(int)); err != nil {
		return 0, 0, 0, nil, nil, ErrInvalidHash
	}
	if _, err = fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return 0, 0, 0, nil, nil, ErrInvalidHash
	}
	if salt, err = base64.RawStdEncoding.DecodeString(parts[4]); err != nil {
		return 0, 0, 0, nil, nil, ErrInvalidHash
	}
	if key, err = base64.RawStdEncoding.DecodeString(parts[5]); err != nil {
		return 0, 0, 0, nil, nil, ErrInvalidHash
	}
	return memory, time, threads, salt, key, nil
}

const passwordAlphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_=+"

// RandomPassword returns a cryptographically random password with n chars.
func RandomPassword(n int) (string, error) {
	if n < 8 {
		n = 8
	}
	var b strings.Builder
	b.Grow(n)
	max := big.NewInt(int64(len(passwordAlphabet)))
	for i := 0; i < n; i++ {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b.WriteByte(passwordAlphabet[idx.Int64()])
	}
	return b.String(), nil
}

// RandomToken returns n random bytes encoded as lowercase hex.
func RandomToken(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	const hexDigits = "0123456789abcdef"
	out := make([]byte, len(buf)*2)
	for i, b := range buf {
		out[i*2] = hexDigits[b>>4]
		out[i*2+1] = hexDigits[b&0x0f]
	}
	return string(out), nil
}

// ConstantTimeEqual compares two strings without leaking their contents.
func ConstantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
