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

// effectiveScanMaxDepth returns the online-configurable scan depth (v0.9.79) when
// set, otherwise falls back to the env value, otherwise the built-in default. This
// removes the dependence on vaulthub.env for tuning.
func (a *App) effectiveScanMaxDepth() int {
	a.mu.RLock()
	v := a.scanMaxDepth
	a.mu.RUnlock()
	if v > 0 {
		return v
	}
	return scanMaxDepth()
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
// bluRayStructuralExt 是蓝光原盘（BDMV / CERTIFICATE 结构）里永远不会作为媒体播放的
// 结构文件扩展名：播放列表 .mpls、剪辑信息 .clpi、原盘对象 .bdmv、索引 .xml、证书 .otf/.sfx、
// 数据文件 .dat 等。v0.9.84：这些文件不再进索引。
//
// 背景（客户反馈「新增了部分不带元数据的视频文件，无法进行刮削」）：旧实现把原盘里的
// 每个结构文件都当成一条「影片」收录 —— 一部《黑鹰坠落》原盘 600+ 条（284 .mpls +
// 254 .clpi + 127 .m2ts + 14 .bdmv + …），列表不可用，前端的元数据刮削对 00001.m2ts
// 这类片段编号也永远命中不了。真正的视频片段（.m2ts/.mts）仍然保留，
// 并在前端按原盘目录合并成一条（见 web/js/02-media.js 的 collapseDiscFragments）。
var bluRayStructuralExt = map[string]bool{
	".mpls": true, ".clpi": true, ".bdmv": true, ".xml": true, ".otf": true,
	".sfx": true, ".dat": true, ".bdjo": true, ".jar": true, ".mpl": true, ".mo": true,
}

// inBluRayStructure 判断库内相对路径是否位于蓝光原盘结构目录内（BDMV / CERTIFICATE）。
func inBluRayStructure(rel string) bool {
	lower := strings.ToLower(filepath.ToSlash(rel))
	return strings.Contains(lower, "bdmv/") || strings.Contains(lower, "certificate/") ||
		strings.HasSuffix(lower, "bdmv") || strings.HasSuffix(lower, "certificate")
}

// skipIndexFile 决定某个库内相对路径是否跳过索引（v0.9.84）。
//
// 规则（只影响蓝光原盘结构，普通媒体库与 NFO/字幕 sidecar 完全不受影响）：
//   - 位于 BDMV/ 或 CERTIFICATE/ 下且扩展名属于结构文件 → 跳过；
//   - 位于 BDMV 的 BACKUP/、AUXDATA/、JAR/、BDJO/、META/ 子目录 → 跳过；
//   - CERTIFICATE/ 下的全部文件（证书）→ 跳过；
//   - BDMV/STREAM/ 下的 .m2ts/.mts 等真实视频 → 保留。
func skipIndexFile(rel string) bool {
	slash := filepath.ToSlash(rel)
	lower := strings.ToLower(slash)
	if !inBluRayStructure(lower) {
		return false
	}
	if strings.Contains(lower, "certificate/") {
		return true
	}
	for _, dir := range []string{"/backup/", "/auxdata/", "/jar/", "/bdjo/", "/meta/", "/meta_dl/"} {
		if strings.Contains(lower, dir) {
			return true
		}
	}
	return bluRayStructuralExt[strings.ToLower(filepath.Ext(slash))]
}

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
			if skipIndexFile(rel) {
				continue
			}
			emit(scannedFile{Rel: rel, Size: st.Size(), MTime: st.ModTime().Unix()})
		}
		return nil
	}
	return walk(realRoot, 1)
}

// walkMultiLibraryFiles extends walkLibraryFiles to enumerate every regular file
// under one or more roots (paths slice). v0.9.52：多存储路径支持。
//
// 关键语义（向后兼容）：
//   - roots 只有一个（单路径库，Paths 为空 —— 存量库与全部旧契约测试）时，
//     行为与 walkLibraryFiles 完全一致：rel 不带任何前缀。
//   - roots 多个（用户为同一媒体库挂载了多个存储路径）时，每个 root 的条目
//     以 root 目录名为前缀（<root-base>/<rel>），避免不同存储路径下同名文件
//     在 files 表 (lib,path) 主键上互相覆盖。请求端拿到的正是这个带前缀的
//     path，safeFile 用同一规则解析回真实文件。
func walkMultiLibraryFiles(ctx context.Context, roots []string, maxDepth int, emit func(scannedFile)) error {
	if len(roots) <= 1 {
		if len(roots) == 0 {
			return nil
		}
		return walkLibraryFiles(ctx, roots[0], maxDepth, emit)
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		rootBase := filepath.Base(root)
		if rootBase == "" || rootBase == "." || rootBase == string(os.PathSeparator) {
			rootBase = "root"
		}
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
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
				st, e := os.Stat(full)
				if e != nil {
					continue
				}
				real, e := filepath.EvalSymlinks(full)
				if e != nil || !allowedRealPath(realRoot, real) {
					// 多路径下每个 root 自身就是边界（主路径规则已放宽到
					// MEDIA_ROOT，见 walkLibraryFiles 注释）；root 内符号链接
					// 仍必须留在 mediaRootBoundary() 内。
					if !allowedRealPath(mediaRootBoundary(), real) {
						continue
					}
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
				if skipIndexFile(rel) {
					continue
				}
				// 多路径：以 root 目录名为前缀，保证 (lib,path) 全局唯一。
				prefixedRel := filepath.Join(rootBase, rel)
				emit(scannedFile{Rel: prefixedRel, Size: st.Size(), MTime: st.ModTime().Unix()})
			}
			return nil
		}
		if err := walk(realRoot, 1); err != nil {
			return err
		}
	}
	return nil
}

