//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type nativeReleaseComponent struct {
	Version string `json:"version"`
	Package string `json:"package"`
}
type nativeServiceRelease struct {
	SchemaVersion              int    `json:"schemaVersion"`
	Version                    string `json:"version"`
	Channel                    string `json:"channel"`
	Mandatory                  *bool  `json:"mandatory"`
	MinimumSourceVersion       string `json:"minimumSourceVersion"`
	MinimumBootstrapperVersion string `json:"minimumBootstrapperVersion"`
	Packages                   struct {
		Application struct {
			URL    string `json:"url"`
			SHA256 string `json:"sha256"`
			Size   int64  `json:"size"`
			Format string `json:"format"`
		} `json:"application"`
	} `json:"packages"`
	Components struct {
		Desktop nativeReleaseComponent `json:"desktop"`
		CLI     nativeReleaseComponent `json:"cli"`
		Storage struct {
			ComponentVersion string `json:"componentVersion"`
			Package          string `json:"package"`
			Migration        struct {
				Kind                    string   `json:"kind"`
				SupportedSourceVersions []string `json:"supportedSourceVersions"`
			} `json:"migration"`
		} `json:"storage"`
	} `json:"components"`
	Recovery struct {
		SchemaVersion        int    `json:"schemaVersion"`
		InventorySHA256      string `json:"inventorySha256"`
		LaunchManifestSHA256 string `json:"launchManifestSha256"`
	} `json:"recovery"`
}

type nativeReleaseSource struct{ AppVersion, BootstrapperVersion, ComponentVersion, Channel string }
type admittedServiceRelease struct {
	Release                                       nativeServiceRelease
	ManifestSHA256, SignerKeyID, ExecutableSHA256 string
	ExecutableSize                                int64
}

var nativeReleaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.(0|[1-9][0-9]*))?$`)
var nativeComponentID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$`)

func compareNativeReleaseVersions(left, right string) (int, error) {
	var versions [2][4]uint64
	for index, version := range []string{left, right} {
		parts := nativeReleaseVersion.FindStringSubmatch(version)
		if len(version) > 80 || parts == nil {
			return 0, errors.New("unsupported release version")
		}
		for field, part := range parts[1:] {
			if part == "" {
				versions[index][field] = ^uint64(0)
				continue
			}
			value, err := strconv.ParseUint(part, 10, 64)
			if err != nil || value > 9007199254740991 {
				return 0, errors.New("release version overflow")
			}
			versions[index][field] = value
		}
	}
	for index := range versions[0] {
		if versions[0][index] < versions[1][index] {
			return -1, nil
		}
		if versions[0][index] > versions[1][index] {
			return 1, nil
		}
	}
	return 0, nil
}

func decodeNativeReleaseJSON(data []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing release JSON")
	}
	return nil
}

