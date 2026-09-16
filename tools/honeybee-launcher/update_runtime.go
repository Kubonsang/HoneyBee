package main

import (
	"errors"
	"regexp"
	"time"
)

var updateJobName = regexp.MustCompile(`^job-[A-Za-z0-9]+$`)

func updateCommand(root, job, digest string) (string, []string, error) {
	if !updateJobName.MatchString(job) || !validDigest(digest) {
		return "", nil, errors.New("invalid update job binding")
	}
	return pinnedRuntimeCommand(root, "scripts/update/worker.mjs", job, digest)
}

func runUpdateJob(executable string, arguments []string) error {
	if len(arguments) != 3 {
		return errors.New("update job requires name and digest")
	}
	root, cli, err := installationRoot(executable)
	if err != nil {
		return err
	}
	if cli {
		return errors.New("update jobs require the desktop bootstrapper")
	}
	// Refuse admission while an earlier activation/recovery is pending.
	if _, err := resolveLaunch(executable, nil); err != nil {
		return err
	}
	node, args, err := updateCommand(root, arguments[1], arguments[2])
	if err != nil {
		return err
	}
	return runPinnedProcess(root, node, args, 30*time.Minute)
}
