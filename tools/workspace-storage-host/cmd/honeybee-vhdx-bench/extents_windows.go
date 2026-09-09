//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unsafe"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"golang.org/x/sys/windows"
)

func saveCapacityVolume(ctx context.Context, a *storage.Attachment, output string) error {
	number, err := storage.DiskNumberFromPhysicalPath(a.PhysicalPath())
	if err != nil {
		return err
	}
	script := `$ErrorActionPreference='Stop'; $p=@(Get-Partition -DiskNumber ([int]$env:HB_EXTENT_DISK) | Where-Object { $_.AccessPaths -contains $env:HB_EXTENT_VOLUME }); if($p.Count -ne 1){throw 'Expected exact sample partition'}; $v=Get-Volume -Partition $p[0]; @{partitionOffsetBytes=$p[0].Offset;clusterBytes=$v.AllocationUnitSize;fileSystem=$v.FileSystemType.ToString()}|ConvertTo-Json -Compress`
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = append(os.Environ(), fmt.Sprintf("HB_EXTENT_DISK=%d", number), "HB_EXTENT_VOLUME="+a.VolumeGUIDPath())
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sample volume geometry: %w: %s", err, out)
	}
	var result struct {
		Offset     uint64 `json:"partitionOffsetBytes"`
		Cluster    uint64 `json:"clusterBytes"`
		FileSystem string `json:"fileSystem"`
	}
	if err = json.Unmarshal(out, &result); err != nil {
		return err
	}
	if result.Cluster == 0 || result.Offset == 0 || result.FileSystem != "NTFS" {
		return errors.New("invalid sample volume geometry")
	}
	return save(output, result)
}

type diskExtent struct {
	VCN      int64 `json:"vcn"`
	LCN      int64 `json:"lcn"`
	Clusters int64 `json:"clusters"`
}
type extentRecord struct {
	Path    string       `json:"path"`
	Bytes   int64        `json:"bytes"`
	Extents []diskExtent `json:"extents"`
	Error   string       `json:"error,omitempty"`
}

func fileExtents(path string) ([]diskExtent, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(h)
	var result []diskExtent
	var start int64
	for {
		buffer := make([]byte, 64*1024)
		var returned uint32
		err = windows.DeviceIoControl(h, 0x90073, (*byte)(unsafe.Pointer(&start)), 8, &buffer[0], uint32(len(buffer)), &returned, nil)
		if errors.Is(err, windows.ERROR_HANDLE_EOF) {
			return result, nil
		}
		if err != nil && !errors.Is(err, windows.ERROR_MORE_DATA) {
			return nil, err
		}
		if returned < 16 {
			return nil, errors.New("short retrieval pointers")
		}
		count := binary.LittleEndian.Uint32(buffer[:4])
		vcn := int64(binary.LittleEndian.Uint64(buffer[8:16]))
		if count == 0 || 16+uint64(count)*16 > uint64(returned) {
			return nil, errors.New("invalid retrieval pointer count")
		}
		for i := uint32(0); i < count; i++ {
			at := 16 + i*16
			next := int64(binary.LittleEndian.Uint64(buffer[at : at+8]))
			lcn := int64(binary.LittleEndian.Uint64(buffer[at+8 : at+16]))
			if next <= vcn {
				return nil, errors.New("non-increasing VCN")
			}
			result = append(result, diskExtent{VCN: vcn, LCN: lcn, Clusters: next - vcn})
			vcn = next
		}
		if err == nil {
			return result, nil
		}
		if vcn <= start {
			return nil, errors.New("retrieval did not advance")
		}
		start = vcn
	}
}

func saveCapacityExtents(root, output, external string) error {
	var candidates []extentRecord
	err := fs.WalkDir(os.DirFS(root), ".", func(rel string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		p := filepath.Join(root, filepath.FromSlash(rel))
		if p == root {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Name() == "System Volume Information" || info.Name() == "$RECYCLE.BIN" {
			return filepath.SkipDir
		}
		if p == filepath.Join(root, "Bee") && external != "" {
			return nil // Walk does not follow junctions; continue with sibling files.
		}
		if err = regularNode(p, info); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "Bee/") || strings.HasPrefix(rel, "ScriptAssemblies/") || !strings.Contains(rel, "/") {
			candidates = append(candidates, extentRecord{Path: rel, Bytes: info.Size()})
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(candidates) == 0 {
		return errors.New("no Library extent candidates; mounted root traversal failed")
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Bytes == candidates[j].Bytes {
			return candidates[i].Path < candidates[j].Path
		}
		return candidates[i].Bytes > candidates[j].Bytes
	})
	if len(candidates) > 80 {
		candidates = candidates[:80]
	}
	for i := range candidates {
		var e error
		candidates[i].Extents, e = fileExtents(filepath.Join(root, filepath.FromSlash(candidates[i].Path)))
		if e != nil {
			candidates[i].Error = e.Error()
		}
	}
	// LCNs are relative to the NTFS volume, not physical offsets in the backing VHDX.
	return save(output, map[string]any{"coordinateSystem": "NTFS logical cluster numbers; not VHDX backing offsets", "externalBeeExcluded": external != "", "files": candidates})
}
