package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// TOTP parameters. They are the defaults every authenticator app assumes, so
// the secret can be registered by scanning a QR code or typing it by hand.
const (
	// TOTPDigits is the number of digits in a code.
	TOTPDigits = 6
	// TOTPPeriod is the length of one time step.
	TOTPPeriod = 30 * time.Second
	// TOTPSkew is how many steps of clock drift are tolerated on both sides.
	TOTPSkew = 1
	// totpSecretBytes is the entropy of a new secret (160 bit, RFC 4226 §4).
	totpSecretBytes = 20
)

var totpBase32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// GenerateTOTPSecret returns a new Base32 secret without padding.
func GenerateTOTPSecret() (string, error) {
	buf := make([]byte, totpSecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate TOTP secret: %w", err)
	}
	return totpBase32.EncodeToString(buf), nil
}

// DecodeTOTPSecret accepts what a human (or a QR code) may hand back: lower
// case, spaces, dashes and missing padding are all normalised away.
func DecodeTOTPSecret(secret string) ([]byte, error) {
	cleaned := strings.ToUpper(strings.TrimSpace(secret))
	cleaned = strings.NewReplacer(" ", "", "-", "", "\t", "").Replace(cleaned)
	cleaned = strings.TrimRight(cleaned, "=")
	if cleaned == "" {
		return nil, fmt.Errorf("empty TOTP secret")
	}
	key, err := totpBase32.DecodeString(cleaned)
	if err != nil {
		return nil, fmt.Errorf("decode TOTP secret: %w", err)
	}
	if len(key) == 0 {
		return nil, fmt.Errorf("empty TOTP secret")
	}
	return key, nil
}

// TOTPStep returns the time step a moment belongs to.
func TOTPStep(t time.Time) int64 {
	return t.Unix() / int64(TOTPPeriod/time.Second)
}

// TOTPCodeAt returns the code for exactly one time step.
func TOTPCodeAt(secret string, step int64) (string, error) {
	key, err := DecodeTOTPSecret(secret)
	if err != nil {
		return "", err
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))

	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)

	// RFC 4226 §5.3 dynamic truncation.
	offset := sum[len(sum)-1] & 0x0f
	value := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	value %= 1_000_000
	return fmt.Sprintf("%0*d", TOTPDigits, value), nil
}

// TOTPVerify checks a code and returns the time step it matched. Codes from the
// previous and next step are accepted (TOTPSkew) so a slightly drifting clock
// does not lock the operator out. The caller must reject a step that is not
// newer than the last accepted one, otherwise a code can be replayed.
func TOTPVerify(secret, code string, now time.Time) (int64, bool) {
	code = strings.TrimSpace(code)
	code = strings.NewReplacer(" ", "", "-", "").Replace(code)
	if len(code) != TOTPDigits {
		return 0, false
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return 0, false
		}
	}

	current := TOTPStep(now)
	for offset := int64(-TOTPSkew); offset <= TOTPSkew; offset++ {
		step := current + offset
		if step < 0 {
			continue
		}
		want, err := TOTPCodeAt(secret, step)
		if err != nil {
			return 0, false
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// TOTPURI builds the otpauth:// registration URI. Both label parts are URL
// encoded, so issuers and account names with spaces or slashes stay valid.
func TOTPURI(issuer, account, secret string) string {
	label := url.PathEscape(issuer) + ":" + url.PathEscape(account)
	query := url.Values{}
	query.Set("secret", secret)
	query.Set("issuer", issuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", strconv.Itoa(TOTPDigits))
	query.Set("period", strconv.Itoa(int(TOTPPeriod/time.Second)))
	return "otpauth://totp/" + label + "?" + query.Encode()
}
