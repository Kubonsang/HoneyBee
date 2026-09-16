//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
)

func decodeMaintenanceRecord(data []byte, value any) error {
	if len(data) == 0 || len(data) > 16<<20 {
		return errors.New("maintenance record exceeds bound")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("trailing maintenance record")
	}
	return nil
}

// Read both independent ownership records before reserving or reattaching a
// child. A valid lease alone is insufficient authority to use a workspace path.
func validateMaintenanceOwnership(lease workspace.LeaseJournal, receipt installReceipt) error {
	if err := validateMaintenanceLease(lease, receipt); err != nil {
		return err
	}
	paths, err := workspace.NewPaths(receipt.StoreRoot, receipt.UserSID)
	if err != nil {
		return err
	}
	name, err := paths.RetainedRecord(lease.RunID)
	if err != nil {
		return err
	}
	data, err := evidenceBytes(name, 64<<10)
	if err != nil {
		return err
	}
	var retained workspace.RetainedRecord
	if err = decodeMaintenanceRecord(data, &retained); err != nil {
		return err
	}
	if retained.SchemaVersion != workspace.RetainedRecordSchemaVersion || retained.RunID != lease.RunID || retained.LeaseID != lease.LeaseID || retained.OwnershipToken != lease.OwnershipToken || retained.ParentKey != lease.ParentKey || retained.ChildPath != lease.ChildPath {
		return errors.New("retained ownership differs from lease")
	}
	data, err = evidenceBytes(filepath.Join(lease.WorkspacePath, ".testplay-vhdx-workspace-owner.json"), 64<<10)
	if err != nil {
		return err
	}
	var owner workspace.WorkspaceOwner
	if err = decodeMaintenanceRecord(data, &owner); err != nil {
		return err
	}
	if owner.SchemaVersion != workspace.WorkspaceOwnerSchemaVersion || owner.Provider != workspace.Provider || owner.LeaseID != lease.LeaseID || owner.RunID != lease.RunID || owner.WorkspaceID != lease.WorkspaceID || owner.WorkspacePath != lease.WorkspacePath || owner.MountPath != lease.MountPath || owner.OwnershipToken != lease.OwnershipToken {
		return errors.New("workspace owner differs from lease")
	}
	return nil
}

func loadMaintenanceTopology(transaction, sourcePin string, receipt installReceipt, storage restoreIntentStorage, check func() error) (maintenanceTopology, error) {
	var result maintenanceTopology
	if !migrationDigest(transaction) || !migrationDigest(sourcePin) || storage.read == nil || check == nil {
		return result, errors.New("protected topology authority required")
	}
	if err := check(); err != nil {
		return result, err
	}
	data, err := storage.read("service-topology-" + transaction + ".json")
	if err != nil {
		return result, err
	}
	if err = decodeMaintenanceRecord(data, &result); err != nil {
		return result, err
	}
	if result.SchemaVersion != 1 || result.TransactionSHA256 != transaction || result.SourceEvidenceSHA256 != sourcePin || result.Mounts == nil || len(result.Mounts) > 10000 {
		return result, errors.New("protected topology identity mismatch")
	}
	seen := map[string]bool{}
	for _, mount := range result.Mounts {
		if err = validateMaintenanceLease(mount.Lease, receipt); err != nil {
			return result, err
		}
		if seen[mount.Lease.LeaseID] {
			return result, errors.New("duplicate topology lease")
		}
		seen[mount.Lease.LeaseID] = true
	}
	return result, check()
}
