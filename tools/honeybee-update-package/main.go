package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxFile = int64(2 << 30)
const maxTotal = int64(8 << 30)
const maxArchive = int64(4 << 30)
const maxEntries = 20000

type entry struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Deliberately narrow Windows path contract, also enforced when building a package.
func safeName(name string) error {
	if len(name) == 0 || len(name) > 220 || strings.ContainsAny(name, "\\:<>\"|?*\x00") {
		return errors.New("unsafe archive path")
	}
	parts := strings.Split(name, "/")
	if len(parts) > 20 {
		return errors.New("path depth exceeded")
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." || strings.TrimRight(p, " .") != p {
			return errors.New("unsafe path segment")
		}
		for _, r := range p {
			if r < 32 || r > 126 {
				return errors.New("non-ASCII package path")
			}
		}
		base := strings.ToUpper(strings.Split(p, ".")[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9') {
			return errors.New("Windows device path")
		}
	}
	if len(parts) == 1 && (name == "launch.json" || name == "installation.json") {
		return nil
	}
	if len(parts) > 1 && (parts[0] == "desktop" || parts[0] == "cli" || parts[0] == "tools" || parts[0] == "runtime") {
		return nil
	}
	return errors.New("entry outside application payload")
}
func plainDir(name string) error {
	abs, err := filepath.Abs(name)
	if err != nil {
		return err
	}
	for p := abs; ; p = filepath.Dir(p) {
		s, e := os.Lstat(p)
		if e != nil {
			return e
		}
		if !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
			return errors.New("redirected directory")
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return err
	}
	if !strings.EqualFold(resolved, abs) {
		return errors.New("redirected directory")
	}
	return nil
}
func digestReader(r io.Reader, limit int64) (entry, error) {
	h := sha256.New()
	n, e := io.Copy(h, io.LimitReader(r, limit+1))
	if e != nil {
		return entry{}, e
	}
	if n > limit {
		return entry{}, errors.New("size limit exceeded")
	}
	return entry{n, hex.EncodeToString(h.Sum(nil))}, nil
}
func extract(archive, destination, expected string) (map[string]entry, error) {
	if len(expected) != 64 {
		return nil, errors.New("SHA-256 required")
	}
	if err := plainDir(filepath.Dir(archive)); err != nil {
		return nil, err
	}
	info, err := os.Lstat(archive)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxArchive {
		return nil, errors.New("invalid archive file")
	}
	f, err := os.Open(archive)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	digest, err := digestReader(f, maxArchive)
	if err != nil {
		return nil, err
	}
	if digest.SHA256 != expected {
		return nil, errors.New("archive SHA-256 mismatch")
	}
	z, err := zip.NewReader(f, digest.Size)
	if err != nil {
		return nil, err
	}
	if len(z.File) == 0 || len(z.File) > maxEntries {
		return nil, errors.New("entry count exceeded")
	}
	seen := map[string]bool{}
	spellings := map[string]string{}
	total := int64(0)
	for _, item := range z.File {
		if err := safeName(item.Name); err != nil {
			return nil, err
		}
		for p := item.Name; p != "."; p = filepath.ToSlash(filepath.Dir(p)) {
			key := strings.ToLower(p)
			if old, ok := spellings[key]; ok && old != p {
				return nil, errors.New("case-aliased path")
			}
			spellings[key] = p
		}
		key := strings.ToLower(item.Name)
		if seen[key] || !item.Mode().IsRegular() || item.Flags&1 != 0 || item.ExternalAttrs&0x400 != 0 || (item.Method != zip.Store && item.Method != zip.Deflate) {
			return nil, errors.New("duplicate or unsupported ZIP entry")
		}
		seen[key] = true
		if item.UncompressedSize64 > uint64(maxFile) {
			return nil, errors.New("entry size exceeded")
		}
		total += int64(item.UncompressedSize64)
		if total > maxTotal {
			return nil, errors.New("expanded size exceeded")
		}
	}
	for name := range seen {
		for p := filepath.ToSlash(filepath.Dir(name)); p != "."; p = filepath.ToSlash(filepath.Dir(p)) {
			if seen[p] {
				return nil, errors.New("file/directory collision")
			}
		}
	}
	if err := plainDir(filepath.Dir(destination)); err != nil {
		return nil, err
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return nil, err
	} // never reuse or overwrite
	inventory := map[string]entry{}
	for _, item := range z.File {
		target := filepath.Join(destination, filepath.FromSlash(item.Name))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return nil, err
		}
		if err := plainDir(filepath.Dir(target)); err != nil {
			return nil, err
		}
		input, err := item.Open()
		if err != nil {
			return nil, err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			input.Close()
			return nil, err
		}
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(output, h), io.LimitReader(input, int64(item.UncompressedSize64)+1))
		readErr := input.Close()
		syncErr := output.Sync()
		closeErr := output.Close()
		if err := errors.Join(copyErr, readErr, syncErr, closeErr); err != nil {
			return nil, err
		}
		if n != int64(item.UncompressedSize64) {
			return nil, errors.New("expanded entry size mismatch")
		}
		inventory[item.Name] = entry{n, hex.EncodeToString(h.Sum(nil))}
	}
	return inventory, nil
}
func pack(source, target string) error {
	if err := plainDir(source); err != nil {
		return err
	}
	var names []string
	total := int64(0)
	err := filepath.WalkDir(source, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("redirected source")
		}
		if d.IsDir() {
			return plainDir(p)
		}
		relative, e := filepath.Rel(source, p)
		if e != nil {
			return e
		}
		relative = filepath.ToSlash(relative)
		if e := safeName(relative); e != nil {
			return e
		}
		s, e := d.Info()
		if e != nil {
			return e
		}
		if !s.Mode().IsRegular() || s.Size() > maxFile {
			return errors.New("invalid source file")
		}
		total += s.Size()
		names = append(names, relative)
		if total > maxTotal || len(names) > maxEntries {
			return errors.New("package limit exceeded")
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(names) == 0 {
		return errors.New("empty package")
	}
	if err := plainDir(filepath.Dir(target)); err != nil {
		return err
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer out.Close()
	z := zip.NewWriter(out)
	for _, name := range names {
		input, e := os.Open(filepath.Join(source, filepath.FromSlash(name)))
		if e != nil {
			return e
		}
		w, e := z.Create(name)
		if e == nil {
			_, e = io.Copy(w, input)
		}
		input.Close()
		if e != nil {
			return e
		}
	}
	if err := z.Close(); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	s, err := out.Stat()
	if err != nil {
		return err
	}
	if s.Size() > maxArchive {
		return errors.New("archive limit exceeded")
	}
	return nil
}
func main() {
	var err error
	if len(os.Args) == 5 && os.Args[1] == "activity" {
		err = holdActivity(os.Args[2], os.Args[3], os.Args[4])
	} else if len(os.Args) == 6 && os.Args[1] == "doctor" {
		err = runContainedDoctor(os.Args[2], os.Args[3], os.Args[4], os.Args[5])
	} else if len(os.Args) == 3 && os.Args[1] == "lock" {
		err = holdUpdateLock(os.Args[2])
	} else if len(os.Args) == 4 && os.Args[1] == "pack" {
		err = pack(os.Args[2], os.Args[3])
	} else if len(os.Args) == 5 && os.Args[1] == "extract" {
		var result map[string]entry
		result, err = extract(os.Args[2], os.Args[3], os.Args[4])
		if err == nil {
			err = json.NewEncoder(os.Stdout).Encode(result)
		}
	} else {
		err = errors.New("usage: honeybee-update-package pack SOURCE ZIP | extract ZIP NEW_DIRECTORY SHA256")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
