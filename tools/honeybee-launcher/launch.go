package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
)

const metadataLimit = 64 * 1024

var versionName = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$`)

type activation struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Generation     uint64 `json:"generation"`
	ActiveVersion  string `json:"activeVersion"`
	ManifestSHA256 string `json:"manifestSha256"`
}

// Local launch inventory, separate from a future signed download manifest.
type launchManifest struct {
	SchemaVersion      int    `json:"schemaVersion"`
	Version            string `json:"version"`
	DesktopSHA256      string `json:"desktopSha256"`
	NodeSHA256         string `json:"nodeSha256"`
	CLISHA256          string `json:"cliSha256"`
	InstallationSHA256 string `json:"installationSha256,omitempty"`
}

type launchPlan struct {
	Executable string
	Arguments  []string
	CLI        bool
}

func installationRoot(executable string) (string, bool, error) {
	if !filepath.IsAbs(executable) {
		return "", false, errors.New("launcher path must be absolute")
	}
	directory := filepath.Dir(executable)
	switch {
	case strings.EqualFold(filepath.Base(executable), "HoneyBeeLauncher.exe"):
		return directory, false, nil
	case strings.EqualFold(filepath.Base(executable), "honeybee.exe") && strings.EqualFold(filepath.Base(directory), "bin"):
		return filepath.Dir(directory), true, nil
	default:
		return "", false, errors.New("keep HoneyBeeLauncher.exe and bin/honeybee.exe in their installed locations")
	}
}

// Refuse links/junctions at every component beneath the installation root.
// This is a path check, not a privileged execution boundary or a replacement lock.
func ownedPath(root, relative string) (string, error) {
	if !filepath.IsLocal(relative) {
		return "", errors.New("path escaped the installation")
	}
	current := root
	parts := append([]string{""}, strings.Split(filepath.Clean(relative), string(filepath.Separator))...)
	for index, component := range parts {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if isRedirected(info) {
			return "", fmt.Errorf("installation path is a link or reparse point: %s", current)
		}
		if index < len(parts)-1 && !info.IsDir() {
			return "", fmt.Errorf("installation path is not a directory: %s", current)
		}
		if index == len(parts)-1 && !info.Mode().IsRegular() {
			return "", fmt.Errorf("installation payload is not a regular file: %s", current)
		}
	}
	return current, nil
}

func readMetadata(root, relative string) ([]byte, error) {
	target, err := ownedPath(root, relative)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(target)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, metadataLimit+1))
	if err != nil || len(data) > metadataLimit {
		return nil, errors.New("installation metadata is unreadable or too large")
	}
	return data, nil
}

func decodeMetadata(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("installation metadata contains trailing data")
	}
	return nil
}

func validDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}

func verifyFile(root, relative, expected string) (string, error) {
	if !validDigest(expected) {
		return "", errors.New("invalid launch payload digest")
	}
	target, err := ownedPath(root, relative)
	if err != nil {
		return "", err
	}
	file, err := os.Open(target)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expected {
		return "", fmt.Errorf("launch payload digest mismatch: %s", target)
	}
	return target, nil
}

func resolveLaunch(executable string, arguments []string) (launchPlan, error) {
	root, cli, err := installationRoot(executable)
	if err != nil {
		return launchPlan{}, err
	}
	if err := requireCompletedCombinedUpdates(root, cli, arguments); err != nil {
		return launchPlan{}, err
	}
	if err := requireCompletedActivations(root); err != nil {
		return launchPlan{}, err
	}
	if err := requireCompletedApplicationRepairs(root); err != nil {
		return launchPlan{}, err
	}
	data, err := readMetadata(root, "current.json")
	if err != nil {
		return launchPlan{}, err
	}
	var current activation
	if err := decodeMetadata(data, &current); err != nil {
		return launchPlan{}, err
	}
	if current.SchemaVersion != 1 || current.Generation == 0 || len(current.ActiveVersion) > 128 || !versionName.MatchString(current.ActiveVersion) || !validDigest(current.ManifestSHA256) {
		return launchPlan{}, errors.New("invalid or unsupported activation record")
	}
	versionRoot := filepath.Join("versions", current.ActiveVersion)
	manifestBytes, err := readMetadata(root, filepath.Join(versionRoot, "launch.json"))
	if err != nil {
		return launchPlan{}, err
	}
	digest := sha256.Sum256(manifestBytes)
	if hex.EncodeToString(digest[:]) != current.ManifestSHA256 {
		return launchPlan{}, errors.New("launch manifest digest mismatch")
	}
	var manifest launchManifest
	if err := decodeMetadata(manifestBytes, &manifest); err != nil {
		return launchPlan{}, err
	}
	if manifest.SchemaVersion != 1 || manifest.Version != current.ActiveVersion || !validDigest(manifest.DesktopSHA256) || !validDigest(manifest.NodeSHA256) || !validDigest(manifest.CLISHA256) {
		return launchPlan{}, errors.New("invalid or unsupported launch manifest")
	}
	plan := launchPlan{CLI: cli, Arguments: append([]string(nil), arguments...)}
	if manifest.InstallationSHA256 != "" {
		if _, err := verifyFile(root, filepath.Join(versionRoot, "installation.json"), manifest.InstallationSHA256); err != nil {
			return launchPlan{}, err
		}
	}
	if cli {
		plan.Executable, err = verifyFile(root, filepath.Join(versionRoot, "runtime", "node.exe"), manifest.NodeSHA256)
		if err != nil {
			return launchPlan{}, err
		}
		script, err := verifyFile(root, filepath.Join(versionRoot, "cli", "dist", "cli.js"), manifest.CLISHA256)
		if err != nil {
			return launchPlan{}, err
		}
		plan.Arguments = append([]string{script}, plan.Arguments...)
	} else {
		plan.Executable, err = verifyFile(root, filepath.Join(versionRoot, "desktop", "HoneyBee.exe"), manifest.DesktopSHA256)
	}
	if err == nil {
		err = requireCompletedActivations(root)
	}
	return plan, err
}

func launch(plan launchPlan, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	command := exec.Command(plan.Executable, plan.Arguments...)
	// Inherit the caller's working directory. In particular, CLI paths remain relative
	// to the shell, not to bin/ or the version directory. Never invoke a shell.
	if !plan.CLI {
		if err := command.Start(); err != nil {
			return 1, err
		}
		return 0, command.Process.Release()
	}
	command.Stdin, command.Stdout, command.Stderr = stdin, stdout, stderr
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	err := command.Run()
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode(), nil
	}
	if err != nil {
		return 1, err
	}
	return 0, nil
}
