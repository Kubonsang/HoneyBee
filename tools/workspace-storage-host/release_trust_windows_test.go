//go:build windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestCompiledReleaseTrustMatchesDesktop(t *testing.T) {
	keys, channel, err := installedReleaseTrust()
	if err != nil || len(keys) == 0 || channel != "beta" {
		t.Fatalf("trust: %s %v", channel, err)
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "apps", "desktop", "resources", "update-trust-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, embeddedReleaseTrust) {
		t.Fatal("Desktop and service trust differ")
	}
}
