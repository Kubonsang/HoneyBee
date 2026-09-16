package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Set only by the explicit recovery-enabled bootstrapper build.
var recoveryManifestSHA256 string

type recoveryInventory struct {
	SchemaVersion int               `json:"schemaVersion"`
	Files         map[string]string `json:"files"`
}

func pinnedRuntimeCommand(root, entry string, arguments ...string) (string, []string, error) {
	if !validDigest(recoveryManifestSHA256) {
		return "", nil, errors.New("this bootstrapper has no approved automatic recovery runtime")
	}
	relative := filepath.Join("recovery", "v1")
	bytes, err := readMetadata(root, filepath.Join(relative, "manifest.json"))
	if err != nil {
		return "", nil, err
	}
	if metadataDigest(bytes) != recoveryManifestSHA256 {
		return "", nil, errors.New("recovery runtime manifest differs from bootstrapper pin")
	}
	var inventory recoveryInventory
	if err := decodeMetadata(bytes, &inventory); err != nil {
		return "", nil, err
	}
	if inventory.SchemaVersion != 1 || len(inventory.Files) == 0 || len(inventory.Files) > 512 {
		return "", nil, errors.New("invalid recovery inventory")
	}
	for name, hash := range inventory.Files {
		if strings.ContainsAny(name, `\:`) || !filepath.IsLocal(filepath.FromSlash(name)) {
			return "", nil, errors.New("unsafe recovery path")
		}
		for _, part := range strings.Split(name, "/") {
			if part == "" || part == "." || part == ".." {
				return "", nil, errors.New("invalid recovery path component")
			}
		}
		if _, err := verifyFile(root, filepath.Join(relative, filepath.FromSlash(name)), hash); err != nil {
			return "", nil, err
		}
	}
	for _, name := range []string{"runtime/node.exe", "scripts/recovery/startup.mjs", "approved-source.json", "output/update-tools/honeybee-update-package.exe"} {
		if !validDigest(inventory.Files[name]) {
			return "", nil, errors.New("missing recovery payload")
		}
	}
	if !validDigest(inventory.Files[entry]) {
		return "", nil, errors.New("requested runtime entry is not pinned")
	}
	if (entry == "scripts/update/worker.mjs" || validDigest(inventory.Files["scripts/update/recovery-source.mjs"])) && !validDigest(inventory.Files["update-trust.json"]) {
		return "", nil, errors.New("update trust policy is not pinned")
	}
	args := []string{filepath.Join(root, relative, filepath.FromSlash(entry)), root}
	return filepath.Join(root, relative, "runtime", "node.exe"), append(args, arguments...), nil
}
func recoveryCommand(root, journal string) (string, []string, error) {
	if !activationDirectoryName.MatchString(journal) {
		return "", nil, errors.New("invalid recovery journal")
	}
	return pinnedRuntimeCommand(root, "scripts/recovery/startup.mjs", journal)
}
func runPinnedRecovery(root, journal string) error {
	executable, arguments, err := recoveryCommand(root, journal)
	if err != nil {
		return err
	}
	return runPinnedProcess(root, executable, arguments, 180*time.Second)
}
func runPinnedProcess(root, executable string, arguments []string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, executable, arguments...)
	configureRecoveryProcess(command)
	command.Dir = root
	for _, value := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(value, "=", 2)[0])
		if key != "NODE_OPTIONS" && key != "NODE_PATH" && key != "ELECTRON_RUN_AS_NODE" {
			command.Env = append(command.Env, value)
		}
	}
	// Output is deliberately not inherited: the runtime prints no authorization secrets.
	// Durable activation records remain the recovery authority, never an exit code alone.
	if err := command.Run(); err != nil {
		return fmt.Errorf("approved runtime could not complete; installation evidence retained: %w", err)
	}
	return nil
}
func resolveWithRecovery(executable string, arguments []string) (launchPlan, error) {
	plan, err := resolveLaunch(executable, arguments)
	var combined *pendingCombinedRecovery
	if errors.As(err, &combined) {
		root, _, rootErr := installationRoot(executable)
		if rootErr != nil {
			return launchPlan{}, rootErr
		}
		program, args, commandErr := pinnedRuntimeCommand(root, "scripts/recovery/combined.mjs", combined.identity)
		if commandErr != nil {
			return launchPlan{}, commandErr
		}
		if commandErr = runPinnedProcess(root, program, args, 30*time.Minute); commandErr != nil {
			return launchPlan{}, commandErr
		}
		return resolveLaunch(executable, arguments)
	}
	var repair *pendingApplicationRepair
	if errors.As(err, &repair) {
		root, _, rootErr := installationRoot(executable)
		if rootErr != nil {
			return launchPlan{}, rootErr
		}
		program, args, commandErr := pinnedRuntimeCommand(root, "scripts/recovery/repair.mjs", repair.name)
		if commandErr != nil {
			return launchPlan{}, commandErr
		}
		if commandErr = runPinnedProcess(root, program, args, 180*time.Second); commandErr != nil {
			return launchPlan{}, commandErr
		}
		return resolveLaunch(executable, arguments)
	}
	var pending *pendingRecovery
	if !errors.As(err, &pending) {
		return plan, err
	}
	root, _, rootError := installationRoot(executable)
	if rootError != nil {
		return launchPlan{}, rootError
	}
	if err := runPinnedRecovery(root, pending.directory); err != nil {
		return launchPlan{}, err
	}
	// Exactly one attempt, followed by all normal journal, pointer and payload checks.
	return resolveLaunch(executable, arguments)
}
