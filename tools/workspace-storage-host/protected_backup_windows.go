//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Every object is born with the maintenance owner and protected DACL. Applying
// permissions after copying would leave a window where inherited ownership could
// authorize a user to change recovery inputs.
func (area *maintenanceArea) captureBackup(name string, inputs []coldBackupInput, assertQuiet func() error) (string, error) {
	output, closeOutput, check, err := area.backupOutput(name, assertQuiet)
	if err != nil {
		return "", err
	}
	defer closeOutput()
	return captureColdFilesTo(filepath.Join(area.Path, name), inputs, check, output)
}

func (area *maintenanceArea) backupOutput(name string, assertQuiet func() error) (coldBackupOutput, func(), func() error, error) {
	if err := validateColdBackupName(name); err != nil {
		return coldBackupOutput{}, nil, nil, err
	}
	if strings.Contains(name, "/") || assertQuiet == nil {
		return coldBackupOutput{}, nil, nil, errors.New("backup requires one name and quiescence authority")
	}
	if err := area.assertHeld(); err != nil {
		return coldBackupOutput{}, nil, nil, err
	}
	guards := map[string]windows.Handle{}
	closeOutput := func() {
		for _, handle := range guards {
			_ = windows.CloseHandle(handle)
		}
		clear(guards)
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertQuiet()
	}
	output := coldBackupOutput{
		createRoot: func() error {
			if err := check(); err != nil {
				return err
			}
			handle, err := privateMaintenanceChild(area.directory, name, true, windows.FILE_CREATE)
			if err == nil {
				guards[""] = handle
			}
			return err
		},
		prepareParent: func(entry string) error {
			if err := check(); err != nil {
				return err
			}
			if err := validateColdBackupName(entry); err != nil {
				return err
			}
			parent := ""
			parts := strings.Split(entry, "/")
			for _, part := range parts[:len(parts)-1] {
				key := strings.ToLower(strings.TrimPrefix(parent+"/"+part, "/"))
				if _, ok := guards[key]; !ok {
					handle, err := privateMaintenanceChild(guards[parent], part, true, windows.FILE_CREATE)
					if err != nil {
						return err
					}
					guards[key] = handle
				}
				parent = key
			}
			return nil
		},
		createFile: func(entry string) (*os.File, error) {
			if err := check(); err != nil {
				return nil, err
			}
			if err := validateColdBackupName(entry); err != nil {
				return nil, err
			}
			parts := strings.Split(entry, "/")
			parent := strings.ToLower(strings.Join(parts[:len(parts)-1], "/"))
			handle, ok := guards[parent]
			if !ok {
				return nil, errors.New("backup parent is not held")
			}
			file, err := privateMaintenanceChild(handle, parts[len(parts)-1], false, windows.FILE_CREATE)
			if err != nil {
				return nil, err
			}
			return os.NewFile(uintptr(file), filepath.Join(area.Path, name, filepath.FromSlash(entry))), nil
		},
	}
	return output, closeOutput, check, nil
}
