//go:build windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Explicit read-only check against the already retained final QA dataset.
// No service, disk, mount, registry or test fixture is created or changed.
func TestMaintenanceParentAttachmentDiagnostic(t *testing.T) {
	if os.Getenv("COMPUTERNAME") != "DESKTOP-9LT0JVV" {
		t.Skip("requires the existing QA VM; no host disks are touched")
	}
	root := `C:\ProgramData\UnityWorkspaceStorage\S-1-5-21-4199076252-3622841657-4011401391-1001`
	for _, item := range []struct {
		kind, relative string
		attached       bool
	}{
		{"parent", `parents\53c55e20d41f58f8647c9f30fad5d2e67593ed4de8a01f0a1882a7876ae24cbc\parent.vhdx`, false},
		{"child", `children\lease-43d0116a8935f0e309d631b1488da3b2.vhdx`, true},
	} {
		image := filepath.Join(root, item.relative)
		loaded, loadErr := maintenanceImageLoaded(image)
		attached, attachErr := maintenanceImageDirectlyAttached(image)
		result := map[string]any{"kind": item.kind, "path": image, "loaded": loaded, "directlyAttached": attached, "readOnly": true}
		if loadErr != nil {
			result["loadError"] = loadErr.Error()
		}
		if attachErr != nil {
			result["attachmentError"] = attachErr.Error()
		}
		encoded, _ := json.Marshal(result)
		t.Log(string(encoded))
		if loadErr != nil || attachErr != nil || attached != item.attached {
			t.Errorf("unexpected %s attachment observation", item.kind)
		}
	}
}
