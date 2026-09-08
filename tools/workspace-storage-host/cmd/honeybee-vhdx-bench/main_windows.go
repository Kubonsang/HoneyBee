//go:build windows

// honeybee-vhdx-bench measures disposable Library-only disks. It never contacts
// the installed broker and never opens an existing child for mutation.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"golang.org/x/sys/windows"
)

type fileRecord struct {
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type manifest map[string]fileRecord
type measurement struct {
	MeasurementProtocol string             `json:"measurementProtocol"`
	Traced              bool               `json:"traced"`
	Mode                string             `json:"mode"`
	Iteration           int                `json:"iteration"`
	Child               string             `json:"child"`
	CreateMS            int64              `json:"createMs"`
	UnityMS             int64              `json:"unityMs"`
	ReopenMS            int64              `json:"reopenMs"`
	Ready               storage.FileUsage  `json:"ready"`
	AfterUnity          storage.FileUsage  `json:"afterUnity"`
	AfterReopen         storage.FileUsage  `json:"afterReopen"`
	AfterDetach         storage.FileUsage  `json:"afterDetach"`
	AfterVerification   storage.FileUsage  `json:"afterVerification"`
	Geometry            storage.SizeInfo   `json:"geometry"`
	Changed             map[string]int64   `json:"changedContentBytesByTopDirectory"`
	CompactBefore       *storage.FileUsage `json:"compactBefore,omitempty"`
	CompactAfter        *storage.FileUsage `json:"compactAfter,omitempty"`
	CompactMS           int64              `json:"compactMs,omitempty"`
	CompactVerified     bool               `json:"compactVerified"`
}

func main() {
	root := flag.String("root", "", "new directory under this checkout's tmp directory")
	source := flag.String("source", "", "closed Unity project; read only")
	unity := flag.String("unity", "", "Unity executable")
	runs := flag.Int("runs", 3, "fresh children per geometry (1..10)")
	trace := flag.Bool("trace-writes", false, "capture a separate WPR FileIO trace; exclude traced timings from release gates")
	flag.Parse()
	if err := run(*root, *source, *unity, *runs, *trace); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func validateRoot(root string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	base := filepath.Join(cwd, "tmp")
	rel, err := filepath.Rel(base, root)
	if err != nil || !filepath.IsAbs(root) || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("root must be a new directory inside checkout/tmp")
	}
	// Refuse ancestor junctions before any disk creation or recursive copy.
	for p := filepath.Dir(root); ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if err := regularNode(p, info); err != nil {
			return err
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		return errors.New("benchmark root already exists or cannot be inspected")
	}
	return nil
}
func regularNode(p string, info fs.FileInfo) error {
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || data.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("reparse/unknown entry: %s", p)
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return fmt.Errorf("nonregular entry: %s", p)
	}
	return nil
}
func copyFile(src, dst string) (err error) {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if err = regularNode(src, info); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	err = errors.Join(err, out.Close())
	if err != nil {
		return err
	}
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}
func copyTree(src, dst string) error {
	return filepath.Walk(src, func(p string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if err = regularNode(p, info); err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(to, 0700)
		}
		return copyFile(p, to)
	})
}
func scan(root string) (manifest, error) {
	result := manifest{}
	err := fs.WalkDir(os.DirFS(root), ".", func(rel string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		p := filepath.Join(root, filepath.FromSlash(rel))
		// The root may be our mounted Library. Descendant links are forbidden.
		if p != root {
			if err = regularNode(p, info); err != nil {
				return err
			}
		}
		if info.IsDir() {
			if p != root && (info.Name() == "System Volume Information" || info.Name() == "$RECYCLE.BIN") {
				return filepath.SkipDir
			}
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		err = errors.Join(err, f.Close())
		if err != nil {
			return err
		}
		result[filepath.ToSlash(rel)] = fileRecord{info.Size(), hex.EncodeToString(h.Sum(nil))}
		return nil
	})
	return result, err
}
func same(a, b manifest) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}
func changes(before, after manifest) map[string]int64 {
	result := map[string]int64{}
	for name, value := range after {
		if old, ok := before[name]; !ok || old != value {
			top, _, found := strings.Cut(name, "/")
			if !found {
				top = "(root)"
			}
			result[top] += value.Bytes
		}
	}
	return result
}
func save(p string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, append(b, '\n'), 0600)
}
func closeDisk(a *storage.Attachment) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := a.Close(ctx); err != nil {
		return err
	}
	_, _, err := a.WaitDetached(ctx)
	return err
}
func withDisk(ctx context.Context, disk, mount string, initialize bool, fn func(*storage.Attachment) error) (err error) {
	if err = os.Mkdir(mount, 0700); err != nil {
		return err
	}
	a, err := storage.OpenAndAttach(disk, false)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, closeDisk(a)) }()
	if initialize {
		err = a.InitializeAndMount(ctx, mount)
	} else {
		err = a.MountExisting(ctx, mount, false)
	}
	if err != nil {
		return err
	}
	if err = fn(a); err != nil {
		return err
	}
	return a.Flush(ctx)
}

