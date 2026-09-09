//go:build windows

package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// Capacity verification is outside timed workloads. Copying remains serial to
// preserve the placement experiment; only immutable content reads use workers.
func scanParallel(root string) (manifest, error) {
	type task struct{ relative, path string }
	jobs := make(chan task, 32)
	result := manifest{}
	var lock sync.Mutex
	var first error
	recordError := func(e error) {
		if e != nil {
			lock.Lock()
			if first == nil {
				first = e
			}
			lock.Unlock()
		}
	}
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range jobs {
				record, e := hashFileRecord(job.path)
				if e != nil {
					recordError(e)
					continue
				}
				lock.Lock()
				result[job.relative] = record
				lock.Unlock()
			}
		}()
	}
	err := fs.WalkDir(os.DirFS(root), ".", func(rel string, entry fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		p := filepath.Join(root, filepath.FromSlash(rel))
		if p != root {
			if e = regularNode(p, info); e != nil {
				return e
			}
		}
		if info.IsDir() {
			if rel != "." && (info.Name() == "System Volume Information" || info.Name() == "$RECYCLE.BIN") {
				return filepath.SkipDir
			}
			return nil
		}
		jobs <- task{relative: filepath.ToSlash(rel), path: p}
		return nil
	})
	recordError(err)
	close(jobs)
	workers.Wait()
	return result, first
}
