//go:build windows

package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// Read-only diagnosis of the existing QA VM's Reserving failure. This does not
// pause the broker, reserve/lock a volume, or attach/detach any image.
func TestMaintenanceVolumeExtentDiagnostic(t *testing.T) {
	if os.Getenv("COMPUTERNAME") != "DESKTOP-9LT0JVV" {
		t.Skip("requires the existing QA VM")
	}
	buffer := make([]uint16, 1024)
	find, err := windows.FindFirstVolume(&buffer[0], uint32(len(buffer)))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.FindVolumeClose(find)
	for count := 0; ; count++ {
		if count >= 10000 {
			t.Fatal("volume enumeration exceeds bound")
		}
		name := windows.UTF16ToString(buffer)
		if !maintenanceVolumePattern.MatchString(name) {
			t.Fatalf("unexpected enumerated volume: %q", name)
		}
		row := map[string]any{"volume": name, "readOnly": true}
		root, err := windows.UTF16PtrFromString(name)
		if err != nil {
			t.Fatal(err)
		}
		row["driveType"] = windows.GetDriveType(root)
		pointer, err := windows.UTF16PtrFromString(strings.TrimSuffix(name, `\`))
		if err != nil {
			t.Fatal(err)
		}
		handle, openErr := windows.CreateFile(pointer, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
		if openErr != nil {
			row["openError"] = openErr.Error()
		} else {
			// STORAGE_DEVICE_NUMBER: DeviceType, DeviceNumber, PartitionNumber.
			device := make([]byte, 12)
			var returned uint32
			deviceErr := windows.DeviceIoControl(handle, 0x002d1080, nil, 0, &device[0], uint32(len(device)), &returned, nil)
			if deviceErr != nil {
				row["deviceNumberError"] = deviceErr.Error()
			} else if returned == uint32(len(device)) {
				row["deviceType"] = binary.LittleEndian.Uint32(device[:4])
				row["deviceNumber"] = binary.LittleEndian.Uint32(device[4:8])
			} else {
				row["deviceNumberBytes"] = returned
			}
			extents := make([]byte, 8+24*128)
			returned = 0
			extentErr := windows.DeviceIoControl(handle, maintenanceDiskExtents, nil, 0, &extents[0], uint32(len(extents)), &returned, nil)
			_ = windows.CloseHandle(handle)
			if extentErr != nil {
				row["extentError"] = extentErr.Error()
				var errno windows.Errno
				if errors.As(extentErr, &errno) {
					row["extentErrorCode"] = uint32(errno)
				}
			} else {
				row["extentBytes"] = returned
				if returned >= 8 && returned <= uint32(len(extents)) {
					n := binary.LittleEndian.Uint32(extents[:4])
					row["extentCount"] = n
					if n > 0 && n <= 128 && returned == 8+24*n {
						disks := make([]uint32, n)
						for i := range disks {
							disks[i] = binary.LittleEndian.Uint32(extents[8+i*24 : 12+i*24])
						}
						row["disks"] = disks
					}
				}
			}
		}
		encoded, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		t.Log(string(encoded))
		clear(buffer)
		err = windows.FindNextVolume(find, &buffer[0], uint32(len(buffer)))
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Log("Diagnostic completed; PASS means enumeration completed, not update qualification")
}