// Hashing an NTFS file can itself write last-access metadata. Verify only after
// timing/allocation measurements, through a genuinely read-only attachment.
func withReadOnlyDisk(ctx context.Context, disk, mount string, fn func(*storage.Attachment) error) (err error) {
	if err = os.Mkdir(mount, 0700); err != nil {
		return err
	}
	a, err := storage.OpenAndAttach(disk, true)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, closeDisk(a)) }()
	if err = a.MountExisting(ctx, mount, true); err != nil {
		return err
	}
	return fn(a)
}
func launchUnity(ctx context.Context, unity, project, log string, trace bool) (elapsed int64, err error) {
	if trace {
		instance := fmt.Sprintf("HoneyBeeVhdx-%d-%d", os.Getpid(), time.Now().UnixNano())
		startTrace := exec.CommandContext(ctx, "wpr.exe", "-start", "FileIO", "-filemode", "-instancename", instance)
		startTrace.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if output, e := startTrace.CombinedOutput(); e != nil {
			return 0, fmt.Errorf("start own FileIO trace: %w: %s", e, output)
		}
		defer func() {
			stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			stop := exec.CommandContext(stopCtx, "wpr.exe", "-stop", log+".etl", "-instancename", instance)
			stop.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
			if output, e := stop.CombinedOutput(); e != nil {
				err = errors.Join(err, fmt.Errorf("stop trace instance %s: %w: %s", instance, e, output))
			}
		}()
	}
	start := time.Now()
	cmd := exec.CommandContext(ctx, unity, "-batchmode", "-nographics", "-quit", "-projectPath", project, "-logFile", log)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	elapsed = time.Since(start).Milliseconds()
	if cmd.Process != nil {
		err = errors.Join(err, save(log+".process.json", map[string]any{"pid": cmd.Process.Pid, "project": project, "traced": trace, "elapsedMs": elapsed}))
	}
	if err != nil {
		return elapsed, fmt.Errorf("Unity: %w: %s", err, out)
	}
	b, err := os.ReadFile(log)
	if err != nil {
		return elapsed, err
	}
	if !strings.Contains(string(b), "Exiting batchmode successfully now!") || strings.Contains(string(b), "error CS") {
		return elapsed, errors.New("Unity success marker missing or C# compiler errors; inspect log")
	}
	return elapsed, nil
}

