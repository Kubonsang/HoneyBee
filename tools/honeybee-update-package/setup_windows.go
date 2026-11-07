//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Hold a Windows handle denying writes and deletion from hashing until Setup exits.
// A check followed by an unlocked CreateProcess would permit executable replacement.
type setupReadLease struct {
	*os.File
	parents []syscall.Handle
}

func (lease *setupReadLease) Close() error {
	err := lease.File.Close()
	for i := len(lease.parents) - 1; i >= 0; i-- {
		err = errors.Join(err, syscall.CloseHandle(lease.parents[i]))
	}
	return err
}

func openSetupReadLease(executable string) (*setupReadLease, error) {
	if err := plainDir(filepath.Dir(executable)); err != nil {
		return nil, err
	}
	// Lock ancestors from the volume down before opening the executable. A file
	// lease alone does not protect its path if an ancestor directory is renamed.
	var directories []string
	for directory := filepath.Dir(executable); ; directory = filepath.Dir(directory) {
		directories = append(directories, directory)
		if filepath.Dir(directory) == directory {
			break
		}
	}
	var parents []syscall.Handle
	retained := false
	defer func() {
		if !retained {
			for _, handle := range parents {
				syscall.CloseHandle(handle)
			}
		}
	}()
	for i := len(directories) - 1; i >= 0; i-- {
		name, err := syscall.UTF16PtrFromString(directories[i])
		if err != nil {
			return nil, err
		}
		handle, err := syscall.CreateFile(name, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return nil, err
		}
		parents = append(parents, handle)
		var info syscall.ByHandleFileInformation
		if err := syscall.GetFileInformationByHandle(handle, &info); err != nil {
			return nil, err
		}
		if info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return nil, errors.New("redirected Setup ancestor")
		}
	}
	name, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(handle), executable)
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &info); err != nil {
		file.Close()
		return nil, err
	}
	if info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		file.Close()
		return nil, errors.New("redirected Setup")
	}
	retained = true
	return &setupReadLease{File: file, parents: parents}, nil
}

func runVerifiedSetup(executable, expectedSHA, expectedSize, root, mode string) error {
	if !filepath.IsAbs(executable) || filepath.Base(executable) != "HoneyBeeSetup.exe" || !filepath.IsAbs(root) || strings.ContainsAny(root, "\"\r\n\x00") {
		return errors.New("invalid Setup path")
	}
	if mode != "repair" && mode != "transition" {
		return errors.New("invalid Setup mode")
	}
	if err := plainDir(root); err != nil {
		return err
	}
	execution, err := activityHandle(filepath.Join(root, "update"), "setup-execution.lock", false)
	if err != nil {
		return errors.New("another Setup execution is active")
	}
	defer syscall.CloseHandle(execution)
	size, err := strconv.ParseInt(expectedSize, 10, 64)
	if err != nil || size <= 0 || size > maxArchive {
		return errors.New("invalid Setup size")
	}
	digest, err := hex.DecodeString(expectedSHA)
	if err != nil || len(digest) != 32 || strings.ToLower(expectedSHA) != expectedSHA {
		return errors.New("invalid Setup digest")
	}
	file, err := openSetupReadLease(executable)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, size+1))
	if err != nil {
		return err
	}
	if n != size || hex.EncodeToString(hash.Sum(nil)) != expectedSHA {
		return errors.New("Setup changed before execution")
	}
	// NSIS /D is deliberately last and unquoted, including paths with spaces.
	// No shell, silent install, arbitrary arguments or automatic adoption is allowed.
	flag := "/REPAIR"
	if mode == "transition" {
		flag = "/INSTALLSERVICE"
	}
	cmd := exec.Command(executable)
	cmd.Dir = filepath.Dir(executable)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: syscall.EscapeArg(executable) + " " + flag + " /D=" + root}
	err = cmd.Run()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return err
		}
		code = exit.ExitCode()
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"schemaVersion": 1, "exitCode": code})
}
