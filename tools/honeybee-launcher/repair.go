package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

var repairDirectoryName = regexp.MustCompile(`^repair-[A-Za-z0-9]+$`)

type pendingApplicationRepair struct{ name string }

func (p *pendingApplicationRepair) Error() string {
	return "HoneyBee application Repair requires recovery: " + p.name
}

func requireCompletedApplicationRepairs(root string) error {
	base := filepath.Join(root, "update", "app-repairs")
	if err := plainLaunchDirectory(base); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	entries, err := limitedEntries(base, 256)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !repairDirectoryName.MatchString(entry.Name()) {
			return errors.New("unknown application Repair entry")
		}
		relative := filepath.Join("update", "app-repairs", entry.Name())
		bytes, err := readMetadata(root, filepath.Join(relative, "intent.json"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		var intent struct {
			SchemaVersion       int    `json:"schemaVersion"`
			Version             string `json:"version"`
			SourcePointerSHA256 string `json:"sourcePointerSha256"`
		}
		if err := decodeMetadata(bytes, &intent); err != nil {
			return err
		}
		if intent.SchemaVersion != 1 || !journalVersionName.MatchString(intent.Version) || !validDigest(intent.SourcePointerSHA256) {
			return errors.New("invalid application Repair intent")
		}
		done, err := readMetadata(root, filepath.Join(relative, "complete.json"))
		if os.IsNotExist(err) {
			return &pendingApplicationRepair{entry.Name()}
		}
		if err != nil {
			return err
		}
		var completion struct {
			SchemaVersion int    `json:"schemaVersion"`
			IntentSHA256  string `json:"intentSha256"`
		}
		if err := decodeMetadata(done, &completion); err != nil {
			return err
		}
		if completion.SchemaVersion != 1 || completion.IntentSHA256 != metadataDigest(bytes) {
			return errors.New("invalid application Repair completion")
		}
	}
	return nil
}