func run(root, source, unity string, runs int, trace bool) (err error) {
	if runs < 1 || runs > 10 {
		return errors.New("runs must be 1..10")
	}
	if err = validateRoot(root); err != nil {
		return err
	}
	if !filepath.IsAbs(source) || !filepath.IsAbs(unity) {
		return errors.New("source and unity must be absolute")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	elevated, err := storage.IsElevated(ctx)
	if err != nil {
		return err
	}
	if !elevated {
		return errors.New("benchmark requires an elevated terminal to attach its disposable disks")
	}
	if err = os.Mkdir(root, 0700); err != nil {
		return err
	}
	defer func() {
		status := map[string]any{"finishedAt": time.Now().UTC(), "ok": err == nil}
		if err != nil {
			status["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, "status.json"), status))
	}()
	fmt.Println("snapshot", source)
	frozen := filepath.Join(root, "source")
	sourceBefore := map[string]manifest{}
	for _, folder := range []string{"Assets", "Packages", "ProjectSettings", "Library"} {
		p := filepath.Join(source, folder)
		m, e := scan(p)
		if e != nil {
			return e
		}
		sourceBefore[folder] = m
		if e = copyTree(p, filepath.Join(frozen, folder)); e != nil {
			return e
		}
		copied, e := scan(filepath.Join(frozen, folder))
		if e != nil {
			return e
		}
		if !same(m, copied) {
			return fmt.Errorf("source changed while copying %s", folder)
		}
	}
	if err = save(filepath.Join(root, "source-manifests.json"), sourceBefore); err != nil {
		return err
	}
	parents := map[string]string{}
	for _, mib := range []int{2} {
		mode := fmt.Sprintf("%dmib", mib)
		disk := filepath.Join(root, "parent-"+mode+".vhdx")
		mount := filepath.Join(root, "parent-"+mode+"-mount")
		fmt.Println("prepare", mode)
		if err = storage.CreateDynamicWithOptions(disk, storage.CreateOptions{MaximumSize: 64 << 30, BlockSizeInBytes: uint32(mib << 20), SectorSizeInBytes: 4096}); err != nil {
			return err
		}
		err = withDisk(ctx, disk, mount, true, func(a *storage.Attachment) error {
			if e := copyTree(filepath.Join(frozen, "Library"), mount); e != nil {
				return e
			}
			actual, e := scan(mount)
			if e != nil {
				return e
			}
			if !same(sourceBefore["Library"], actual) {
				return errors.New("parent content differs from frozen seed")
			}
			return nil
		})
		if err != nil {
			return err
		}
		parents[mode] = disk
	}
	// Both child geometries use the exact same immutable parent and NTFS layout.
	parents["1mib"] = parents["2mib"]
	rows := []measurement{}
	for iteration := 0; iteration < runs; iteration++ {
		modes := []string{"2mib", "1mib"}
		if iteration%2 == 1 {
			modes = []string{"1mib", "2mib"}
		}
		for _, mode := range modes {
			row, e := sample(ctx, root, frozen, unity, parents[mode], mode, iteration, sourceBefore["Library"], trace)
			if e != nil {
				return e
			}
			rows = append(rows, row)
			if err = save(filepath.Join(root, "measurements.json"), rows); err != nil {
				return err
			}
		}
	}
	for folder, before := range sourceBefore {
		after, e := scan(filepath.Join(source, folder))
		if e != nil {
			return e
		}
		if !same(before, after) {
			return fmt.Errorf("original source changed during benchmark: %s", folder)
		}
	}
	return nil
}
func sample(ctx context.Context, root, frozen, unity, parent, mode string, iteration int, seed manifest, trace bool) (row measurement, err error) {
	name := fmt.Sprintf("%s-%d", mode, iteration)
	project := filepath.Join(root, name)
	child := filepath.Join(root, name+".vhdx")
	mount := filepath.Join(project, "Library")
	row = measurement{MeasurementProtocol: "readonly-verification-v2", Mode: mode, Iteration: iteration, Child: child, Traced: trace}
	fmt.Println("sample", name)
	for _, folder := range []string{"Assets", "Packages", "ProjectSettings"} {
		if err = copyTree(filepath.Join(frozen, folder), filepath.Join(project, folder)); err != nil {
			return row, err
		}
	}
	started := time.Now()
	block := uint32(2 << 20)
	if mode == "1mib" {
		block = 1 << 20
	}
	if err = createChild(child, parent, block); err != nil {
		return row, err
	}
	var after manifest
	err = withDisk(ctx, child, mount, false, func(a *storage.Attachment) error {
		if e := a.VerifyParent(parent); e != nil {
			return e
		}
		var e error
		row.Geometry, e = a.Size()
		if e != nil {
			return e
		}
		expected := uint32(2 << 20)
		if mode == "1mib" {
			expected = 1 << 20
		}
		if row.Geometry.BlockSize != expected {
			return fmt.Errorf("child block size %d, want %d", row.Geometry.BlockSize, expected)
		}
		row.CreateMS = time.Since(started).Milliseconds()
		row.Ready, e = storage.FileUsageOf(child)
		if e != nil {
			return e
		}
		phase, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		row.UnityMS, e = launchUnity(phase, unity, project, filepath.Join(root, name+"-first.log"), trace)
		if e != nil {
			return e
		}
		if e = a.Flush(ctx); e != nil {
			return e
		}
		row.AfterUnity, e = storage.FileUsageOf(child)
		if e != nil {
			return e
		}
		row.ReopenMS, e = launchUnity(phase, unity, project, filepath.Join(root, name+"-reopen.log"), trace)
		if e != nil {
			return e
		}
		if e = a.Flush(ctx); e != nil {
			return e
		}
		row.AfterReopen, e = storage.FileUsageOf(child)
		if e != nil {
			return e
		}
		return nil
	})
	if err != nil {
		return row, err
	}
	row.AfterDetach, err = storage.FileUsageOf(child)
	if err != nil {
		return row, err
	}
	verifyMount := filepath.Join(root, name+"-final-readonly")
	err = withReadOnlyDisk(ctx, child, verifyMount, func(a *storage.Attachment) error {
		if e := a.VerifyParent(parent); e != nil {
			return e
		}
		var e error
		after, e = scan(verifyMount)
		if e != nil {
			return e
		}
		row.Changed = changes(seed, after)
		return save(filepath.Join(root, name+"-final-manifest.json"), after)
	})
	if err != nil {
		return row, err
	}
	row.AfterVerification, err = storage.FileUsageOf(child)
	if err != nil {
		return row, err
	}
	if row.AfterVerification != row.AfterDetach {
		return row, errors.New("read-only verification changed backing allocation")
	}
	if iteration == 0 {
		clone := filepath.Join(root, name+"-compact.vhdx")
		if err = copyFile(child, clone); err != nil {
			return row, err
		}
		before, e := storage.FileUsageOf(clone)
		if e != nil {
			return row, e
		}
		row.CompactBefore = &before
		started = time.Now()
		if err = compact(clone); err != nil {
			return row, err
		}
		row.CompactMS = time.Since(started).Milliseconds()
		usage, e := storage.FileUsageOf(clone)
		if e != nil {
			return row, e
		}
		row.CompactAfter = &usage
		err = withReadOnlyDisk(ctx, clone, filepath.Join(root, name+"-verify-mount"), func(a *storage.Attachment) error {
			if e := a.VerifyParent(parent); e != nil {
				return e
			}
			actual, e := scan(filepath.Join(root, name+"-verify-mount"))
			if e != nil {
				return e
			}
			if !same(after, actual) {
				return errors.New("compaction changed Library content")
			}
			row.CompactVerified = true
			return nil
		})
		if err != nil {
			return row, err
		}
	}
	fmt.Printf("finished %s first=%dms reopen=%dms\n", name, row.UnityMS, row.ReopenMS)
	return row, nil
}

// Only called with a freshly copied, detached benchmark child inside the claimed root.
func compact(path string) error {
	type storageType struct {
		DeviceID uint32
		Vendor   windows.GUID
	}
	kind := storageType{3, windows.GUID{Data1: 0xec984aec, Data2: 0xa0f9, Data3: 0x47e9, Data4: [8]byte{0x90, 0x1f, 0x71, 0x41, 0x5a, 0x66, 0x34, 0x5b}}}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	parameters := struct{ Version, RWDepth uint32 }{1, 1}
	var handle windows.Handle
	dll := windows.NewLazySystemDLL("virtdisk.dll")
	status, _, _ := dll.NewProc("OpenVirtualDisk").Call(uintptr(unsafe.Pointer(&kind)), uintptr(unsafe.Pointer(p)), 0x00200000, 0, uintptr(unsafe.Pointer(&parameters)), uintptr(unsafe.Pointer(&handle)))
	runtime.KeepAlive(p)
	if status != 0 {
		return fmt.Errorf("compact open: %w", syscall.Errno(status))
	}
	defer windows.CloseHandle(handle)
	options := struct{ Version, Reserved uint32 }{1, 0}
	status, _, _ = dll.NewProc("CompactVirtualDisk").Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&options)), 0)
	if status != 0 {
		return fmt.Errorf("compact: %w", syscall.Errno(status))
	}
	return nil
}
