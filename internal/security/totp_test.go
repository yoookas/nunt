package security

import (
	"strings"
	"testing"
	"time"
)

// rfcSecret is the ASCII seed used by RFC 6238 appendix B.
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" // base32("12345678901234567890")

func TestTOTPCodeMatchesRFCVectors(t *testing.T) {
	// sha1 vectors from RFC 6238 appendix B, truncated to six digits.
	cases := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
		{20000000000, "353130"},
	}
	for _, tc := range cases {
		got, err := TOTPCodeAt(rfcSecret, tc.unix/30)
		if err != nil {
			t.Fatalf("TOTPCodeAt(%d): %v", tc.unix, err)
		}
		if got != tc.want {
			t.Fatalf("code at %d = %q, want %q", tc.unix, got, tc.want)
		}
	}
}

func TestTOTPVerifyAcceptsOneStepSkew(t *testing.T) {
	now := time.Unix(1700000000, 0)
	code, err := TOTPCodeAt(rfcSecret, TOTPStep(now))
	if err != nil {
		t.Fatal(err)
	}

	if _, ok := TOTPVerify(rfcSecret, code, now); !ok {
		t.Fatal("the current step must verify")
	}
	if _, ok := TOTPVerify(rfcSecret, code, now.Add(-TOTPPeriod)); !ok {
		t.Fatal("one step of drift must be accepted")
	}
	if _, ok := TOTPVerify(rfcSecret, code, now.Add(TOTPPeriod)); !ok {
		t.Fatal("one step of drift must be accepted in both directions")
	}
	if _, ok := TOTPVerify(rfcSecret, code, now.Add(2*TOTPPeriod)); ok {
		t.Fatal("two steps of drift must be rejected")
	}
}

func TestTOTPVerifyReturnsTheMatchedStep(t *testing.T) {
	now := time.Unix(1700000000, 0)
	step := TOTPStep(now)
	previousCode, err := TOTPCodeAt(rfcSecret, step-1)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := TOTPVerify(rfcSecret, previousCode, now)
	if !ok {
		t.Fatal("previous step code must verify within the skew window")
	}
	if got != step-1 {
		t.Fatalf("step = %d, want %d", got, step-1)
	}
}

func TestTOTPVerifyRejectsMalformedCodes(t *testing.T) {
	now := time.Unix(1700000000, 0)
	for _, code := range []string{"", "12345", "1234567", "abcdef", "12 34 5"} {
		if _, ok := TOTPVerify(rfcSecret, code, now); ok {
			t.Fatalf("code %q must be rejected", code)
		}
	}
	if _, ok := TOTPVerify("not-base32!!", "123456", now); ok {
		t.Fatal("an invalid secret must not verify")
	}
}

func TestTOTPVerifyToleratesFormatting(t *testing.T) {
	now := time.Unix(1700000000, 0)
	step := TOTPStep(now)
	code, err := TOTPCodeAt(rfcSecret, step)
	if err != nil {
		t.Fatal(err)
	}
	spaced := code[:3] + " " + code[3:]
	if _, ok := TOTPVerify(rfcSecret, spaced, now); !ok {
		t.Fatal("spaces in the code must be ignored")
	}
}

func TestGenerateTOTPSecret(t *testing.T) {
	first, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatal(err)
	}
	key, err := DecodeTOTPSecret(first)
	if err != nil {
		t.Fatalf("generated secret does not decode: %v", err)
	}
	if len(key) != totpSecretBytes {
		t.Fatalf("secret length = %d, want %d", len(key), totpSecretBytes)
	}
	if strings.ContainsAny(first, "=-") {
		t.Fatalf("secret must be unpadded base32: %q", first)
	}
	second, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two generated secrets must differ")
	}
}

func TestDecodeTOTPSecretNormalisesInput(t *testing.T) {
	lower := " " + strings.ToLower(rfcSecret) + "==="
	key, err := DecodeTOTPSecret(lower)
	if err != nil {
		t.Fatalf("decode lower case/padded secret: %v", err)
	}
	if string(key) != "12345678901234567890" {
		t.Fatalf("decoded = %q", key)
	}
	if _, err := DecodeTOTPSecret(""); err == nil {
		t.Fatal("an empty secret must fail")
	}
	if _, err := DecodeTOTPSecret("!!!!"); err == nil {
		t.Fatal("garbage must fail")
	}
}

func TestTOTPURI(t *testing.T) {
	uri := TOTPURI("nunt", "admin", rfcSecret)
	for _, want := range []string{
		"otpauth://totp/nunt:admin?",
		"secret=" + rfcSecret,
		"issuer=nunt",
		"algorithm=SHA1",
		"digits=6",
		"period=30",
	} {
		if !strings.Contains(uri, want) {
			t.Fatalf("URI %q does not contain %q", uri, want)
		}
	}

	// Labels and issuer are escaped so a name with a space or a slash survives.
	escaped := TOTPURI("my server", "admin user", rfcSecret)
	if !strings.Contains(escaped, "my%20server:admin%20user") {
		t.Fatalf("URI %q does not escape the label", escaped)
	}
	if !strings.Contains(escaped, "issuer=my+server") && !strings.Contains(escaped, "issuer=my%20server") {
		t.Fatalf("URI %q does not escape the issuer", escaped)
	}
}
