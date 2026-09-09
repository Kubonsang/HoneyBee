//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// Query the leaf reparse buffer directly. EvalSymlinks cannot reliably resolve
// directory volume mount ancestors on Windows and can report a false link loop.
func junctionTarget(path string) (string, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buffer := make([]byte, 16*1024)
	var n uint32
	if err = windows.DeviceIoControl(h, 0x900a8, nil, 0, &buffer[0], uint32(len(buffer)), &n, nil); err != nil {
		return "", err
	}
	if n < 16 || binary.LittleEndian.Uint32(buffer[:4]) != 0xa0000003 {
		return "", errors.New("Bee is not a junction")
	}
	offset := int(binary.LittleEndian.Uint16(buffer[8:10]))
	length := int(binary.LittleEndian.Uint16(buffer[10:12]))
	if length%2 != 0 || 16+offset+length > int(n) {
		return "", errors.New("invalid junction buffer")
	}
	data := buffer[16+offset : 16+offset+length]
	chars := make([]uint16, len(data)/2)
	for i := range chars {
		chars[i] = binary.LittleEndian.Uint16(data[i*2 : i*2+2])
	}
	target := string(utf16.Decode(chars))
	return strings.TrimPrefix(target, `\??\`), nil
}
