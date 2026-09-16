package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// App-only and paired updates share one generation sequence. A completed app-only
// journal must not reject a later, independently journaled paired pointer switch.
// Normal/validation admission above validates every combined state chain first.
func combinedHistoryContinues(root string, previous, current activation) (bool, error) {
	parent := filepath.Join(root, "update", "combined")
	entries, err := limitedEntries(parent, 256)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	successors := map[activation]activation{}
	for _, entry := range entries {
		id := entry.Name()
		if !validDigest(id) {
			return false, errors.New("invalid combined history identity")
		}
		files, err := limitedEntries(filepath.Join(parent, id), 64)
		if err != nil {
			return false, err
		}
		state := ""
		sequence := 0
		for _, file := range files {
			if combinedPartialName.MatchString(file.Name()) {
				continue
			}
			var index int
			if _, err = fmt.Sscanf(file.Name(), "%02d.json", &index); err != nil {
				return false, err
			}
			if index > sequence {
				data, err := readMetadata(root, filepath.Join("update", "combined", id, file.Name()))
				if err != nil {
					return false, err
				}
				var record struct {
					SchemaVersion  int    `json:"schemaVersion"`
					IdentitySHA256 string `json:"identitySha256"`
					PreviousSHA256 string `json:"previousSha256"`
					State          string `json:"state"`
				}
				if err = decodeMetadata(data, &record); err != nil {
					return false, err
				}
				state = record.State
				sequence = index
			}
		}
		if state != "Committed" && state != "AppSelected" && state != "DesktopReady" && state != "Committing" {
			continue
		}
		data, err := readMetadata(root, filepath.Join("update", "combined-contexts", id+".json"))
		if err != nil {
			return false, err
		}
		var binding struct {
			SchemaVersion int `json:"schemaVersion"`
			Identity      struct {
				ManifestSHA256           string `json:"manifestSha256"`
				SourcePointerSHA256      string `json:"sourcePointerSha256"`
				ServiceTransactionSHA256 string `json:"serviceTransactionSha256"`
			} `json:"identity"`
			IdentitySHA256 string `json:"identitySha256"`
			SourcePointer  string `json:"sourcePointer"`
			TargetPointer  string `json:"targetPointer"`
			LauncherSHA256 string `json:"launcherSha256"`
		}
		if err = decodeMetadata(data, &binding); err != nil {
			return false, err
		}
		identityBytes, err := json.Marshal(binding.Identity)
		if err != nil {
			return false, err
		}
		if binding.SchemaVersion != 1 || binding.IdentitySHA256 != id || metadataDigest(identityBytes) != id || !validDigest(binding.LauncherSHA256) {
			return false, errors.New("combined application context changed")
		}
		beforeBytes, err := base64.StdEncoding.Strict().DecodeString(binding.SourcePointer)
		if err != nil {
			return false, err
		}
		afterBytes, err := base64.StdEncoding.Strict().DecodeString(binding.TargetPointer)
		if err != nil {
			return false, err
		}
		if metadataDigest(beforeBytes) != binding.Identity.SourcePointerSHA256 {
			return false, errors.New("combined source pointer changed")
		}
		var before, after activation
		if err = decodeMetadata(beforeBytes, &before); err != nil {
			return false, err
		}
		if err = decodeMetadata(afterBytes, &after); err != nil {
			return false, err
		}
		if before.SchemaVersion != 1 || after.SchemaVersion != 1 || before.Generation == 0 || after.Generation != before.Generation+1 || after.Generation > 9007199254740991 || !newerJournalVersion(before.ActiveVersion, after.ActiveVersion) || !validDigest(before.ManifestSHA256) || !validDigest(after.ManifestSHA256) {
			return false, errors.New("invalid combined generation transition")
		}
		if existing, ok := successors[before]; ok && existing != after {
			return false, errors.New("conflicting combined generation history")
		}
		successors[before] = after
	}
	for range entries {
		next, ok := successors[previous]
		if !ok {
			return false, nil
		}
		if next == current {
			return true, nil
		}
		previous = next
	}
	return false, nil
}

