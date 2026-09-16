//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

func validateStoreAttributes(attributes uint32, directory bool) error {
	const supported = windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM | windows.FILE_ATTRIBUTE_DIRECTORY | windows.FILE_ATTRIBUTE_ARCHIVE | windows.FILE_ATTRIBUTE_NORMAL | windows.FILE_ATTRIBUTE_TEMPORARY | windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED | windows.FILE_ATTRIBUTE_SPARSE_FILE | windows.FILE_ATTRIBUTE_COMPRESSED
	if unsupported := attributes & ^uint32(supported); unsupported != 0 {
		return fmt.Errorf("store entry has unsupported NTFS attributes: attributes=0x%08X unsupported=0x%08X expectedDirectory=%t", attributes, unsupported, directory)
	}
	if actualDirectory := attributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0; actualDirectory != directory {
		return fmt.Errorf("store entry type mismatch: attributes=0x%08X expectedDirectory=%t actualDirectory=%t", attributes, directory, actualDirectory)
	}
	if attributes&windows.FILE_ATTRIBUTE_COMPRESSED != 0 && attributes&windows.FILE_ATTRIBUTE_SPARSE_FILE != 0 {
		return errors.New("compressed sparse store entry is unsupported")
	}
	return nil
}

func validateStoreStreamInfo(data []byte, directory bool) error {
	if len(data) < 24 {
		return errors.New("truncated store stream information")
	}
	if binary.LittleEndian.Uint32(data) != 0 {
		return errors.New("store alternate streams are not supported by this backup format")
	}
	length := binary.LittleEndian.Uint32(data[4:8])
	if length == 0 && directory {
		return nil
	}
	if length == 0 || length%2 != 0 || uint64(length) > uint64(len(data)-24) {
		return errors.New("invalid store stream name")
	}
	name := make([]uint16, length/2)
	for i := range name {
		name[i] = binary.LittleEndian.Uint16(data[24+i*2:])
	}
	if string(utf16.Decode(name)) != "::$DATA" {
		return errors.New("store alternate stream would be omitted by backup")
	}
	return nil
}

func inspectStoreFilePolicy(handle windows.Handle, attributes uint32, directory bool) error {
	if err := validateStoreAttributes(attributes, directory); err != nil {
		return err
	}
	if attributes&windows.FILE_ATTRIBUTE_COMPRESSED != 0 {
		format, err := storeCompressionFormat(handle)
		if err != nil {
			return err
		}
		if format != 2 {
			return fmt.Errorf("unsupported store compression format: %d", format)
		}
	}
	// Bound enumeration. Insufficient buffer and unsupported query errors fail
	// closed; neither means an absent alternate stream.
	buffer := make([]byte, 64<<10)
	err := windows.GetFileInformationByHandleEx(handle, windows.FileStreamInfo, &buffer[0], uint32(len(buffer)))
	if err != nil {
		if directory && errors.Is(err, windows.ERROR_HANDLE_EOF) {
			return nil
		}
		return err
	}
	return validateStoreStreamInfo(buffer, directory)
}
