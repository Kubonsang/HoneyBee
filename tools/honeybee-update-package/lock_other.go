//go:build !windows

package main

import "errors"

func holdUpdateLock(string) error { return errors.New("update locking requires Windows") }
