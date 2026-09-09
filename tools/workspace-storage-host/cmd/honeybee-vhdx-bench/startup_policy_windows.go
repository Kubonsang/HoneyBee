//go:build windows

package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

type startupKey struct{}
type startupOptions struct {
	Diagnostics bool
	Trace       bool
}

func metadataCopy(source, target string) error {
	var dirs [][2]string
	err := filepath.Walk(source, func(p string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if err = regularNode(p, info); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, p)
		if err != nil {
			return err
		}
		dst := filepath.Join(target, rel)
		if info.IsDir() {
			dirs = append(dirs, [2]string{p, dst})
			return nil
		}
		return restoreMetadata(p, dst)
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err = restoreMetadata(dirs[i][0], dirs[i][1]); err != nil {
			return err
		}
	}
	return nil
}

func restoreMetadata(source, target string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if err = regularNode(source, info); err != nil {
		return err
	}
	dstInfo, err := os.Lstat(target)
	if err != nil {
		return err
	}
	if err = regularNode(target, dstInfo); err != nil {
		return err
	}
	data := info.Sys().(*syscall.Win32FileAttributeData)
	p, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(p, windows.FILE_WRITE_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return err
	}
	ft := func(v syscall.Filetime) *windows.Filetime {
		return &windows.Filetime{LowDateTime: v.LowDateTime, HighDateTime: v.HighDateTime}
	}
	err = windows.SetFileTime(h, ft(data.CreationTime), ft(data.LastAccessTime), ft(data.LastWriteTime))
	err = errors.Join(err, windows.CloseHandle(h))
	if err != nil {
		return err
	}
	attrs := data.FileAttributes & (windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM | windows.FILE_ATTRIBUTE_ARCHIVE)
	if attrs == 0 {
		attrs = windows.FILE_ATTRIBUTE_NORMAL
	}
	return windows.SetFileAttributes(p, attrs)
}

func graphSeedFile(name string) bool {
	if name == "TundraBuildState.state" || name == "TundraBuildState.state.map" {
		return true
	}
	if strings.HasSuffix(name, "-inputdata.json") {
		return true
	}
	for _, suffix := range []string{".dag", ".dag.json", ".dag.outputdata", ".dag.payloads", ".dag_derived", ".dag_fsmtime"} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

func applyStartupPolicy(ctx context.Context, policy, mount, external, seed string) error {
	if ctx.Value(startupKey{}) == nil {
		return nil
	}
	switch policy {
	case "A-legacy", "E-control":
		return nil
	case "E-metadata":
		return metadataCopy(seed, external)
	case "E-pid":
		p := filepath.Join(mount, "ilpp.pid")
		info, err := os.Lstat(p)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if err = regularNode(p, info); err != nil {
			return err
		}
		return os.Remove(p)
	case "E-graph", "E-dag":
		entries, err := os.ReadDir(external)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if policy == "E-dag" && strings.HasPrefix(entry.Name(), "TundraBuildState.") {
				continue
			}
			if !graphSeedFile(entry.Name()) {
				continue
			}
			p := filepath.Join(external, entry.Name())
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if err = regularNode(p, info); err != nil {
				return err
			}
			if info.IsDir() {
				return errors.New("graph seed entry is a directory")
			}
			if err = os.Remove(p); err != nil {
				return err
			}
		}
		return nil
	}
	return errors.New("unknown startup policy")
}

func startupSnapshot(ctx context.Context, root, name, external string) error {
	opts, ok := ctx.Value(startupKey{}).(startupOptions)
	if !ok || !opts.Diagnostics || external == "" {
		return nil
	}
	rows := map[string]any{}
	err := filepath.Walk(external, func(p string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if err = regularNode(p, info); err != nil {
			return err
		}
		rel, err := filepath.Rel(external, p)
		if err != nil {
			return err
		}
		data := info.Sys().(*syscall.Win32FileAttributeData)
		row := map[string]any{"directory": info.IsDir(), "bytes": info.Size(), "creation": data.CreationTime.Nanoseconds(), "access": data.LastAccessTime.Nanoseconds(), "write": data.LastWriteTime.Nanoseconds(), "attributes": data.FileAttributes}
		if !info.IsDir() {
			hash, e := hashFileRecord(p)
			if e != nil {
				return e
			}
			row["sha256"] = hash.SHA256
		}
		rows[filepath.ToSlash(rel)] = row
		return nil
	})
	if err != nil {
		return err
	}
	return save(filepath.Join(root, name+"-bee-snapshot.json"), rows)
}

func startupProfiles(ctx context.Context, root, name, external string) error {
	opts, ok := ctx.Value(startupKey{}).(startupOptions)
	if !ok || !opts.Diagnostics || external == "" {
		return nil
	}
	entries, err := os.ReadDir(external)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		n := entry.Name()
		if strings.HasSuffix(n, ".traceevents") || n == "fullprofile.json" || n == "tundra.log.json" {
			if err = copyFile(filepath.Join(external, n), filepath.Join(root, name+"-profile-"+n)); err != nil {
				return err
			}
		}
	}
	return nil
}
