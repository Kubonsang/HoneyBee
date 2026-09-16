//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
)

// These are SCM StartService arguments, not executable command-line options.
// The privileged coordinator must supply them again during boot recovery; SCM
// does not persist StartService arguments. No user directory is accepted here.
func brokerResumeArguments(args []string) (transaction, sourcePin string, err error) {
	if len(args) == 1 && args[0] == workspace.WindowsServiceName {
		return "", "", nil
	}
	if len(args) != 4 || args[0] != workspace.WindowsServiceName || args[1] != "maintenance-resume" || !migrationDigest(args[2]) || !migrationDigest(args[3]) {
		return "", "", errors.New("invalid protected broker resume arguments")
	}
	return args[2], args[3], nil
}

// Startup reads immutable records without taking the coordinator's operation
// lock. Directory handles pin the fixed protected tree while it is being read.
// This function never creates a directory, journal, or lock.
func readBrokerResume(config workspace.ServiceConfig, transaction, sourcePin string) (maintenanceTopology, installReceipt, error) {
	var topology maintenanceTopology
	var receipt installReceipt
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return topology, receipt, err
	}
	root := filepath.Join(programData, "UnityWorkspaceStorage")
	if !strings.EqualFold(config.StoreRoot, root) {
		return topology, receipt, errors.New("broker resume requires fixed installed store")
	}
	parent := &verifiedColdBackup{directories: map[string]windows.Handle{}}
	defer parent.close()
	if err = parent.holdDirectory(root); err != nil {
		return topology, receipt, err
	}
	directory, err := privateMaintenanceChild(parent.directories[strings.ToLower(root)], "maintenance", true, windows.FILE_OPEN)
	if err != nil {
		return topology, receipt, err
	}
	defer windows.CloseHandle(directory)
	check := func() error {
		var info windows.ByHandleFileInformation
		return windows.GetFileInformationByHandle(directory, &info)
	}
	records := privateRecordStorage(directory, check, 16<<20)
	source, err := loadServiceSourceRecord(root, transaction, sourcePin, records, check)
	if err != nil {
		return topology, receipt, err
	}
	receipt = source.Evidence.Receipt
	if config.UserSID != receipt.UserSID || config.WorkspaceRoot != receipt.WorkspaceRoot || config.PipeName != receipt.PipeName {
		return topology, receipt, errors.New("broker configuration differs from protected workspace binding")
	}
	topology, err = loadMaintenanceTopology(transaction, sourcePin, receipt, records, check)
	return topology, receipt, err
}

// Dynamic attachment evidence (boot session, physical disk, volume, PID and
// timestamps) changes on replay. The workspace, ownership and file identities
// cannot change. A restored VHDX with a different file ID is refused, not rebound.
func sameMaintenanceLease(a, b workspace.LeaseJournal) bool {
	return a.SchemaVersion == b.SchemaVersion && a.LeaseID == b.LeaseID && a.RunID == b.RunID && a.UserSID == b.UserSID && a.OwnershipToken == b.OwnershipToken && a.ParentKey == b.ParentKey && a.ParentPath == b.ParentPath && a.ChildPath == b.ChildPath && a.WorkspaceID == b.WorkspaceID && a.WorkspacePath == b.WorkspacePath && a.MountPath == b.MountPath && a.Retained == b.Retained && a.FileIdentity == b.FileIdentity
}

type brokerResumeOperations struct {
	verifyImage func(string) (string, error)
	imageLoaded func(string) (bool, error)
	attach      func(context.Context, string, workspace.Request) workspace.Response
}

