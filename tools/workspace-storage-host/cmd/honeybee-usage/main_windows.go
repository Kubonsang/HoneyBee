//go:build windows

// honeybee-usage is a non-elevated, read-only file measurement companion.
// It never attaches volumes, writes journals, starts a service or deletes files.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type Workspace struct {
	ID                 string `json:"workspaceId"`
	Path               string `json:"workspacePath"`
	UnityRelativePath  string `json:"unityRelativePath"`
	LeaseID            string `json:"leaseId"`
	ParentID           string `json:"parentId"`
	StorageWorkspaceID string `json:"storageWorkspaceId"`
	ConsumerID         string `json:"consumerId"`
}
type Request struct {
	SchemaVersion int         `json:"schemaVersion"`
	Workspaces    []Workspace `json:"workspaces"`
	CacheRoots    []string    `json:"cacheRoots"`
}
type Entry struct {
	ID             string   `json:"id"`
	Kind           string   `json:"kind"`
	Scope          string   `json:"scope"`
	WorkspaceID    string   `json:"workspaceId,omitempty"`
	LogicalBytes   *int64   `json:"logicalBytes"`
	AllocatedBytes *int64   `json:"allocatedBytes"`
	FileCount      int      `json:"fileCount"`
	OmittedLinks   int      `json:"omittedLinks"`
	Complete       bool     `json:"complete"`
	Errors         []string `json:"errors"`
}
type Report struct {
	SchemaVersion       int     `json:"schemaVersion"`
	MeasuredAt          string  `json:"measuredAt"`
	Entries             []Entry `json:"entries"`
	KnownAllocatedBytes int64   `json:"knownAllocatedBytes"`
	Complete            bool    `json:"complete"`
}
type Receipt struct {
	SchemaVersion int    `json:"schemaVersion"`
	StoreRoot     string `json:"storeRoot"`
	UserSID       string `json:"userSid"`
	ServiceName   string `json:"serviceName"`
}
type Journal struct {
	Layout         string `json:"layout"`
	OwnershipToken string `json:"ownershipToken"`
	SchemaVersion  int    `json:"schemaVersion"`
	LeaseID        string `json:"leaseId"`
	RunID          string `json:"runId"`
	WorkspaceID    string `json:"workspaceId"`
	UserSID        string `json:"userSid"`
	ParentKey      string `json:"parentKey"`
	ParentPath     string `json:"parentPath"`
	ChildPath      string `json:"childPath"`
}

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var allocatedProc = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetCompressedFileSizeW")
var standardInfoProc = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetFileInformationByHandleEx")

