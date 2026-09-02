package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// defaultScanMaxDepth bounds recursion so a pathological link/mount layout cannot
// walk forever. Real media libraries nest well under 10 levels; 32 leaves a lot of
// head room. MEDIA_SCAN_MAX_DEPTH=0 disables the limit entirely.
const defaultScanMaxDepth = 32

// mediaRootPath is the mount point that holds every media volume (MEDIA_ROOT,
// default /media). It is the outer boundary for symlinks placed inside a library:
// a link may point at another media volume, but never at a system path.
// Set once in App.load(); tests override it directly.
var mediaRootPath = "/media"

// scanMaxDepth reads the configured recursion limit. Values below zero fall back
// to the default so a typo cannot silently disable scanning.
func scanMaxDepth() int {
	v := envInt64("MEDIA_SCAN_MAX_DEPTH", int64(defaultScanMaxDepth))
	if v < 0 {
		return defaultScanMaxDepth
	}
	return int(v)
}

// mediaRootBoundary resolves the media mount point used as the symlink boundary.
// It returns "" when the boundary must not be applied — an empty MEDIA_ROOT, the
// filesystem root, or an unresolvable path would turn "inside the media tree"
// into "anywhere on disk", so in those cases only the library root counts.
func mediaRootBoundary() string {
	raw := strings.TrimSpace(mediaRootPath)
	if raw == "" || raw == "/" {
		return ""
	}
	real, err := filepath.EvalSymlinks(raw)
	if err != nil || real == "" || real == "/" {
		return ""
	}
	return real
}

// withinRoot reports whether p is root itself or nested under it.
func withinRoot(p, root string) bool {
	if root == "" || p == "" {
		return false
	}
	return p == root || strings.HasPrefix(p, root+string(os.PathSeparator))
}

// allowedRealPath decides whether a resolved path may be indexed and served for
// this library.
//
// v0.9.30: the old rule was "resolved path must be under the library root", which
// meant a symlink pointing at another disk was both skipped by the scanner and
// refused by safeFile(). Linking a folder from a second volume into a library is
// the standard NAS layout, so those items simply never appeared ("扫描不到缺少元素").
// The rule is now "under the library root, or under the media mount point
// (MEDIA_ROOT)" — every media volume is mapped inside that mount, while system
// paths such as /etc stay unreachable. Requests still cannot contain "..", an
// absolute path or a backslash, so only links placed inside the library by the
// operator can reach the wider boundary.
func allowedRealPath(libRoot, real string) bool {
	if withinRoot(real, libRoot) {
		return true
	}
	return withinRoot(real, mediaRootBoundary())
}

// scannedFile is one indexable entry produced by walkLibraryFiles.
type scannedFile struct {
	Rel   string
	Size  int64
	MTime int64
}

// walkLibraryFiles enumerates every regular file under root, descending through
// symlinked directories and indexing symlinked files.
//
// v0.9.30: filepath.Walk() lstat()s each entry, so a symlinked directory was
// reported as a non-regular file and never descended into, and a symlinked media
// file was skipped outright.
//
// Invariants:
//
//   - A resolved path must satisfy allowedRealPath(), i.e. stay inside the library
//     root or the media mount point. safeFile() applies the same rule when serving,
//     so what gets indexed is exactly what can be played.
//   - Cycle detection is per recursion path (ancestors only), not global: the same
//     real directory can legitimately be reachable through two different paths and
//     both must be indexed. Only a directory that contains itself is cut off.
//   - A single unreadable subdirectory must not fail the scan, otherwise one
//     permission error wipes an entire library's index.
func walkLibraryFiles(ctx context.Context, root string, maxDepth int, emit func(scannedFile)) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}

	// ancestors holds the resolved directories on the current recursion path.
	ancestors := map[string]bool{realRoot: true}

	var walk func(dir string, depth int) error
	walk = func(dir string, depth int) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if maxDepth > 0 && depth > maxDepth {
			return nil
		}
		entries, e := os.ReadDir(dir)
		if e != nil {
			return nil
		}
		for _, entry := range entries {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			full := filepath.Join(dir, entry.Name())
			// Stat() follows symlinks, so a link is classified by what it points
			// at rather than by the link itself.
			st, e := os.Stat(full)
			if e != nil {
				continue
			}
			real, e := filepath.EvalSymlinks(full)
			if e != nil || !allowedRealPath(realRoot, real) {
				continue
			}
			if st.IsDir() {
				if ancestors[real] {
					continue
				}
				ancestors[real] = true
				err := walk(full, depth+1)
				delete(ancestors, real)
				if err != nil {
					return err
				}
				continue
			}
			if !st.Mode().IsRegular() {
				continue
			}
			rel, e := filepath.Rel(realRoot, full)
			if e != nil || rel == "." || strings.HasPrefix(rel, "..") {
				continue
			}
			emit(scannedFile{Rel: rel, Size: st.Size(), MTime: st.ModTime().Unix()})
		}
		return nil
	}
	return walk(realRoot, 1)
}
