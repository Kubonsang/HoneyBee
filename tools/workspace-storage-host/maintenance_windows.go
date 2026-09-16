//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
)

const maintenanceSDDL = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

type maintenanceArea struct {
	Path            string
	parent          *secureDirectoryGuard
	directory, lock windows.Handle
}

func (area *maintenanceArea) close() {
	if area.lock != 0 {
		_ = windows.CloseHandle(area.lock)
		area.lock = 0
	}
	if area.directory != 0 {
		_ = windows.CloseHandle(area.directory)
		area.directory = 0
	}
	if area.parent != nil {
		area.parent.close()
		area.parent = nil
	}
}
func (area *maintenanceArea) assertHeld() error {
	if area.lock == 0 || area.directory == 0 || area.parent == nil {
		return errors.New("maintenance ownership lost")
	}
	var info windows.ByHandleFileInformation
	return windows.GetFileInformationByHandle(area.lock, &info)
}
func validateMaintenanceSecurity(sd *windows.SECURITY_DESCRIPTOR) error {
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	if owner == nil || !(owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) || owner.IsWellKnown(windows.WinLocalSystemSid)) {
		return errors.New("untrusted maintenance owner")
	}
	control, _, err := sd.Control()
	if err != nil {
		return err
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("maintenance permissions must be protected")
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if acl == nil || acl.AceCount != 2 {
		return errors.New("unexpected maintenance permissions")
	}
	principals := map[string]bool{}
	for index := uint32(0); index < 2; index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err = windows.GetAce(acl, index, &ace); err != nil {
			return err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags != 3 || ace.Mask != 0x1f01ff {
			return errors.New("unexpected maintenance access rule")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !(sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) || sid.IsWellKnown(windows.WinLocalSystemSid)) || principals[sid.String()] {
			return errors.New("unexpected maintenance principal")
		}
		principals[sid.String()] = true
	}
	return nil
}
func openPrivateMaintenanceChild(parent windows.Handle, name string, directory bool) (windows.Handle, error) {
	return privateMaintenanceChild(parent, name, directory, windows.FILE_OPEN_IF)
}

func privateMaintenanceChild(parent windows.Handle, name string, directory bool, disposition uint32) (windows.Handle, error) {
	return privateMaintenanceChildAccess(parent, name, directory, disposition, 0)
}

func privateMaintenanceChildAccess(parent windows.Handle, name string, directory bool, disposition, extraAccess uint32) (windows.Handle, error) {
	if extraAccess & ^uint32(windows.DELETE) != 0 {
		return 0, errors.New("unsupported maintenance access")
	}
	if disposition != windows.FILE_OPEN_IF && disposition != windows.FILE_CREATE && disposition != windows.FILE_OPEN {
		return 0, errors.New("unsupported maintenance creation mode")
	}
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\:`) || strings.TrimRight(name, " .") != name {
		return 0, errors.New("maintenance name must be one ordinary path component")
	}
	component, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, err
	}
	descriptor, err := windows.SecurityDescriptorFromString(maintenanceSDDL)
	if err != nil {
		return 0, err
	}
	attrs := &windows.OBJECT_ATTRIBUTES{RootDirectory: parent, ObjectName: component, Attributes: windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE, SecurityDescriptor: descriptor}
	attrs.Length = uint32(unsafe.Sizeof(*attrs))
	options := uint32(windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT)
	access := uint32(windows.GENERIC_READ | windows.GENERIC_WRITE | windows.READ_CONTROL | windows.SYNCHRONIZE)
	access |= extraAccess
	share := uint32(0)
	attributes := uint32(windows.FILE_ATTRIBUTE_NORMAL)
	if directory {
		options |= windows.FILE_DIRECTORY_FILE
		attributes = windows.FILE_ATTRIBUTE_DIRECTORY
		share = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE
	} else {
		options |= windows.FILE_NON_DIRECTORY_FILE
	}
	var handle windows.Handle
	var result windows.IO_STATUS_BLOCK
	if err = windows.NtCreateFile(&handle, access, attrs, &result, nil, attributes, share, disposition, options, 0, 0); err != nil {
		return 0, err
	}
	reject := func(err error) (windows.Handle, error) { _ = windows.CloseHandle(handle); return 0, err }
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
		return reject(err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || !directory && info.NumberOfLinks != 1 {
		return reject(errors.New("redirected maintenance object"))
	}
	actual, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return reject(err)
	}
	if err = validateMaintenanceSecurity(actual); err != nil {
		return reject(err)
	}
	return handle, nil
}

// No caller-controlled root or environment-variable path reaches privileged writes.
// This factory is not exposed by CLI until release/service admission is integrated.
func openMaintenanceArea() (*maintenanceArea, error) {
	if !workspace.IsElevated() {
		return nil, errors.New("service maintenance requires elevation")
	}
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return nil, err
	}
	store := filepath.Join(programData, "UnityWorkspaceStorage")
	if info, err := os.Stat(store); err != nil || !info.IsDir() {
		return nil, errors.New("existing service store required")
	}
	parent, err := secureDirectoryTree(store)
	if err != nil {
		return nil, err
	}
	area := &maintenanceArea{Path: filepath.Join(store, "maintenance"), parent: parent}
	area.directory, err = openPrivateMaintenanceChild(parent.final, "maintenance", true)
	if err != nil {
		area.close()
		return nil, err
	}
	area.lock, err = openPrivateMaintenanceChild(area.directory, "operation.lock", false)
	if err != nil {
		area.close()
		return nil, err
	}
	return area, nil
}