func main() {
	var request Request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 4<<20))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&request)
	var trailing any
	if err == nil && !errors.Is(decoder.Decode(&trailing), io.EOF) {
		err = errors.New("trailing input")
	}
	if err == nil && (request.SchemaVersion != 1 || len(request.Workspaces) > 1000 || len(request.CacheRoots) > 1000) {
		err = errors.New("invalid usage request")
	}
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
	report := measure(request)
	if err = json.NewEncoder(os.Stdout).Encode(report); err != nil {
		os.Exit(1)
	}
}
func linked(info fs.FileInfo) bool {
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return info.Mode()&os.ModeSymlink != 0 || (ok && data.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0)
}
func safe(target string) error {
	if !filepath.IsAbs(target) {
		return errors.New("measurement path must be absolute")
	}
	for p := filepath.Clean(target); ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil && linked(info) {
			return fmt.Errorf("link omitted: %s", p)
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	return nil
}
func readJSON(p string, out any) error {
	if err := safe(p); err != nil {
		return err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}
func receipt() (Receipt, error) {
	var r Receipt
	err := readJSON(filepath.Join(os.Getenv("ProgramData"), "UnityWorkspaceStorage", "install-receipt.json"), &r)
	if err != nil {
		return r, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return r, err
	}
	if r.SchemaVersion != 2 || r.ServiceName != "UnityWorkspaceStorage" || r.UserSID != user.User.Sid.String() || !filepath.IsAbs(r.StoreRoot) {
		return r, errors.New("storage receipt identity mismatch")
	}
	return r, nil
}
func measure(req Request) Report {
	report := Report{SchemaVersion: 1, MeasuredAt: time.Now().UTC().Format(time.RFC3339Nano), Entries: []Entry{}, Complete: true}
	global := map[string]bool{}
	shared := map[string]bool{}
	missingParents := map[string]error{}
	appendEntry := func(e Entry) {
		report.Entries = append(report.Entries, e)
		report.Complete = report.Complete && e.Complete
	}
	r, receiptErr := receipt()
	for _, w := range req.Workspaces {
		if !identifier.MatchString(w.ID) || !identifier.MatchString(w.LeaseID) || !digest.MatchString(w.ParentID) || !filepath.IsLocal(w.UnityRelativePath) {
			appendEntry(unknown(w.ID, "files", "workspace", w.ID, errors.New("invalid workspace identity")))
			continue
		}
		unity := filepath.Join(w.Path, w.UnityRelativePath)
		cache := filepath.Join(unity, ".testplay", "cache")
		appendEntry(scan(w.ID+":files", "files", "workspace", w.ID, w.Path, []string{filepath.Join(unity, "Library"), cache}, false, global, &report.KnownAllocatedBytes))
		appendEntry(scan(w.ID+":testplay", "testplay-local", "workspace", w.ID, cache, nil, true, global, &report.KnownAllocatedBytes))
		storageErr := receiptErr
		var j Journal
		child, parent := "", ""
		if storageErr == nil {
			userRoot := filepath.Join(r.StoreRoot, r.UserSID)
			child = filepath.Join(userRoot, "children", w.LeaseID+".vhdx")
			parent = filepath.Join(userRoot, "parents", w.ParentID, "parent.vhdx")
			storageErr = readJSON(filepath.Join(userRoot, "leases", w.LeaseID+".json"), &j)
			if storageErr == nil && (j.SchemaVersion != 2 || j.LeaseID != w.LeaseID || j.WorkspaceID != w.StorageWorkspaceID || j.RunID != w.ConsumerID || j.UserSID != r.UserSID || j.ParentKey != w.ParentID || !same(j.ChildPath, child) || !same(j.ParentPath, parent)) {
				storageErr = errors.New("lease ownership mismatch")
			}
		}
		if storageErr != nil {
			appendEntry(unknown(w.ID+":child", "child-vhdx", "workspace", w.ID, storageErr))
		} else {
			appendEntry(scan(w.ID+":child", "child-vhdx", "workspace", w.ID, child, nil, false, global, &report.KnownAllocatedBytes))
			if j.Layout != "" {
				bee := strings.TrimSuffix(child, ".vhdx") + ".bee"
				var owner struct{ Layout, LeaseID, ParentKey, OwnershipToken string }
				err := readJSON(filepath.Join(bee, "owner.json"), &owner)
				if err == nil && (j.Layout != "external-bee-dag-v1" || owner.Layout != j.Layout || owner.LeaseID != j.LeaseID || owner.ParentKey != j.ParentKey || owner.OwnershipToken == "" || owner.OwnershipToken != j.OwnershipToken) {
					err = errors.New("external Bee ownership mismatch")
				}
				if err != nil {
					appendEntry(unknown(w.ID+":bee", "external-bee", "workspace", w.ID, err))
				} else {
					appendEntry(scan(w.ID+":bee", "external-bee", "workspace", w.ID, bee, nil, false, global, &report.KnownAllocatedBytes))
				}
			}
		}
		sharedID := "parent:" + w.ParentID
		if storageErr != nil {
			missingParents[sharedID] = storageErr
		}
		if !shared[sharedID] {
			// Do not let an unverifiable legacy lease hide a later verified parent's measurement.
			if storageErr == nil {
				shared[sharedID] = true
				appendEntry(scan(sharedID, "parent-vhdx", "shared", "", parent, nil, false, global, &report.KnownAllocatedBytes))
				if j.Layout == "external-bee-dag-v1" {
					appendEntry(scan(sharedID+":bee", "bee-seed", "shared", "", filepath.Join(filepath.Dir(parent), "bee-seed"), nil, false, global, &report.KnownAllocatedBytes))
				}
			}
		}
	}
	for id, err := range missingParents {
		if !shared[id] {
			appendEntry(unknown(id, "parent-vhdx", "shared", "", err))
		}
	}
	for _, root := range req.CacheRoots {
		id := "testplay:" + strings.ToLower(filepath.Clean(root))
		if shared[id] {
			continue
		}
		shared[id] = true
		appendEntry(scan(id, "testplay-shared", "shared", "", root, nil, true, global, &report.KnownAllocatedBytes))
	}
	return report
}
func same(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }
func unknown(id, kind, scope, workspace string, err error) Entry {
	return Entry{ID: id, Kind: kind, Scope: scope, WorkspaceID: workspace, Complete: false, Errors: []string{err.Error()}}
}
func scan(id, kind, scope, workspace, root string, excludes []string, optional bool, global map[string]bool, total *int64) Entry {
	e := Entry{ID: id, Kind: kind, Scope: scope, WorkspaceID: workspace, Complete: true, Errors: []string{}}
	if err := safe(root); err != nil {
		return unknown(id, kind, scope, workspace, err)
	}
	if _, err := os.Lstat(root); err != nil {
		if optional && os.IsNotExist(err) {
			zero := int64(0)
			e.LogicalBytes = &zero
			e.AllocatedBytes = &zero
			return e
		}
		return unknown(id, kind, scope, workspace, err)
	}
	logical, allocated := int64(0), int64(0)
	local := map[string]bool{}
	issue := func(err error) {
		e.Complete = false
		if len(e.Errors) < 20 {
			e.Errors = append(e.Errors, err.Error())
		}
	}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		for _, exclude := range excludes {
			if same(p, exclude) {
				if d != nil && d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if err != nil {
			issue(err)
			return nil
		}
		info, err := d.Info()
		if err != nil {
			issue(err)
			return nil
		}
		if linked(info) {
			e.OmittedLinks++
			issue(fmt.Errorf("link omitted: %s", p))
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			issue(fmt.Errorf("special file omitted: %s", p))
			return nil
		}
		identity, size, err := fileUsage(p)
		if err != nil {
			issue(err)
			return nil
		}
		e.FileCount++
		logical += info.Size()
		if !local[identity] {
			local[identity] = true
			allocated += size
		}
		if !global[identity] {
			global[identity] = true
			*total += size
		}
		return nil
	})
	if err != nil {
		issue(err)
	}
	e.LogicalBytes = &logical
	e.AllocatedBytes = &allocated
	return e
}
func fileUsage(p string) (string, int64, error) {
	pointer, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return "", 0, err
	}
	handle, err := windows.CreateFile(pointer, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return "", 0, err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
		return "", 0, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return "", 0, errors.New("file changed to a link")
	}
	identity := fmt.Sprintf("%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow)
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_COMPRESSED|windows.FILE_ATTRIBUTE_SPARSE_FILE) == 0 {
		// GetCompressedFileSize returns EOF for ordinary files. StandardInfo
		// reports allocated clusters (resident NTFS data may allocate zero).
		var standard struct {
			AllocationSize int64
			EndOfFile      int64
			NumberOfLinks  uint32
			DeletePending  uint8
			Directory      uint8
			Padding        [2]byte
		}
		ok, _, callErr := standardInfoProc.Call(uintptr(handle), 1, uintptr(unsafe.Pointer(&standard)), unsafe.Sizeof(standard))
		if ok == 0 {
			return "", 0, callErr
		}
		return identity, standard.AllocationSize, nil
	}
	var high uint32
	low, _, callErr := allocatedProc.Call(uintptr(unsafe.Pointer(pointer)), uintptr(unsafe.Pointer(&high)))
	runtime.KeepAlive(pointer)
	if uint32(low) == 0xffffffff && callErr != syscall.Errno(0) {
		return "", 0, callErr
	}
	return identity, int64(uint64(high)<<32 | uint64(uint32(low))), nil
}
