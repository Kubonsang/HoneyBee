//go:build windows

package main

import (
	"errors"

	"golang.org/x/sys/windows"
)

type serviceRecoveryOwner struct {
	PID     uint32 `json:"pid"`
	Created uint64 `json:"created"`
}

func captureServiceRecoveryOwner(pid uint32, sid string) (serviceRecoveryOwner, error) {
	if pid == 0 || sid == "" {
		return serviceRecoveryOwner{}, errors.New("authenticated update owner required")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return serviceRecoveryOwner{}, err
	}
	defer windows.CloseHandle(handle)
	state, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return serviceRecoveryOwner{}, err
	}
	if state != uint32(windows.WAIT_TIMEOUT) {
		return serviceRecoveryOwner{}, errors.New("update owner already exited")
	}
	var token windows.Token
	if err = windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token); err != nil {
		return serviceRecoveryOwner{}, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return serviceRecoveryOwner{}, err
	}
	if user.User.Sid.String() != sid {
		return serviceRecoveryOwner{}, errors.New("update owner belongs to another user")
	}
	var created, exit, kernel, userTime windows.Filetime
	if err = windows.GetProcessTimes(handle, &created, &exit, &kernel, &userTime); err != nil {
		return serviceRecoveryOwner{}, err
	}
	return serviceRecoveryOwner{pid, uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)}, nil
}

func serviceRecoveryOwnerAlive(owner serviceRecoveryOwner) (bool, error) {
	if owner.PID == 0 || owner.Created == 0 {
		return false, errors.New("recorded owner identity required")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, owner.PID)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(handle)
	state, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	if state == windows.WAIT_OBJECT_0 {
		return false, nil
	}
	if state != uint32(windows.WAIT_TIMEOUT) {
		return false, errors.New("unexpected owner process state")
	}
	var created, exit, kernel, userTime windows.Filetime
	if err = windows.GetProcessTimes(handle, &created, &exit, &kernel, &userTime); err != nil {
		return false, err
	}
	return uint64(created.HighDateTime)<<32|uint64(created.LowDateTime) == owner.Created, nil
}
