//go:build !windows

package main

import "errors"

func holdSetupRecoveryLock(string) error { return errors.New("Setup recovery requires Windows") }
func runVerifiedSetup(string, string, string, string, string) error {
	return errors.New("Setup execution requires Windows")
}