// The source must be read from admitted installation/service evidence. No package
// path is accepted here: output authorizes only the fixed standalone host bytes.
// Privileged staging must verify those bytes while copying to private storage.
func admitServiceRelease(manifest, signature, inventory []byte, keys [][]byte, source nativeReleaseSource) (admittedServiceRelease, error) {
	var result admittedServiceRelease
	auth, err := authenticateReleaseBytes(manifest, signature, keys)
	if err != nil {
		return result, err
	}
	r := &result.Release
	if err = decodeNativeReleaseJSON(auth.Manifest, r); err != nil {
		return result, err
	}
	if r.SchemaVersion != 1 || r.Mandatory == nil || (r.Channel != "beta" && r.Channel != "stable") || r.Channel != source.Channel || (r.Channel == "stable" && strings.Contains(r.Version, "-")) {
		return result, errors.New("unsupported service release channel or schema")
	}
	for _, comparison := range []struct {
		left, right string
		strict      bool
	}{
		{r.Version, r.MinimumSourceVersion, true}, {r.Version, source.AppVersion, true}, {source.AppVersion, r.MinimumSourceVersion, false}, {source.BootstrapperVersion, r.MinimumBootstrapperVersion, false},
	} {
		cmp, err := compareNativeReleaseVersions(comparison.left, comparison.right)
		if err != nil {
			return result, err
		}
		if cmp < 0 || (comparison.strict && cmp == 0) {
			return result, errors.New("service release source/bootstrapper floor refused")
		}
	}
	for _, component := range []nativeReleaseComponent{r.Components.Desktop, r.Components.CLI} {
		if component.Version != r.Version || component.Package != "application" {
			return result, errors.New("mixed application release")
		}
	}
	s := r.Components.Storage
	if s.Package != "application" || !nativeComponentID.MatchString(s.ComponentVersion) || s.ComponentVersion == source.ComponentVersion || s.Migration.Kind != "service-replacement" || len(s.Migration.SupportedSourceVersions) == 0 || len(s.Migration.SupportedSourceVersions) > 32 {
		return result, errors.New("unsupported storage replacement")
	}
	seen := map[string]bool{}
	for _, item := range s.Migration.SupportedSourceVersions {
		if !nativeComponentID.MatchString(item) || seen[item] {
			return result, errors.New("invalid source compatibility list")
		}
		seen[item] = true
	}
	if !seen[source.ComponentVersion] {
		return result, errors.New("source storage version not supported")
	}
	p := r.Packages.Application
	location, err := url.Parse(p.URL)
	if err != nil || len(p.URL) > 8192 || location.Scheme != "https" || location.Host != "github.com" || location.User != nil || location.RawQuery != "" || location.Fragment != "" || !strings.HasPrefix(location.Path, "/Kubonsang/HoneyBee/releases/download/") || len(strings.Split(strings.TrimPrefix(location.Path, "/Kubonsang/HoneyBee/releases/download/"), "/")) != 2 || !migrationDigest(p.SHA256) || p.Size <= 0 || p.Size > 4<<30 || p.Format != "zip" {
		return result, errors.New("unsupported release package")
	}
	asset := strings.TrimPrefix(location.Path, "/Kubonsang/HoneyBee/releases/download/v"+r.Version+"/")
	if asset == location.Path || strings.Contains(asset, "/") || validateColdBackupName(asset) != nil || !strings.HasSuffix(asset, ".zip") {
		return result, errors.New("release package tag or asset differs from signed version")
	}
	if r.Recovery.SchemaVersion != 1 || !migrationDigest(r.Recovery.InventorySHA256) || !migrationDigest(r.Recovery.LaunchManifestSHA256) || len(inventory) == 0 || len(inventory) > 8<<20 || evidenceHash(inventory) != r.Recovery.InventorySHA256 {
		return result, errors.New("signed service inventory required")
	}
	var files struct {
		SchemaVersion int `json:"schemaVersion"`
		Files         map[string]struct {
			Size   int64  `json:"size"`
			SHA256 string `json:"sha256"`
		} `json:"files"`
	}
	if err := decodeNativeReleaseJSON(inventory, &files); err != nil {
		return result, err
	}
	if files.SchemaVersion != 1 || len(files.Files) == 0 || len(files.Files) > 10000 {
		return result, errors.New("bounded file inventory required")
	}
	seen = map[string]bool{}
	for name, file := range files.Files {
		if validateColdBackupName(name) != nil || strings.ContainsAny(name, `\:`) || seen[strings.ToLower(name)] || file.Size < 0 || file.Size > 4<<30 || !migrationDigest(file.SHA256) {
			return result, errors.New("invalid signed inventory entry")
		}
		for _, part := range strings.Split(name, "/") {
			if part == "" || part == "." || part == ".." {
				return result, errors.New("invalid signed inventory path")
			}
		}
		seen[strings.ToLower(name)] = true
	}
	host, ok := files.Files["tools/honeybee-workspace-storage-host.exe"]
	if !ok || host.Size <= 0 || host.Size > 128<<20 || files.Files["launch.json"].SHA256 != r.Recovery.LaunchManifestSHA256 {
		return result, errors.New("signed host or launch binding missing")
	}
	result.ManifestSHA256 = auth.ManifestSHA256
	result.SignerKeyID = auth.SignerKeyID
	result.ExecutableSHA256 = host.SHA256
	result.ExecutableSize = host.Size
	return result, nil
}
