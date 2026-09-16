//go:build !windows

package main

import "errors"

func runContainedDoctor(node, cli, directory, timeout string) error {
	return errors.New("Doctor containment requires Windows")
}
