//go:build windows

package main

import (
	"context"
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
	"time"
	"unsafe"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"golang.org/x/sys/windows"
)

type footprintKey struct{}
type footprintOptions struct{ Compression string }
type footprintPolicy struct {
	Name        string `json:"name"`
	CapacityGiB uint64 `json:"capacityGiB"`
	Compression string `json:"compression"`
}

func footprintCapacityFits(capacityGiB, seedBytes uint64) bool {
	reserve := uint64(4 << 30)
	if seedBytes > reserve {
		reserve = seedBytes
	}
	capacity := capacityGiB << 30
	return seedBytes <= capacity && reserve <= capacity-seedBytes
}

// Concurrent enumeration is a sampled observation, not an atomic filesystem snapshot.
// Files disappearing between enumeration and query have no remaining live allocation.
func footprintLiveUsage(root string) (usage storage.FileUsage, err error) {
	err = filepath.Walk(root, func(p string, info fs.FileInfo, e error) error {
		if errors.Is(e, os.ErrNotExist) {
			return nil
		}
		if e != nil {
			return e
		}
		if e = regularNode(p, info); e != nil {
			return e
		}
		if info.IsDir() {
			return nil
		}
		u, e := measuredFileUsage(p)
		if errors.Is(e, os.ErrNotExist) {
			return nil
		}
		if e != nil {
			return e
		}
		usage.LogicalBytes += u.LogicalBytes
		usage.AllocatedBytes += u.AllocatedBytes
		return nil
	})
	return
}

func validateFootprintRetained(root string, row capacitySample) error {
	switch row.Mode {
	case "E-fp-base", "E-fp-compressed", "E-fp-artifacts", "E-fp-32", "E-fp-16", "E-fp-8", "E-fp-combined":
	default:
		return errors.New("unknown retained footprint policy")
	}
	name := fmt.Sprintf("%s-%d", row.Mode, row.Iteration)
	if row.Child != filepath.Join(root, name+".vhdx") || row.External != filepath.Join(root, name+"-bee") {
		return errors.New("retained footprint identity mismatch")
	}
	for _, capacity := range []uint64{64, 32, 16, 8} {
		if row.Parent == filepath.Join(root, fmt.Sprintf("parent-fp-%d.vhdx", capacity)) {
			return nil
		}
	}
	return errors.New("retained footprint parent outside campaign")
}

func compressFootprintBee(root, policy string) error {
	if policy == "none" {
		return nil
	}
	if policy != "all" && policy != "artifacts" {
		return errors.New("unknown Bee compression policy")
	}
	target := root
	if policy == "artifacts" {
		target = filepath.Join(root, "artifacts")
	}
	// Validate the complete tree before changing any compression state; never follow links.
	if err := ownedEntry(filepath.Dir(root), root); err != nil {
		return err
	}
	return filepath.Walk(target, func(p string, info fs.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if e = regularNode(p, info); e != nil {
			return e
		}
		name, e := windows.UTF16PtrFromString(p)
		if e != nil {
			return e
		}
		h, e := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
			windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if e != nil {
			return e
		}
		format := uint16(1) // COMPRESSION_FORMAT_DEFAULT, native NTFS (not WOF/EXE).
		var returned uint32
		e = windows.DeviceIoControl(h, 0x9c040, (*byte)(unsafe.Pointer(&format)), 2, nil, 0, &returned, nil)
		return errors.Join(e, windows.CloseHandle(h))
	})
}