func restoreBrokerMounts(ctx context.Context, topology maintenanceTopology, receipt installReceipt, operations brokerResumeOperations) error {
	if operations.verifyImage == nil || operations.imageLoaded == nil || operations.attach == nil {
		return errors.New("broker-owned restore operations required")
	}
	leases, err := readMaintenanceLeases(receipt.StoreRoot, receipt.UserSID, ctx.Err)
	if err != nil {
		return err
	}
	if len(leases) != len(topology.Mounts) {
		return errors.New("workspace inventory changed since maintenance")
	}
	current := map[string]workspace.LeaseJournal{}
	for _, lease := range leases {
		current[lease.LeaseID] = lease
	}
	// Validate the complete set before the first attach, including workspaces
	// that were originally detached and must remain detached.
	for _, mount := range topology.Mounts {
		if err = ctx.Err(); err != nil {
			return err
		}
		lease, ok := current[mount.Lease.LeaseID]
		if !ok || !sameMaintenanceLease(lease, mount.Lease) {
			return errors.New("workspace identity changed since maintenance")
		}
		delete(current, lease.LeaseID)
		if err = validateMaintenanceOwnership(lease, receipt); err != nil {
			return err
		}
		identity, err := operations.verifyImage(lease.ChildPath)
		if err != nil {
			return err
		}
		if identity != lease.FileIdentity.FileID {
			return errors.New("restored workspace file identity differs from recorded identity")
		}
		loaded, err := operations.imageLoaded(lease.ChildPath)
		if err != nil {
			return err
		}
		if !mount.Attached && loaded {
			return errors.New("previously detached workspace was attached outside maintenance")
		}
	}
	for _, mount := range topology.Mounts {
		if !mount.Attached {
			continue
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		lease := mount.Lease
		request := workspace.NewRequest(workspace.OperationAttachRetained, "maintenance-"+lease.LeaseID)
		request.RunID, request.WorkspaceID, request.ClientPID = lease.RunID, lease.WorkspaceID, os.Getpid()
		response := operations.attach(ctx, receipt.UserSID, request)
		if !response.OK || response.Lease == nil || response.Lease.LeaseID != lease.LeaseID || response.Lease.MountPath != lease.MountPath {
			return fmt.Errorf("broker could not restore workspace %s", lease.WorkspaceID)
		}
	}
	return ctx.Err()
}

var errRestoredAttachmentMissing = errors.New("restored attachment missing")

// Running alone is not proof that the protected mount set was restored. This
// also detects a restart that accidentally omitted the SCM resume arguments.
func verifyBrokerMounts(topology maintenanceTopology, receipt installReceipt, check func() error, loaded func(string) (bool, error), identity func(string) (string, error), mountPaths func(workspace.LeaseJournal) ([]string, error)) error {
	if check == nil || loaded == nil || identity == nil || mountPaths == nil {
		return errors.New("complete mount health operations required")
	}
	leases, err := readMaintenanceLeases(receipt.StoreRoot, receipt.UserSID, check)
	if err != nil {
		return err
	}
	if len(leases) != len(topology.Mounts) {
		return errors.New("restored lease inventory differs")
	}
	current := map[string]workspace.LeaseJournal{}
	for _, lease := range leases {
		current[lease.LeaseID] = lease
	}
	missing := false
	for _, mount := range topology.Mounts {
		if err = check(); err != nil {
			return err
		}
		lease, ok := current[mount.Lease.LeaseID]
		if !ok || !sameMaintenanceLease(lease, mount.Lease) {
			return errors.New("restored lease identity differs")
		}
		delete(current, lease.LeaseID)
		if err = validateMaintenanceOwnership(lease, receipt); err != nil {
			return err
		}
		fileID, err := identity(lease.ChildPath)
		if err != nil {
			return err
		}
		if fileID != lease.FileIdentity.FileID {
			return errors.New("restored image identity differs")
		}
		attached, err := loaded(lease.ChildPath)
		if err != nil {
			return err
		}
		if attached != mount.Attached {
			if attached {
				return errors.New("previously detached workspace was attached outside maintenance")
			}
			missing = true
		}
		if attached {
			paths, err := mountPaths(lease)
			if err != nil {
				return err
			}
			if lease.State != "ready" || len(paths) != 1 || !strings.EqualFold(filepath.Clean(paths[0]), lease.MountPath) {
				return errors.New("restored mount path differs")
			}
		}
	}
	if err := check(); err != nil {
		return err
	}
	if missing {
		return errRestoredAttachmentMissing
	}
	return nil
}

func resumeInstalledBroker(ctx context.Context, args []string, config workspace.ServiceConfig, broker *workspace.Broker) error {
	transaction, sourcePin, err := brokerResumeArguments(args)
	if err != nil || transaction == "" {
		return err
	}
	topology, receipt, err := readBrokerResume(config, transaction, sourcePin)
	if err != nil {
		return err
	}
	return restoreBrokerMounts(ctx, topology, receipt, brokerResumeOperations{
		verifyImage: storage.FileIdentity,
		imageLoaded: maintenanceImageLoaded,
		attach:      broker.Handle,
	})
}
