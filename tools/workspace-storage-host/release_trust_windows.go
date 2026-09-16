//go:build windows

package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	_ "embed"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
)

//go:embed update-trust-v1.json
var embeddedReleaseTrust []byte

// Trust is compiled into the host; a migration request cannot provide a key.
func installedReleaseTrust() ([][]byte, string, error) {
	var trust struct {
		SchemaVersion       int      `json:"schemaVersion"`
		Channel             string   `json:"channel"`
		BootstrapperVersion string   `json:"bootstrapperVersion"`
		PublicKeys          []string `json:"publicKeys"`
	}
	d := json.NewDecoder(bytes.NewReader(embeddedReleaseTrust))
	d.DisallowUnknownFields()
	if err := d.Decode(&trust); err != nil {
		return nil, "", err
	}
	if d.Decode(new(any)) != io.EOF || trust.SchemaVersion != 1 || (trust.Channel != "beta" && trust.Channel != "stable") || len(trust.PublicKeys) < 1 || len(trust.PublicKeys) > 8 {
		return nil, "", errors.New("invalid compiled release trust")
	}
	seen := map[string]bool{}
	keys := make([][]byte, 0, len(trust.PublicKeys))
	for _, encoded := range trust.PublicKeys {
		block, rest := pem.Decode([]byte(encoded))
		if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
			return nil, "", errors.New("invalid compiled release key")
		}
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, "", err
		}
		key, ok := parsed.(ed25519.PublicKey)
		if !ok || seen[string(key)] {
			return nil, "", errors.New("duplicate or unsupported compiled key")
		}
		seen[string(key)] = true
		keys = append(keys, []byte(encoded))
	}
	return keys, trust.Channel, nil
}
