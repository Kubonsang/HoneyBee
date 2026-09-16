//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
)

type maintenanceMount struct {
	Lease    workspace.LeaseJournal `json:"lease"`
	Attached bool                   `json:"attached"`
}

type maintenanceTopology struct {
	SchemaVersion        int                `json:"schemaVersion"`
	TransactionSHA256    string             `json:"transactionSha256"`
	SourceEvidenceSHA256 string             `json:"sourceEvidenceSha256"`
	Mounts               []maintenanceMount `json:"mounts"`
}

// All leases are read explicitly: Store.ListLeases deliberately skips corrupt
// records and cannot prove that the complete mount set was captured.
func readMaintenanceLeases(root, sid string, check func() error) ([]workspace.LeaseJournal, error) {
	paths, err := workspace.NewPaths(root, sid)
	if err != nil {
		return nil, err
	}
	for _, directory := range []string{paths.Pending, paths.Quarantine} {
		if err = inspectLocalPath(directory); err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(directory)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if len(entries) != 0 {
			return nil, errors.New("pending or quarantined storage needs resolution before migration")
		}
	}
	if err = inspectLocalPath(paths.Leases); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(paths.Leases)
	if os.IsNotExist(err) {
		return []workspace.LeaseJournal{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(entries) > 10000 {
		return nil, errors.New("lease inventory exceeds bound")
	}
	result := make([]workspace.LeaseJournal, 0, len(entries))
	for _, entry := range entries {
		if err = check(); err != nil {
			return nil, err
		}
		if !entry.Type().IsRegular() || filepath.Ext(entry.Name()) != ".json" {
			return nil, errors.New("unknown lease artifact")
		}
		data, err := evidenceBytes(filepath.Join(paths.Leases, entry.Name()), 64<<10)
		if err != nil {
			return nil, err
		}
		var lease workspace.LeaseJournal
		d := json.NewDecoder(bytes.NewReader(data))
		d.DisallowUnknownFields()
		if err = d.Decode(&lease); err != nil {
			return nil, err
		}
		if d.Decode(new(any)) != io.EOF || lease.LeaseID+".json" != entry.Name() {
			return nil, errors.New("ambiguous lease identity")
		}
		result = append(result, lease)
	}
	return result, check()
}

func validateMaintenanceLease(lease workspace.LeaseJournal, receipt installReceipt) error {
	paths, err := workspace.NewPaths(receipt.StoreRoot, receipt.UserSID)
	if err != nil {
		return err
	}
	child, err := paths.Child(lease.LeaseID)
	if err != nil {
		return err
	}
	parent, err := paths.Parent(lease.ParentKey)
	if err != nil {
		return err
	}
	if validateColdBackupName(lease.WorkspaceID) != nil || strings.Contains(lease.WorkspaceID, "/") || lease.WorkspaceID == "" {
		return errors.New("ordinary workspace identity required")
	}
	if _, err = paths.RetainedRecord(lease.RunID); err != nil {
		return err
	}
	if lease.SchemaVersion != workspace.LeaseJournalSchemaVersion || !lease.Retained || (lease.State != "ready" && lease.State != "released") || lease.UserSID != receipt.UserSID || lease.OwnershipToken == "" || lease.FileIdentity.FileID == "" {
		return errors.New("only fully recorded retained workspaces can enter migration")
	}
	container := filepath.Join(receipt.WorkspaceRoot, lease.WorkspaceID)
	for _, pair := range [][2]string{{lease.ChildPath, child}, {lease.ParentPath, filepath.Join(parent, "parent.vhdx")}, {lease.WorkspacePath, container}, {lease.MountPath, filepath.Join(container, "Library")}} {
		if !filepath.IsAbs(pair[0]) || !strings.EqualFold(filepath.Clean(pair[0]), pair[1]) {
			return errors.New("lease escaped admitted store or workspace binding")
		}
	}
	return nil
}

func maintenanceMountPaths(volume string) ([]string, error) {
	if !maintenanceVolumePattern.MatchString(volume) {
		return nil, errors.New("canonical volume GUID required")
	}
	name, err := windows.UTF16PtrFromString(volume)
	if err != nil {
		return nil, err
	}
	buffer := make([]uint16, 32768)
	var length uint32
	if err = windows.GetVolumePathNamesForVolumeName(name, &buffer[0], uint32(len(buffer)), &length); err != nil {
		return nil, err
	}
	if length < 2 || length > uint32(len(buffer)) || buffer[length-1] != 0 || buffer[length-2] != 0 {
		return nil, errors.New("invalid mount path response")
	}
	var paths []string
	start := 0
	for index := 0; index < int(length)-1; index++ {
		if buffer[index] == 0 {
			if index == start {
				break
			}
			paths = append(paths, windows.UTF16ToString(buffer[start:index]))
			start = index + 1
		}
	}
	return paths, nil
}

// Only a positively identified optical volume may lack disk extents. In
// particular, ERROR_INVALID_FUNCTION from a disk is never sufficient to skip it.
func maintenanceOpticalVolume(name string, extentErr error, query func([]byte) (uint32, error), driveType func() uint32) (bool, error) {
	if !errors.Is(extentErr, windows.ERROR_INVALID_FUNCTION) {
		return false, fmt.Errorf("query disk extents for %s: %w", name, extentErr)
	}
	device := make([]byte, 12) // STORAGE_DEVICE_NUMBER
	returned, err := query(device)
	if err != nil {
		return false, fmt.Errorf("classify volume %s after disk extent failure (%v): %w", name, extentErr, err)
	}
	if returned != uint32(len(device)) || binary.LittleEndian.Uint32(device[:4]) != 2 || driveType() != windows.DRIVE_CDROM {
		return false, fmt.Errorf("query disk extents for unconfirmed optical volume %s: %w", name, extentErr)
	}
	return true, nil
}

// Enumerate all local volumes so a second partition of an admitted VHDX cannot
// disappear merely because no lease mentions it. Query uncertainty is refusal.
func admitMaintenanceDiskVolumes(expected map[uint32]string, check func() error) error {
	if len(expected) == 0 {
		return check()
	}
	buffer := make([]uint16, 1024)
	find, err := windows.FindFirstVolume(&buffer[0], uint32(len(buffer)))
	if err != nil {
		return err
	}
	defer windows.FindVolumeClose(find)
	seen := map[uint32]bool{}
	for count := 0; ; count++ {
		if count >= 10000 {
			return errors.New("volume enumeration exceeds bound")
		}
		if err := check(); err != nil {
			return err
		}
		name := windows.UTF16ToString(buffer)
		if !maintenanceVolumePattern.MatchString(name) {
			return errors.New("unexpected enumerated volume")
		}
		pointer, err := windows.UTF16PtrFromString(strings.TrimSuffix(name, `\`))
		if err != nil {
			return err
		}
		handle, err := windows.CreateFile(pointer, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
		if err != nil {
			return fmt.Errorf("open enumerated volume %s: %w", name, err)
		}
		extents := make([]byte, 8+24*128)
		var returned uint32
		err = windows.DeviceIoControl(handle, maintenanceDiskExtents, nil, 0, &extents[0], uint32(len(extents)), &returned, nil)
		optical := false
		if err != nil {
			optical, err = maintenanceOpticalVolume(name, err, func(device []byte) (uint32, error) {
				var size uint32
				queryErr := windows.DeviceIoControl(handle, 0x002d1080 /* IOCTL_STORAGE_GET_DEVICE_NUMBER */, nil, 0, &device[0], uint32(len(device)), &size, nil)
				return size, queryErr
			}, func() uint32 {
				root, _ := windows.UTF16PtrFromString(name) // validated volume GUID above
				return windows.GetDriveType(root)
			})
		}
		_ = windows.CloseHandle(handle)
		if err != nil {
			return err
		}
		if optical {
			for _, wanted := range expected {
				if strings.EqualFold(wanted, name) {
					return fmt.Errorf("admitted VHDX changed to optical volume: %s", name)
				}
			}
		} else {
			if returned < 8 || returned > uint32(len(extents)) {
				return errors.New("truncated enumerated disk extents")
			}
			n := binary.LittleEndian.Uint32(extents[:4])
			if n == 0 || n > 128 || returned != 8+24*n {
				return errors.New("incomplete enumerated disk extents")
			}
			for i := uint32(0); i < n; i++ {
				disk := binary.LittleEndian.Uint32(extents[8+i*24 : 12+i*24])
				if wanted, ok := expected[disk]; ok {
					if n != 1 || seen[disk] || !strings.EqualFold(wanted, name) {
						return errors.New("additional or changed volume on admitted VHDX")
					}
					seen[disk] = true
				}
			}
		}
		clear(buffer)
		err = windows.FindNextVolume(find, &buffer[0], uint32(len(buffer)))
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			break
		}
		if err != nil {
			return err
		}
	}
	if len(seen) != len(expected) {
		return errors.New("admitted VHDX volume disappeared")
	}
	return check()
}

// Builds the native reservation set under sustained broker pause, or under a
// stopped/disabled service with independently proven process exit during recovery.
// Returned handles must remain alive until quiesce. No detach occurs here.
func (area *maintenanceArea) reserveTopology(expected serviceEvidence, transaction string, assertPaused func() error) (*maintenanceVolumeReservation, error) {
	if area == nil || assertPaused == nil || !migrationDigest(transaction) {
		return nil, errors.New("paused protected transaction required")
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertPaused()
	}
	if err := check(); err != nil {
		return nil, err
	}
	root := filepath.Dir(area.Path)
	if !strings.EqualFold(expected.Receipt.StoreRoot, root) {
		return nil, errors.New("topology store mismatch")
	}
	guards := &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}
	var imageGuards []windows.Handle
	transferred := false
	releaseGuards := func() error {
		for _, handle := range imageGuards {
			_ = windows.CloseHandle(handle)
		}
		imageGuards = nil
		guards.close()
		return nil
	}
	defer func() {
		if !transferred {
			_ = releaseGuards()
		}
	}()
	if err := guards.holdDirectory(root); err != nil {
		return nil, err
	}
	leases, err := readMaintenanceLeases(root, expected.Receipt.UserSID, check)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(expected)
	if err != nil {
		return nil, err
	}
	topology := maintenanceTopology{SchemaVersion: 1, TransactionSHA256: transaction, SourceEvidenceSHA256: evidenceHash(data), Mounts: []maintenanceMount{}}
	var volumes []maintenanceVolumeOperation
	reject := func(err error) (*maintenanceVolumeReservation, error) {
		for index := len(volumes) - 1; index >= 0; index-- {
			err = errors.Join(err, volumes[index].close())
		}
		return nil, err
	}
	seen := map[string]bool{}
	leaseImages := map[string]bool{}
	attachedParents := map[string]bool{}
	disks := map[uint32]string{}
	for _, lease := range leases {
		if err = check(); err != nil {
			return reject(err)
		}
		if err = validateMaintenanceOwnership(lease, expected.Receipt); err != nil {
			return reject(err)
		}
		for _, value := range []string{lease.ChildPath, lease.MountPath, lease.RunID} {
			key := strings.ToLower(value)
			if seen[key] {
				return reject(errors.New("duplicate workspace topology"))
			}
			seen[key] = true
		}
		if err = inspectLocalPath(lease.ChildPath); err != nil {
			return reject(err)
		}
		for _, directory := range []string{filepath.Dir(lease.ChildPath), lease.WorkspacePath} {
			if err = guards.holdDirectory(directory); err != nil {
				return reject(err)
			}
		}
		pointer, err := windows.UTF16PtrFromString(lease.ChildPath)
		if err != nil {
			return reject(err)
		}
		handle, err := windows.CreateFile(pointer, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return reject(err)
		}
		imageGuards = append(imageGuards, handle)
		var info windows.ByHandleFileInformation
		if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
			return reject(err)
		}
		if info.NumberOfLinks != 1 || info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
			return reject(errors.New("redirected lease image"))
		}
		identity, err := storage.FileIdentity(lease.ChildPath)
		if err != nil {
			return reject(err)
		}
		if identity != lease.FileIdentity.FileID {
			return reject(errors.New("lease image file identity changed"))
		}
		leaseImages[strings.ToLower(lease.ChildPath)] = true
		attached, err := maintenanceImageLoaded(lease.ChildPath)
		if err != nil {
			return reject(err)
		}
		topology.Mounts = append(topology.Mounts, maintenanceMount{lease, attached})
		if !attached {
			continue
		}
		paths, err := maintenanceMountPaths(lease.VolumeGUID)
		if err != nil {
			return reject(err)
		}
		if len(paths) != 1 || !strings.EqualFold(filepath.Clean(paths[0]), lease.MountPath) {
			return reject(errors.New("additional or changed volume mount path"))
		}
		volume, err := openMaintenanceVolume(lease.ChildPath, lease.VolumeGUID, check)
		if err != nil {
			return reject(err)
		}
		// Once reserved, pause will become Stopped; machine exclusion remains the
		// authority during quiesce, whose caller separately proves process exit.
		volume.assertHeld = area.assertHeld
		// The no-delete image guard and all directory guards above remain held
		// through the complete quiesce batch. Never reopen an unpinned replacement.
		imagePath, imageID := lease.ChildPath, lease.FileIdentity.FileID
		volume.confirmDetached = func() error {
			return proveMaintenanceImageDetached(imageID, area.assertHeld,
				func() (string, error) { return storage.FileIdentity(imagePath) },
				func() (bool, error) { return maintenanceImageLoaded(imagePath) })
		}
		volumes = append(volumes, volume)
		if _, exists := disks[volume.diskNumber]; exists {
			return reject(errors.New("duplicate VHDX disk identity"))
		}
		disks[volume.diskNumber] = lease.VolumeGUID
		attachedParents[strings.ToLower(lease.ParentPath)] = true
	}
	// A parent build, orphan child or foreign user's mounted image must not be
	// omitted just because there is no valid lease that mentions it.
	err = filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := check(); err != nil {
			return err
		}
		if strings.EqualFold(name, area.Path) {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return guards.holdDirectory(name)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("redirected storage topology")
		}
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(name), ".vhdx") {
			return nil
		}
		if leaseImages[strings.ToLower(name)] {
			return nil
		}
		loaded, err := maintenanceImageLoaded(name)
		if err != nil {
			return err
		}
		if loaded {
			return admitLoadedBackingImage(name, attachedParents[strings.ToLower(name)], maintenanceImageDirectlyAttached)
		}
		return nil
	})
	if err != nil {
		return reject(err)
	}
	if err = admitMaintenanceDiskVolumes(disks, check); err != nil {
		return reject(err)
	}
	after, err := readMaintenanceLeases(root, expected.Receipt.UserSID, check)
	if err != nil {
		return reject(err)
	}
	if !reflect.DeepEqual(leases, after) {
		return reject(errors.New("lease inventory changed during topology capture"))
	}
	sort.Slice(topology.Mounts, func(i, j int) bool { return topology.Mounts[i].Lease.LeaseID < topology.Mounts[j].Lease.LeaseID })
	encoded, err := json.Marshal(topology)
	if err != nil {
		return reject(err)
	}
	reservation, err := reserveMaintenanceVolumes(volumes, func() error {
		return persistRestoreRecord("service-topology-"+transaction+".json", encoded, 16<<20, area.restoreRecordStorage(check, 16<<20), check)
	}, check)
	if err != nil {
		return nil, err
	}
	reservation.assertHeld = area.assertHeld
	reservation.releaseGuards = releaseGuards
	transferred = true
	return reservation, nil
}

// An admitted child's parent may be loaded solely as backing storage. An
// independent parent attachment still needs a volume reservation and is refused.
func admitLoadedBackingImage(name string, admittedParent bool, directlyAttached func(string) (bool, error)) error {
	if !admittedParent {
		return fmt.Errorf("unaccounted mounted image: %s", name)
	}
	attached, err := directlyAttached(name)
	if err != nil {
		return fmt.Errorf("cannot establish parent attachment state: %s: %w", name, err)
	}
	if attached {
		return fmt.Errorf("unaccounted mounted image: %s", name)
	}
	return nil
}
