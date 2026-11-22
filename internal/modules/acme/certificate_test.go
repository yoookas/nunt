package acme

import (
	"archive/zip"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/certs"
)

func selfSignedCert(t *testing.T, domains []string) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: domains[0]},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:              domains,
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}

func newCertModule(t *testing.T) *ACME {
	t.Helper()
	a := newConfigModule(t)
	st, err := certs.Open(filepath.Join(t.TempDir(), "certs"))
	if err != nil {
		t.Fatalf("open certs: %v", err)
	}
	a.deps.Certs = st
	return a
}

// The download endpoint returns a zip with the chain and the private key.
func TestDownloadCertificateZip(t *testing.T) {
	a := newCertModule(t)
	certPEM, keyPEM := selfSignedCert(t, []string{"example.com"})
	if _, err := a.deps.Certs.Add([]string{"example.com"}, certPEM, keyPEM, "upload", "", "备份", false); err != nil {
		t.Fatalf("add: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/acme/certificates/example.com/download", nil)
	req.SetPathValue("id", "example.com")
	rec := httptest.NewRecorder()
	a.handleDownloadCertificate(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("download = %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("content type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "example.com.zip") {
		t.Fatalf("content disposition = %q", cd)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	files := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		data, _ := io.ReadAll(rc)
		_ = rc.Close()
		files[f.Name] = data
	}
	if !bytes.Equal(files["cert.pem"], certPEM) || !bytes.Equal(files["key.pem"], keyPEM) {
		t.Fatalf("zip content mismatch: %v", files)
	}

	// Unknown ids are a 404, not an empty archive.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/acme/certificates/nope/download", nil)
	req.SetPathValue("id", "nope")
	rec = httptest.NewRecorder()
	a.handleDownloadCertificate(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown id = %d", rec.Code)
	}
}

// A wildcard certificate gets a safe archive name.
func TestSafeDownloadName(t *testing.T) {
	cases := map[string]string{
		"*.example.com": "example.com",
		"../../etc":     "etc",
		"":              "certificate",
		"例子.com":        "com",
	}
	for in, want := range cases {
		if got := safeDownloadName(in); got != want {
			t.Fatalf("safeDownloadName(%q) = %q, want %q", in, got, want)
		}
	}
}

// The name of an uploaded certificate becomes its remark.
func TestUploadStoresRemark(t *testing.T) {
	a := newCertModule(t)
	certPEM, keyPEM := selfSignedCert(t, []string{"upload.example.com"})
	body, err := json.Marshal(map[string]any{
		"cert": string(certPEM), "key": string(keyPEM), "name": "手工上传",
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/acme/certificates/upload", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	a.handleUploadCertificate(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload = %d: %s", rec.Code, rec.Body.String())
	}
	list := a.deps.Certs.List()
	if len(list) != 1 || list[0].Remark != "手工上传" || list[0].Source != "upload" {
		t.Fatalf("stored certificates = %+v", list)
	}
}
