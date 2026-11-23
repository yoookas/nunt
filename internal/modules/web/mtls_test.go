package web

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"testing"
	"time"
)

func testCAPEM(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "nunt test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestClientAuthMapping(t *testing.T) {
	if auth, on := clientAuthFor("require"); !on || auth != tls.RequireAndVerifyClientCert {
		t.Fatalf("require = %v %v", auth, on)
	}
	if auth, on := clientAuthFor("request"); !on || auth != tls.RequestClientCert {
		t.Fatalf("request = %v %v", auth, on)
	}
	if _, on := clientAuthFor(""); on {
		t.Fatal("empty mode must be off")
	}
}

func TestClientCAPool(t *testing.T) {
	pool, err := clientCAPool(testCAPEM(t))
	if err != nil {
		t.Fatalf("valid CA: %v", err)
	}
	if pool == nil {
		t.Fatal("nil pool")
	}
	if _, err := clientCAPool(""); err == nil {
		t.Fatal("an empty bundle must fail")
	}
	if _, err := clientCAPool("not a pem"); err == nil {
		t.Fatal("garbage must fail")
	}
}