var combinedPartialName = regexp.MustCompile(`^[a-f0-9-]+\.partial$`)

type pendingCombinedRecovery struct{ identity string }

func (e *pendingCombinedRecovery) Error() string {
	return "HoneyBee application/service update requires recovery: " + e.identity
}

var combinedTransitions = map[string][]string{
	"": {"Prepared"}, "Prepared": {"ServiceReady", "RollingBack"},
	"ServiceReady": {"AppSelected", "RollingBack"}, "AppSelected": {"DesktopReady", "RollingBack"},
	"DesktopReady": {"Committing", "RollingBack"}, "Committing": {"Committed", "RollingBack"},
	"RollingBack": {"RolledBack"}, "Committed": {}, "RolledBack": {},
}

// The ordinary launcher never starts user work during a pending service/app
// decision. Only the isolated Desktop probe for that exact journal can launch.
// This guard is not privileged journal authentication and does not execute recovery.
func requireCompletedCombinedUpdates(root string, cli bool, arguments []string) error {
	validation := ""
	for _, argument := range arguments {
		if strings.HasPrefix(argument, "--honeybee-update-validation=") {
			if cli || validation != "" {
				return errors.New("invalid validation launch")
			}
			validation = strings.TrimPrefix(argument, "--honeybee-update-validation=")
			if !validDigest(validation) {
				return errors.New("invalid validation identity")
			}
		}
	}
	directory := root
	for _, part := range []string{"update", "combined"} {
		directory = filepath.Join(directory, part)
		if err := plainLaunchDirectory(directory); err != nil {
			if os.IsNotExist(err) && validation == "" {
				return nil
			}
			return err
		}
	}
	entries, err := limitedEntries(directory, 256)
	if err != nil {
		return err
	}
	pending := 0
	pendingIdentity := ""
	for _, entry := range entries {
		if !validDigest(entry.Name()) {
			return errors.New("unrecognized combined journal")
		}
		relative := filepath.Join("update", "combined", entry.Name())
		if err := plainLaunchDirectory(filepath.Join(root, relative)); err != nil {
			return err
		}
		names, err := limitedEntries(filepath.Join(root, relative), 64)
		if err != nil {
			return err
		}
		sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })
		state, previous, count := "", entry.Name(), 0
		for _, name := range names {
			if combinedPartialName.MatchString(name.Name()) {
				continue
			}
			count++
			if count > 16 || name.Name() != fmt.Sprintf("%02d.json", count) {
				return errors.New("incomplete combined journal sequence")
			}
			data, err := readMetadata(root, filepath.Join(relative, name.Name()))
			if err != nil {
				return err
			}
			var record struct {
				SchemaVersion  int    `json:"schemaVersion"`
				IdentitySHA256 string `json:"identitySha256"`
				PreviousSHA256 string `json:"previousSha256"`
				State          string `json:"state"`
			}
			if err := decodeMetadata(data, &record); err != nil {
				return err
			}
			allowed := false
			for _, next := range combinedTransitions[state] {
				if next == record.State {
					allowed = true
				}
			}
			if !allowed || record.SchemaVersion != 1 || record.IdentitySHA256 != entry.Name() || record.PreviousSHA256 != previous {
				return errors.New("invalid combined journal decision")
			}
			state, previous = record.State, metadataDigest(data)
		}
		if state == "Committed" || state == "RolledBack" {
			continue
		}
		pending++
		if validation == "" {
			pendingIdentity = entry.Name()
			continue
		}
		if validation != entry.Name() || (state != "AppSelected" && state != "DesktopReady" && state != "Committing") {
			return errors.New("HoneyBee application/service update requires completion or recovery before normal launch")
		}
	}
	if validation == "" && pending > 0 {
		if pending != 1 {
			return errors.New("multiple incomplete combined updates require diagnostics")
		}
		return &pendingCombinedRecovery{pendingIdentity}
	}
	if validation != "" && pending != 1 {
		return errors.New("validation launch requires one matching pending combined update")
	}
	return nil
}
