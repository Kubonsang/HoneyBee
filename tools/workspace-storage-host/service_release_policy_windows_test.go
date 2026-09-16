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

func TestServiceReleasePolicyBindsSupportedSourceAndHost(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	keys := [][]byte{pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})}
	hostPin, launchPin := evidenceHash([]byte("host")), evidenceHash([]byte("launch"))
	inventory, _ := json.Marshal(map[string]any{"schemaVersion": 1, "files": map[string]any{
		"tools/honeybee-workspace-storage-host.exe": map[string]any{"size": 4, "sha256": hostPin},
		"launch.json": map[string]any{"size": 6, "sha256": launchPin},
	}})
	var release nativeServiceRelease
	release.SchemaVersion = 1
	release.Version = "0.1.0-beta.13"
	release.Channel = "beta"
	optional := false
	release.Mandatory = &optional
	release.MinimumSourceVersion = "0.1.0-beta.12"
	release.MinimumBootstrapperVersion = "1.0.0"
	p := &release.Packages.Application
	p.URL = "https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.13/application.zip"
	p.SHA256 = evidenceHash([]byte("zip"))
	p.Size = 3
	p.Format = "zip"
	release.Components.Desktop = nativeReleaseComponent{release.Version, "application"}
	release.Components.CLI = release.Components.Desktop
	s := &release.Components.Storage
	s.ComponentVersion = "target.hb13"
	s.Package = "application"
	s.Migration.Kind = "service-replacement"
	s.Migration.SupportedSourceVersions = []string{"source.hb12"}
	release.Recovery.SchemaVersion = 1
	release.Recovery.InventorySHA256 = evidenceHash(inventory)
	release.Recovery.LaunchManifestSHA256 = launchPin
	source := nativeReleaseSource{"0.1.0-beta.12", "1.0.0", "source.hb12", "beta"}
	invoke := func(r nativeServiceRelease, source nativeReleaseSource, inv []byte) (admittedServiceRelease, error) {
		manifest, _ := json.Marshal(r)
		envelope, _ := json.Marshal(map[string]any{"schemaVersion": 1, "algorithm": "ed25519", "keyId": evidenceHash(der), "manifestSha256": evidenceHash(manifest), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, append([]byte("HoneyBee release manifest signature v1\n"), manifest...)))})
		return admitServiceRelease(manifest, envelope, inv, keys, source)
	}
	result, err := invoke(release, source, inventory)
	if err != nil || result.ExecutableSHA256 != hostPin || result.ExecutableSize != 4 {
		t.Fatal(result, err)
	}
	for _, kind := range []string{"source-floor", "bootstrapper", "service-source", "channel", "inventory", "same-component", "missing-recovery", "mixed-cli", "foreign-url", "launch-pin"} {
		t.Run(kind, func(t *testing.T) {
			r, current, inv := release, source, inventory
			switch kind {
			case "source-floor":
				current.AppVersion = "0.1.0-beta.11"
			case "bootstrapper":
				current.BootstrapperVersion = "0.9.0"
			case "service-source":
				current.ComponentVersion = "other.hb11"
			case "channel":
				current.Channel = "stable"
			case "inventory":
				inv = append(append([]byte(nil), inventory...), '\n')
			case "same-component":
				r.Components.Storage.ComponentVersion = source.ComponentVersion
			case "missing-recovery":
				r.Recovery.SchemaVersion = 0
			case "mixed-cli":
				r.Components.CLI.Version = "0.1.0-beta.12"
			case "foreign-url":
				r.Packages.Application.URL = "https://example.com/application.zip"
			case "launch-pin":
				r.Recovery.LaunchManifestSHA256 = hostPin
			}
			if _, err := invoke(r, current, inv); err == nil {
				t.Fatal("unsafe service release admitted")
			}
		})
	}
}
