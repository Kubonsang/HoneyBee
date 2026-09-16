package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--installation-capabilities" {
		fmt.Println(`{"schemaVersion":1,"combinedLaunchGate":1,"combinedRecovery":1,"isolatedDesktopValidation":1,"applicationRepairGate":1,"setupActivation":1}`)
		return
	}
	executable, err := os.Executable()
	code := 1
	if err == nil {
		if len(os.Args) == 2 && os.Args[1] == "--verify-recovery-runtime" {
			var root string
			var cli bool
			root, cli, err = installationRoot(executable)
			if err == nil && !cli {
				_, _, err = pinnedRuntimeCommand(root, "scripts/recovery/repair.mjs")
				if err == nil {
					fmt.Printf("{\"schemaVersion\":1,\"recoveryManifestSha256\":\"%s\"}\n", recoveryManifestSHA256)
					code = 0
				}
			}
		} else if len(os.Args) > 1 && os.Args[1] == "--update-job" {
			err = runUpdateJob(executable, os.Args[1:])
			if err == nil {
				code = 0
			}
		} else {
			var plan launchPlan
			plan, err = resolveWithRecovery(executable, os.Args[1:])
			if err == nil {
				code, err = launch(plan, os.Stdin, os.Stdout, os.Stderr)
			}
		}
	}
	if err != nil {
		message := fmt.Sprintf("HoneyBee could not launch. Update and recovery records were preserved.\n\n%v", err)
		_, cli, _ := installationRoot(executable)
		reportError(message, cli)
		code = 1
	}
	os.Exit(code)
}
