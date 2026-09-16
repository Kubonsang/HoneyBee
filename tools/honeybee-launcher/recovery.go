package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var activationDirectoryName = regexp.MustCompile(`^activation-[A-Za-z0-9]+$`)
var journalVersionName = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.(0|[1-9][0-9]*))?$`)

func newerJournalVersion(source, target string) bool {
	var values [2][4]uint64
	for i, version := range []string{source, target} {
		parts := journalVersionName.FindStringSubmatch(version)
		if parts == nil {
			return false
		}
		for j, part := range parts[1:] {
			if part == "" {
				values[i][j] = ^uint64(0)
				continue
			}
			value, err := strconv.ParseUint(part, 10, 64)
			if err != nil || value > 9007199254740991 {
				return false
			}
			values[i][j] = value
		}
	}
	for i := range values[0] {
		if values[0][i] != values[1][i] {
			return values[1][i] > values[0][i]
		}
	}
	return false
}

type activationIntent struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	Source        string `json:"sourcePointerSha256"`
	Target        string `json:"targetPointerSha256"`
}
type activationState struct {
	SchemaVersion int    `json:"schemaVersion"`
	State         string `json:"state"`
	Intent        string `json:"intentSha256"`
}
type pendingRecovery struct{ directory string }

func (e *pendingRecovery) Error() string {
	return "interrupted activation requires validated recovery: " + e.directory
}

func plainLaunchDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || isRedirected(info) {
		return errors.New("redirected or invalid update directory")
	}
	return nil
}
func limitedEntries(directory string, limit int) ([]os.DirEntry, error) {
	file, err := os.Open(directory)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	entries, err := file.ReadDir(limit + 1)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(entries) > limit {
		return nil, errors.New("update journal limit exceeded")
	}
	return entries, nil
}
func metadataDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Read-only admission guard. This never guesses a rollback target or executes a
// recovery script supplied by a journal. Doctor/release admission belongs to the
// authorized recovery coordinator, not the stable launcher.
func requireCompletedActivations(root string) error {
	if err := plainLaunchDirectory(root); err != nil {
		return err
	}
	directory := root
	for _, part := range []string{"update", "activations"} {
		directory = filepath.Join(directory, part)
		if err := plainLaunchDirectory(directory); err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
	}
	entries, err := limitedEntries(directory, 256)
	if err != nil {
		return err
	}
	var latest activation
	outcomes := map[uint64]activation{}
	for _, entry := range entries {
		if !activationDirectoryName.MatchString(entry.Name()) {
			return errors.New("unrecognized activation journal entry")
		}
		relative := filepath.Join("update", "activations", entry.Name())
		if err := plainLaunchDirectory(filepath.Join(root, relative)); err != nil {
			return err
		}
		var outcome activation
		if err := completedActivation(root, relative, &outcome); err != nil {
			return fmt.Errorf("HoneyBee update recovery is required before launch. Installation files were preserved. Journal: %s: %w", filepath.Join(root, relative), err)
		}
		if prior, ok := outcomes[outcome.Generation]; ok && prior != outcome {
			return errors.New("conflicting terminal activation pointers")
		}
		outcomes[outcome.Generation] = outcome
		if outcome.Generation > latest.Generation {
			latest = outcome
		}
	}
	if latest.Generation != 0 {
		data, err := readMetadata(root, "current.json")
		if err != nil {
			return err
		}
		var current activation
		if err := decodeMetadata(data, &current); err != nil {
			return err
		}
		if current != latest {
			matches, err := combinedHistoryContinues(root, latest, current)
			if err != nil {
				return err
			}
			if !matches {
				return errors.New("active pointer disagrees with validated activation history; recovery required")
			}
		}
	}
	return nil
}
func completedActivation(root, relative string, outcome *activation) error {
	intentBytes, err := readMetadata(root, filepath.Join(relative, "intent.json"))
	if err != nil {
		return err
	}
	var intent activationIntent
	if err := decodeMetadata(intentBytes, &intent); err != nil {
		return err
	}
	if intent.SchemaVersion != 1 || intent.Kind != "app-pointer-v1" || !validDigest(intent.Source) || !validDigest(intent.Target) {
		return errors.New("invalid activation intent")
	}
	var pointers [2]activation
	for i, name := range []string{"source.json", "target.json"} {
		data, err := readMetadata(root, filepath.Join(relative, name))
		if err != nil {
			return err
		}
		expected := intent.Source
		if i == 1 {
			expected = intent.Target
		}
		if metadataDigest(data) != expected {
			return errors.New("activation pointer digest mismatch")
		}
		if err := decodeMetadata(data, &pointers[i]); err != nil {
			return err
		}
		p := pointers[i]
		if p.SchemaVersion != 1 || p.Generation == 0 || p.Generation > 9007199254740991 || len(p.ActiveVersion) > 128 || !versionName.MatchString(p.ActiveVersion) || !validDigest(p.ManifestSHA256) {
			return errors.New("invalid journal pointer")
		}
	}
	if pointers[1].Generation != pointers[0].Generation+1 || !newerJournalVersion(pointers[0].ActiveVersion, pointers[1].ActiveVersion) {
		return errors.New("invalid activation transition")
	}
	entries, err := limitedEntries(filepath.Join(root, relative), 32)
	if err != nil {
		return err
	}
	states := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if name == "intent.json" || name == "source.json" || name == "target.json" {
			continue
		}
		if !strings.HasSuffix(name, ".state.json") {
			return errors.New("unrecognized activation file")
		}
		state := strings.TrimSuffix(name, ".state.json")
		switch state {
		case "Switching", "Switched", "Committed", "RollingBack", "RolledBack":
		default:
			return errors.New("unknown activation state")
		}
		data, err := readMetadata(root, filepath.Join(relative, name))
		if err != nil {
			return err
		}
		var record activationState
		if err := decodeMetadata(data, &record); err != nil {
			return err
		}
		if record.SchemaVersion != 1 || record.State != state || record.Intent != metadataDigest(intentBytes) {
			return errors.New("activation state binding mismatch")
		}
		states[state] = true
	}
	if states["Switched"] && !states["Switching"] || states["Committed"] && (!states["Switched"] || states["RollingBack"] || states["RolledBack"]) || states["RolledBack"] && !states["RollingBack"] {
		return errors.New("conflicting activation history")
	}
	if !states["Committed"] && !states["RolledBack"] {
		return &pendingRecovery{filepath.Base(relative)}
	}
	*outcome = pointers[0]
	if states["Committed"] {
		*outcome = pointers[1]
	}
	return nil
}
