//go:build !windows

package main

import "errors"

func holdActivity(directory, mode, timeout string) error {
	return errors.New("application activity locking requires Windows")
}
