//go:build windows

package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
)

// This is only the cryptographic prerequisite for privileged admission. It does
// not parse migration policy, authorize SCM writes or authenticate extracted
// binaries. No public CLI exposes it until protected package admission exists.
// approvedPublicPEM must come from the trusted host build/protected policy, never
// from an initiating user's request, release archive, or downloaded metadata.
type authenticatedReleaseBytes struct {
	Manifest       []byte
	ManifestSHA256 string
	SignerKeyID    string
}

func authenticateReleaseBytes(manifest, signature []byte, approvedPublicPEM [][]byte) (authenticatedReleaseBytes, error) {
	var result authenticatedReleaseBytes
	if len(manifest) == 0 || len(manifest) > 64<<10 || len(signature) > 4096 || len(approvedPublicPEM) == 0 || len(approvedPublicPEM) > 8 {
		return result, errors.New("bounded manifest and approved release trust required")
	}
	var envelope struct {
		SchemaVersion  int    `json:"schemaVersion"`
		Algorithm      string `json:"algorithm"`
		KeyID          string `json:"keyId"`
		ManifestSHA256 string `json:"manifestSha256"`
		Signature      string `json:"signature"`
	}
	decoder := json.NewDecoder(bytes.NewReader(signature))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return result, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return result, errors.New("trailing signature metadata")
	}
	if envelope.SchemaVersion != 1 || envelope.Algorithm != "ed25519" || !migrationDigest(envelope.KeyID) || envelope.ManifestSHA256 != evidenceHash(manifest) {
		return result, errors.New("invalid release signature identity")
	}
	if len(envelope.Signature) != 88 {
		return result, errors.New("invalid signature encoding")
	}
	signatureBytes, err := base64.StdEncoding.Strict().DecodeString(envelope.Signature)
	if err != nil || len(signatureBytes) != ed25519.SignatureSize || base64.StdEncoding.EncodeToString(signatureBytes) != envelope.Signature {
		return result, errors.New("noncanonical release signature")
	}
	seen := make(map[string]bool)
	var signer ed25519.PublicKey
	for _, encoded := range approvedPublicPEM {
		if len(encoded) > 4096 {
			return result, errors.New("release public key exceeds bound")
		}
		block, rest := pem.Decode(encoded)
		if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
			return result, errors.New("SPKI public key required")
		}
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return result, err
		}
		key, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return result, errors.New("Ed25519 release key required")
		}
		der, err := x509.MarshalPKIXPublicKey(key)
		if err != nil {
			return result, err
		}
		id := evidenceHash(der)
		if seen[id] {
			return result, errors.New("duplicate release trust key")
		}
		seen[id] = true
		if id == envelope.KeyID {
			signer = key
		}
	}
	if signer == nil {
		return result, errors.New("untrusted release signer")
	}
	message := append([]byte("HoneyBee release manifest signature v1\n"), manifest...)
	if !ed25519.Verify(signer, message, signatureBytes) {
		return result, errors.New("release signature verification failed")
	}
	result.Manifest = append([]byte(nil), manifest...)
	result.ManifestSHA256 = envelope.ManifestSHA256
	result.SignerKeyID = envelope.KeyID
	return result, nil
}