func saveFootprintCompression(root, output string) error {
	var files, compressed, dirs, compressedDirs int
	err := filepath.Walk(root, func(p string, info fs.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if e = regularNode(p, info); e != nil {
			return e
		}
		attrs := info.Sys().(*syscall.Win32FileAttributeData).FileAttributes
		if info.IsDir() {
			dirs++
			if attrs&windows.FILE_ATTRIBUTE_COMPRESSED != 0 {
				compressedDirs++
			}
		} else {
			files++
			if attrs&windows.FILE_ATTRIBUTE_COMPRESSED != 0 {
				compressed++
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	usage, err := treeUsage(root)
	if err != nil {
		return err
	}
	return save(output, map[string]any{"files": files, "compressedFiles": compressed, "directories": dirs, "compressedDirectories": compressedDirs, "usage": usage})
}

// Complete final extent inventory. These overlaps are not causal write attribution.
// Metadata access failures are retained rather than silently assigned to regular files.
func saveFootprintExtents(root, output string) error {
	var rows []extentRecord
	err := fs.WalkDir(os.DirFS(root), ".", func(rel string, entry fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if rel == "." {
			return nil
		}
		if rel == "Bee" {
			return nil // Junction is a leaf; SkipDir here would also skip its siblings.
		}
		if entry.Name() == "System Volume Information" || entry.Name() == "$RECYCLE.BIN" {
			return filepath.SkipDir
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		p := filepath.Join(root, filepath.FromSlash(rel))
		if e = regularNode(p, info); e != nil {
			return e
		}
		record := extentRecord{Path: filepath.ToSlash(rel), Bytes: info.Size(), Directory: info.IsDir()}
		record.Extents, e = fileExtents(p)
		if e != nil {
			record.Error = e.Error()
		}
		rows = append(rows, record)
		return nil
	})
	if err != nil {
		return err
	}
	for _, name := range []string{"$MFT", "$MFTMirr", "$LogFile", "$Bitmap", "$Boot", "$Secure", "$UpCase", "$Extend/$UsnJrnl:$J", "$Extend/$UsnJrnl:$Max"} {
		record := extentRecord{Path: name}
		record.Extents, err = fileExtents(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			record.Error = err.Error()
		}
		rows = append(rows, record)
	}
	return save(output, map[string]any{"files": rows, "coordinateSystem": "NTFS LCN", "caveat": "Final extents, including directory and metadata queries; not causal write attribution. Deleted/reallocated/resident data and failed queries remain unresolved."})
}

func saveFootprintMetadata(ctx context.Context, a *storage.Attachment, output string) error {
	cmd := exec.CommandContext(ctx, "python", "scripts/benchmarks/vhdx/inspect_ntfs_metadata.py", "--volume", a.VolumeGUIDPath(), "--output", output)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		// Unavailable metadata is unknown evidence, not a reason to alter the volume.
		return save(output, map[string]any{"files": []any{}, "error": fmt.Sprintf("%v: %.1000s", err, out), "readOnly": true})
	}
	return nil
}

func footprintMetrics(rows []capacitySample) map[string]float64 {
	m := startupMetrics(rows)
	var plays []int64
	var combinedPeak int64
	for _, r := range rows {
		var sample []int64
		for _, p := range r.Phases {
			if strings.HasSuffix(p.Name, "play_mode") {
				sample = append(sample, p.ElapsedMS)
			}
			// Combined observations include approximately 1s live samples and phase ends.
			v := p.CombinedPeak
			if v > combinedPeak {
				combinedPeak = v
			}
		}
		if len(r.Phases) > 0 {
			v := r.Detached.AllocatedBytes + r.Phases[len(r.Phases)-1].External.AllocatedBytes
			if v > combinedPeak {
				combinedPeak = v
			}
		}
		plays = append(plays, int64(median(sample)))
	}
	m["playMs"] = median(plays)
	m["observedCombinedPeakBytes"] = float64(combinedPeak)
	return m
}
func footprintTimingPass(value, base map[string]float64) bool {
	if value["invalid"] != 0 || base["invalid"] != 0 {
		return false
	}
	for _, k := range []string{"firstMs", "reopenMs", "editMs", "playMs", "readyMs"} {
		if value[k] <= 0 || base[k] <= 0 || value[k] > base[k]*1.10 {
			return false
		}
	}
	return true
}
func footprintPass(value, base map[string]float64, saving float64) bool {
	return footprintTimingPass(value, base) && value["combinedMedianBytes"] > 0 &&
		value["observedCombinedPeakBytes"] > 0 && base["observedCombinedPeakBytes"] > 0 &&
		value["combinedMedianBytes"] <= base["combinedMedianBytes"]*(1-saving) &&
		value["observedCombinedPeakBytes"] <= base["observedCombinedPeakBytes"]
}

// Screening uses only the plan's >=5% combined saving and <=10% timing gates.
// Peaks belong to final qualification, not the two-sample pilot admission.
func footprintScreenPass(value, base map[string]float64) bool {
	return footprintTimingPass(value, base) && value["combinedMedianBytes"] > 0 && value["combinedMedianBytes"] <= base["combinedMedianBytes"]*.95
}

func runFootprintDiagnostic(root string) (err error) {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	if err = ownedEntry(filepath.Join(cwd, "tmp"), root); err != nil {
		return err
	}
	var campaign struct{ Protocol, Evidence, Unity, Testplay string }
	raw, err := os.ReadFile(filepath.Join(root, "campaign.json"))
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &campaign); err != nil {
		return err
	}
	if campaign.Protocol != "footprint-v1" || campaign.Evidence != filepath.Join(cwd, "output", filepath.Base(root)+"-evidence") {
		return errors.New("unexpected footprint campaign")
	}
	var status struct {
		OK    bool
		Error string
	}
	raw, err = os.ReadFile(filepath.Join(root, "status.json"))
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &status); err != nil {
		return err
	}
	if !status.OK {
		var confirmation struct {
			OK                    bool
			AllocationMeasurement string
		}
		b, e := os.ReadFile(filepath.Join(root, "confirmation.json"))
		if e != nil {
			return e
		}
		if e = json.Unmarshal(b, &confirmation); e != nil {
			return e
		}
		if !strings.Contains(status.Error, "footprint-accounting-confirmation-required") || !confirmation.OK || confirmation.AllocationMeasurement != "native-allocated-v2" {
			return errors.New("diagnostic requires successfully terminal campaign or corrected confirmation")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	stop := watchStartupFloor(root, cancel)
	defer func() { err = errors.Join(err, stop()) }()
	if err = startupCheckpoint(root, campaign.Evidence); err != nil {
		return err
	}
	parent := filepath.Join(root, "parent-fp-64.vhdx")
	if err = ownedEntry(root, parent); err != nil {
		return err
	}
	// A read-only parent inventory is the pre-write reference; it cannot create atime writes.
	err = withReadOnlyDisk(ctx, parent, filepath.Join(root, "diagnostic-parent-readonly"), func(a *storage.Attachment) error {
		if e := saveFootprintExtents(filepath.Join(root, "diagnostic-parent-readonly"), filepath.Join(root, "diagnostic-parent-extents.json")); e != nil {
			return e
		}
		if e := saveFootprintMetadata(ctx, a, filepath.Join(root, "diagnostic-parent-metadata.json")); e != nil {
			return e
		}
		return saveCapacityVolume(ctx, a, filepath.Join(root, "diagnostic-parent-volume.json"))
	})
	if err != nil {
		return err
	}
	sampleCtx := context.WithValue(context.WithValue(ctx, startupKey{}, startupOptions{Diagnostics: true, Trace: true}), footprintKey{}, footprintOptions{Compression: "none"})
	row, err := capacitySampleRun(sampleCtx, root, filepath.Join(root, "source"), campaign.Unity, campaign.Testplay, parent, "E-fp-base", 90, 1)
	if err != nil {
		return err
	}
	archive, err := archiveStartupSample(root, campaign.Evidence, row)
	if err != nil {
		return err
	}
	if err = removeStartupSample(root, campaign.Evidence, row, archive); err != nil {
		return err
	}
	return save(filepath.Join(root, "diagnostic.json"), map[string]any{"ok": true, "timingExcluded": true, "sample": "E-fp-base-90", "archive": archive, "finishedAt": time.Now().UTC()})
}

func runFootprintStudy(root, source, unity, testplay string) (err error) {
	if err = validateRoot(root); err != nil {
		return err
	}
	for _, p := range []string{source, unity, testplay} {
		if !filepath.IsAbs(p) {
			return errors.New("footprint inputs must be absolute")
		}
	}
	if _, e := os.Lstat(filepath.Join(source, "Library")); !errors.Is(e, os.ErrNotExist) {
		return errors.New("source must be authored export without Library")
	}
	free, e := freeSpace(filepath.Dir(root))
	if e != nil {
		return e
	}
	if free < startupFloor+startupBudget {
		return errors.New("footprint study requires 35 GiB free")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	defer cancel()
	elevated, e := storage.IsElevated(ctx)
	if e != nil {
		return e
	}
	if !elevated {
		return errors.New("isolated disk study requires elevation")
	}
	cwd, e := os.Getwd()
	if e != nil {
		return e
	}
	evidence := filepath.Join(cwd, "output", filepath.Base(root)+"-evidence")
	if err = os.Mkdir(evidence, 0700); err != nil {
		return err
	}
	if err = os.Mkdir(root, 0700); err != nil {
		return err
	}
	stop := watchStartupFloor(root, cancel)
	rows := []capacitySample{}
	policies := []footprintPolicy{{"E-fp-base", 64, "none"}, {"E-fp-compressed", 64, "all"}, {"E-fp-32", 32, "none"}, {"E-fp-16", 16, "none"}, {"E-fp-8", 8, "none"}}
	qualified := false
	selected := ""
	defer func() {
		err = errors.Join(err, stop())
		status := map[string]any{"protocol": "footprint-v1", "ok": err == nil, "qualified": qualified, "selected": selected, "finishedAt": time.Now().UTC()}
		if err != nil {
			status["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, "status.json"), status))
	}()
	if err = save(filepath.Join(root, "campaign.json"), map[string]any{"protocol": "footprint-v1", "allocationMeasurement": "native-allocated-v2", "source": source, "unity": unity, "testplay": testplay, "policies": policies, "evidence": evidence, "freeFloorBytes": startupFloor, "budgetBytes": startupBudget, "pilotRuns": 2, "qualificationRuns": 3, "qualificationCycles": 5, "minimumSavings": 0.20, "maximumTimingRatio": 1.10, "peakCaveat": "child sampled at 250ms; combined allocation sampled at approximately 1s plus phase checkpoints; sampled rather than absolute peak"}); err != nil {
		return err
	}
	frozen := filepath.Join(root, "source")
	for _, folder := range []string{"Assets", "Packages", "ProjectSettings"} {
		before, e := scanParallel(filepath.Join(source, folder))
		if e != nil {
			return e
		}
		if err = copyTree(filepath.Join(source, folder), filepath.Join(frozen, folder)); err != nil {
			return err
		}
		after, e := scanParallel(filepath.Join(frozen, folder))
		if e != nil {
			return e
		}
		if !same(before, after) {
			return errors.New("frozen source copy mismatch")
		}
	}
	if err = prepareCapacityProbe(frozen); err != nil {
		return err
	}
	for _, phase := range []string{"first", "reopen"} {
		fmt.Println("prepare footprint seed", phase)
		if _, err = launchUnity(ctx, unity, frozen, filepath.Join(root, "seed-"+phase+".log"), false); err != nil {
			return err
		}
	}
	seed, e := scanParallel(filepath.Join(frozen, "Library"))
	if e != nil {
		return e
	}
	if err = save(filepath.Join(root, "seed-manifest.json"), seed); err != nil {
		return err
	}
	seedUsage, e := treeUsage(filepath.Join(frozen, "Library"))
	if e != nil {
		return e
	}
	eligible := []footprintPolicy{}
	skipped := []footprintPolicy{}
	for _, p := range policies {
		if footprintCapacityFits(p.CapacityGiB, uint64(seedUsage.LogicalBytes)) {
			eligible = append(eligible, p)
		} else {
			skipped = append(skipped, p)
		}
	}
	if len(eligible) == 0 || eligible[0].Name != "E-fp-base" {
		return errors.New("source exceeds control volume headroom")
	}
	policies = eligible
	if err = save(filepath.Join(root, "capacity-admission.json"), map[string]any{"seedLogicalBytes": seedUsage.LogicalBytes, "eligible": eligible, "skipped": skipped}); err != nil {
		return err
	}
	parents := map[uint64]string{}
	prepare := func(capacity uint64) (string, error) {
		if p := parents[capacity]; p != "" {
			return p, nil
		}
		if e := startupCheckpoint(root, evidence); e != nil {
			return "", e
		}
		usage, e := treeUsage(filepath.Join(frozen, "Library"))
		if e != nil {
			return "", e
		}
		if !footprintCapacityFits(capacity, uint64(usage.LogicalBytes)) {
			return "", fmt.Errorf("capacity %d GiB lacks seed headroom", capacity)
		}
		p := filepath.Join(root, fmt.Sprintf("parent-fp-%d.vhdx", capacity))
		if e = storage.CreateDynamicWithOptions(p, storage.CreateOptions{MaximumSize: int64(capacity << 30), BlockSizeInBytes: 2 << 20, SectorSizeInBytes: 4096}); e != nil {
			return "", e
		}
		mount := filepath.Join(root, fmt.Sprintf("prepare-%d", capacity))
		e = withDisk(ctx, p, mount, true, func(a *storage.Attachment) error {
			return copyCapacityLibrary(filepath.Join(frozen, "Library"), mount, "C-no-bee")
		})
		if e != nil {
			return "", e
		}
		e = withReadOnlyDisk(ctx, p, filepath.Join(root, fmt.Sprintf("verify-%d", capacity)), func(a *storage.Attachment) error {
			actual, e := scanParallel(filepath.Join(root, fmt.Sprintf("verify-%d", capacity)))
			if e != nil {
				return e
			}
			expected := manifest{}
			for k, v := range seed {
				if !strings.HasPrefix(k, "Bee/") {
					expected[k] = v
				}
			}
			if !same(expected, actual) {
				return errors.New("parent content mismatch")
			}
			return nil
		})
		if e != nil {
			return "", e
		}
		parents[capacity] = p
		hash, e := hashFileRecord(p)
		if e != nil {
			return "", e
		}
		if e = save(filepath.Join(root, fmt.Sprintf("parent-%d-identity.json", capacity)), hash); e != nil {
			return "", e
		}
		return p, nil
	}
	runSample := func(policy footprintPolicy, iteration, cycles int, retain bool) (capacitySample, error) {
		parent, e := prepare(policy.CapacityGiB)
		if e != nil {
			return capacitySample{}, e
		}
		if e = startupCheckpoint(root, evidence); e != nil {
			return capacitySample{}, e
		}
		fmt.Println("footprint sample", policy.Name, iteration)
		sampleCtx := context.WithValue(context.WithValue(ctx, startupKey{}, startupOptions{}), footprintKey{}, footprintOptions{policy.Compression})
		r, e := capacitySampleRun(sampleCtx, root, frozen, unity, testplay, parent, policy.Name, iteration, cycles)
		rows = append(rows, r)
		e = errors.Join(e, save(filepath.Join(root, "measurements.json"), rows))
		if e != nil {
			return r, e
		}
		archive, e := archiveStartupSample(root, evidence, r)
		if e != nil {
			return r, e
		}
		if !retain {
			e = removeStartupSample(root, evidence, r, archive)
		}
		return r, e
	}
	groups := map[string][]capacitySample{}
	for iteration := 0; iteration < 2; iteration++ {
		order := append([]footprintPolicy(nil), policies...)
		if iteration == 1 {
			for i, j := 0, len(order)-1; i < j; i, j = i+1, j-1 {
				order[i], order[j] = order[j], order[i]
			}
		}
		for _, policy := range order {
			r, e := runSample(policy, iteration, 1, false)
			if e != nil {
				return e
			}
			groups[policy.Name] = append(groups[policy.Name], r)
		}
	}
	base := footprintMetrics(groups[policies[0].Name])
	if !footprintTimingPass(footprintMetrics(groups["E-fp-compressed"]), base) {
		p := footprintPolicy{"E-fp-artifacts", 64, "artifacts"}
		policies = append(policies, p)
		for i := 0; i < 2; i++ {
			r, e := runSample(p, i, 1, false)
			if e != nil {
				return e
			}
			groups[p.Name] = append(groups[p.Name], r)
		}
	}
	screened := []footprintPolicy{}
	metrics := map[string]map[string]float64{}
	for _, p := range policies {
		m := footprintMetrics(groups[p.Name])
		metrics[p.Name] = m
		if p.Name != policies[0].Name && footprintScreenPass(m, base) {
			screened = append(screened, p)
		}
	}
	// Combining independent passing changes is screened again, never assumed additive.
	var compression *footprintPolicy
	var geometry *footprintPolicy
	for i := range screened {
		p := &screened[i]
		if p.Compression != "none" && (compression == nil || metrics[p.Name]["combinedMedianBytes"] < metrics[compression.Name]["combinedMedianBytes"]) {
			compression = p
		}
		if p.CapacityGiB != 64 && (geometry == nil || metrics[p.Name]["combinedMedianBytes"] < metrics[geometry.Name]["combinedMedianBytes"]) {
			geometry = p
		}
	}
	if compression != nil && geometry != nil {
		p := footprintPolicy{"E-fp-combined", geometry.CapacityGiB, compression.Compression}
		policies = append(policies, p)
		for i := 0; i < 2; i++ {
			r, e := runSample(p, i, 1, false)
			if e != nil {
				return e
			}
			groups[p.Name] = append(groups[p.Name], r)
		}
		metrics[p.Name] = footprintMetrics(groups[p.Name])
		if footprintScreenPass(metrics[p.Name], base) {
			screened = append(screened, p)
		}
	}
	if err = save(filepath.Join(root, "screening.json"), map[string]any{"metrics": metrics, "advanced": screened, "policies": policies}); err != nil {
		return err
	}
	finals := map[string][]capacitySample{}
	if len(screened) > 0 {
		finalPolicies := append([]footprintPolicy{policies[0]}, screened...)
		for i := 0; i < 3; i++ {
			for j := range finalPolicies {
				p := finalPolicies[(j+i)%len(finalPolicies)]
				r, e := runSample(p, 10+i, 5, false)
				if e != nil {
					return e
				}
				finals[p.Name] = append(finals[p.Name], r)
			}
		}
		base = footprintMetrics(finals[policies[0].Name])
		metrics = map[string]map[string]float64{policies[0].Name: base}
		winners := []footprintPolicy{}
		for _, p := range screened {
			m := footprintMetrics(finals[p.Name])
			metrics[p.Name] = m
			if footprintPass(m, base, 0.20) {
				winners = append(winners, p)
			}
		}
		sort.Slice(winners, func(i, j int) bool {
			return metrics[winners[i].Name]["combinedMedianBytes"] < metrics[winners[j].Name]["combinedMedianBytes"]
		})
		if len(winners) > 0 {
			selected = winners[0].Name
			best := winners[0]
			for _, p := range winners {
				if metrics[p.Name]["combinedMedianBytes"] <= metrics[winners[0].Name]["combinedMedianBytes"]*1.05 && metrics[p.Name]["readyMs"] < metrics[selected]["readyMs"] {
					selected = p.Name
					best = p
				}
			}
			var retained []capacitySample
			for i := 0; i < 2; i++ {
				r, e := runSample(best, 100+i, 1, true)
				if e != nil {
					return e
				}
				retained = append(retained, r)
			}
			if err = verifyStartupRetained(ctx, root, evidence, unity, testplay, retained); err != nil {
				return err
			}
			qualified = true
		}
	}
	return save(filepath.Join(root, "qualification.json"), map[string]any{"qualified": qualified, "selected": selected, "metrics": metrics, "screened": screened, "attributionPending": true})
}
