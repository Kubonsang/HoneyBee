//go:build windows

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"testing"
)

// Generated test-only keys never configure production trust. Execute with the
// deferred related checks; this test does not require SCM, elevation or a VM.
func TestNativeReleaseAuthentication(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	key := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	manifest := []byte(`{"schemaVersion":1}`)
	envelope := map[string]any{
		"schemaVersion": 1, "algorithm": "ed25519", "keyId": evidenceHash(der),
		"manifestSha256": evidenceHash(manifest),
		"signature":      base64.StdEncoding.EncodeToString(ed25519.Sign(private, append([]byte("HoneyBee release manifest signature v1\n"), manifest...))),
	}
	signature, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	result, err := authenticateReleaseBytes(manifest, signature, [][]byte{key})
	if err != nil || result.ManifestSHA256 != evidenceHash(manifest) || result.SignerKeyID != evidenceHash(der) {
		t.Fatalf("authentication: %+v %v", result, err)
	}
	for name, tc := range map[string]struct {
		manifest, signature []byte
		keys                [][]byte
	}{
		"changed bytes": {append(append([]byte(nil), manifest...), '\n'), signature, [][]byte{key}},
		"no trust":      {manifest, signature, nil},
		"duplicate key": {manifest, signature, [][]byte{key, key}},
		"trailing JSON": {manifest, append(append([]byte(nil), signature...), []byte(`{}`)...), [][]byte{key}},
		"oversize":      {make([]byte, 65537), signature, [][]byte{key}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := authenticateReleaseBytes(tc.manifest, tc.signature, tc.keys); err == nil {
				t.Fatal("unsafe release accepted")
			}
		})
	}
	envelope["signature"] = base64.StdEncoding.EncodeToString(ed25519.Sign(private, manifest))
	wrongDomain, _ := json.Marshal(envelope)
	if _, err := authenticateReleaseBytes(manifest, wrongDomain, [][]byte{key}); err == nil {
		t.Fatal("signature without domain accepted")
	}
	manifest[0] = ' '
	if result.Manifest[0] != '{' {
		t.Fatal("authenticated bytes alias input")
	}
}
