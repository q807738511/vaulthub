package main

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// v0.9.30: media library scanning must descend through symlinked directories and
// index symlinked files. filepath.Walk() lstat()s entries, so linked season
// folders / collections inside a library were silently missing from the index.
// Containment stays strict: a link resolving outside the media root is skipped,
// because safeFile() would refuse to serve it anyway.
func collect(t *testing.T, root string, depth int) []string {
	t.Helper()
	var out []string
	if err := walkLibraryFiles(context.Background(), root, depth, func(f scannedFile) {
		out = append(out, filepath.ToSlash(f.Rel))
	}); err != nil {
		t.Fatalf("walk failed: %v", err)
	}
	sort.Strings(out)
	return out
}

// setMediaRoot overrides the MEDIA_ROOT symlink boundary for one test.
func setMediaRoot(t *testing.T, p string) {
	t.Helper()
	old := mediaRootPath
	mediaRootPath = p
	t.Cleanup(func() { mediaRootPath = old })
}

func mustWrite(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestWalkFollowsSymlinkedDirectoriesAndFilesInsideRoot(t *testing.T) {
	root := t.TempDir()
	// A hidden storage area inside the library, linked into the visible tree —
	// the common NAS layout that filepath.Walk() never descended into.
	mustWrite(t, filepath.Join(root, "Show", "Season 01", "S01E01.mkv"))
	mustWrite(t, filepath.Join(root, ".storage", "Season 02", "S02E01.mkv"))
	mustWrite(t, filepath.Join(root, ".storage", "linked-movie.mkv"))

	if err := os.Symlink(filepath.Join(root, ".storage", "Season 02"), filepath.Join(root, "Show", "Season 02")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, ".storage", "linked-movie.mkv"), filepath.Join(root, "linked-movie.mkv")); err != nil {
		t.Fatal(err)
	}

	got := collect(t, root, defaultScanMaxDepth)
	want := map[string]bool{
		"Show/Season 01/S01E01.mkv": true,
		"Show/Season 02/S02E01.mkv": true, // through the symlinked directory
		"linked-movie.mkv":          true, // through the symlinked file
	}
	for _, rel := range got {
		delete(want, rel)
	}
	if len(want) != 0 {
		t.Fatalf("missing entries %v, got %v", want, got)
	}
}

func TestWalkRejectsSymlinkEscapingMediaRoot(t *testing.T) {
	base := t.TempDir()
	// MEDIA_ROOT boundary: media volumes live under base/media, everything else
	// (a fake /etc) is outside and must stay unreachable.
	mediaRoot := filepath.Join(base, "media")
	root := filepath.Join(mediaRoot, "library")
	outside := filepath.Join(base, "etc")
	mustWrite(t, filepath.Join(root, "inside.mkv"))
	mustWrite(t, filepath.Join(outside, "secret.conf"))
	setMediaRoot(t, mediaRoot)

	if err := os.Symlink(filepath.Join(outside, "secret.conf"), filepath.Join(root, "escape.mkv")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape-dir")); err != nil {
		t.Fatal(err)
	}

	got := collect(t, root, defaultScanMaxDepth)
	if len(got) != 1 || got[0] != "inside.mkv" {
		t.Fatalf("symlinks leaving MEDIA_ROOT must be skipped, got %v", got)
	}
}

func TestWalkFollowsSymlinkToAnotherMediaVolume(t *testing.T) {
	base := t.TempDir()
	mediaRoot := filepath.Join(base, "media")
	root := filepath.Join(mediaRoot, "library")
	other := filepath.Join(mediaRoot, "volume2", "Movies")
	mustWrite(t, filepath.Join(root, "local.mkv"))
	mustWrite(t, filepath.Join(other, "second-volume.mkv"))
	setMediaRoot(t, mediaRoot)

	// The standard NAS layout: a folder from a second media volume linked into a
	// library. It must be indexed, and safeFile() must be able to serve it.
	if err := os.Symlink(other, filepath.Join(root, "Volume2")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	got := collect(t, root, defaultScanMaxDepth)
	if len(got) != 2 {
		t.Fatalf("cross-volume link must be indexed, got %v", got)
	}
	lib := Library{ID: "films", Type: "movie", Path: root}
	for _, rel := range got {
		if _, _, err := safeFile(lib, rel); err != nil {
			t.Fatalf("indexed entry %q must be servable: %v", rel, err)
		}
	}
}

func TestSafeFileStillRejectsPathsOutsideMediaRoot(t *testing.T) {
	base := t.TempDir()
	mediaRoot := filepath.Join(base, "media")
	root := filepath.Join(mediaRoot, "library")
	outside := filepath.Join(base, "etc")
	mustWrite(t, filepath.Join(root, "ok.mkv"))
	mustWrite(t, filepath.Join(outside, "passwd"))
	setMediaRoot(t, mediaRoot)
	if err := os.Symlink(filepath.Join(outside, "passwd"), filepath.Join(root, "leak.mkv")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	lib := Library{ID: "films", Type: "movie", Path: root}
	if _, _, err := safeFile(lib, "leak.mkv"); err == nil {
		t.Fatal("a link out of MEDIA_ROOT must not be servable")
	}
	for _, bad := range []string{"../etc/passwd", "/etc/passwd", "..", "sub\\win.mkv"} {
		if _, _, err := safeFile(lib, bad); err == nil {
			t.Fatalf("request %q must be rejected", bad)
		}
	}
	if _, _, err := safeFile(lib, "ok.mkv"); err != nil {
		t.Fatalf("normal file must stay servable: %v", err)
	}
}

func TestMediaRootBoundaryIgnoresUnsafeValues(t *testing.T) {
	for _, raw := range []string{"", "/", "   ", "/definitely/not/existing/path"} {
		setMediaRoot(t, raw)
		if got := mediaRootBoundary(); got != "" {
			t.Fatalf("MEDIA_ROOT %q must not become a boundary, got %q", raw, got)
		}
	}
	// With no usable boundary only the library root counts.
	base := t.TempDir()
	root := filepath.Join(base, "library")
	outside := filepath.Join(base, "outside")
	mustWrite(t, filepath.Join(root, "inside.mkv"))
	mustWrite(t, filepath.Join(outside, "nope.mkv"))
	setMediaRoot(t, "/")
	if err := os.Symlink(filepath.Join(outside, "nope.mkv"), filepath.Join(root, "link.mkv")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	got := collect(t, root, defaultScanMaxDepth)
	if len(got) != 1 || got[0] != "inside.mkv" {
		t.Fatalf("without a boundary only the library root counts, got %v", got)
	}
}

func TestWalkTerminatesOnSymlinkCycle(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "a", "film.mkv"))
	// a/loop -> root: without ancestor tracking this recurses forever.
	if err := os.Symlink(root, filepath.Join(root, "a", "loop")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	got := collect(t, root, defaultScanMaxDepth)
	if len(got) != 1 || got[0] != "a/film.mkv" {
		t.Fatalf("cycle must be visited once, got %v", got)
	}
}

func TestWalkIndexesSameTargetReachableTwice(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "real", "film.mkv"))
	// Two visible names for the same real directory: both must be indexed, so a
	// global visited-set would be wrong (only per-path cycles may be cut).
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "alias")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	got := collect(t, root, defaultScanMaxDepth)
	if len(got) != 2 {
		t.Fatalf("both paths to the same target must be indexed, got %v", got)
	}
}

func TestWalkHonoursDepthLimit(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "l1", "shallow.mkv"))
	mustWrite(t, filepath.Join(root, "l1", "l2", "l3", "deep.mkv"))

	// depth 2 covers root + l1 only.
	got := collect(t, root, 2)
	if len(got) != 1 || got[0] != "l1/shallow.mkv" {
		t.Fatalf("depth limit not honoured, got %v", got)
	}
	// depth 0 disables the limit entirely.
	all := collect(t, root, 0)
	if len(all) != 2 {
		t.Fatalf("depth 0 must be unlimited, got %v", all)
	}
	// The default depth is deep enough for real libraries.
	if defaultScanMaxDepth < 32 {
		t.Fatalf("default depth too shallow: %d", defaultScanMaxDepth)
	}
}

func TestWalkSurvivesUnreadableSubdirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "ok.mkv"))
	locked := filepath.Join(root, "locked")
	if err := os.MkdirAll(locked, 0755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(locked, "hidden.mkv"))
	if err := os.Chmod(locked, 0000); err != nil {
		t.Skipf("cannot drop permissions: %v", err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0755) })

	got := collect(t, root, defaultScanMaxDepth)
	if len(got) != 1 || got[0] != "ok.mkv" {
		t.Fatalf("one unreadable directory must not fail the scan, got %v", got)
	}
}

func TestScanMaxDepthFallsBackOnBadValue(t *testing.T) {
	t.Setenv("MEDIA_SCAN_MAX_DEPTH", "not-a-number")
	if got := scanMaxDepth(); got != defaultScanMaxDepth {
		t.Fatalf("bad value must fall back to %d, got %d", defaultScanMaxDepth, got)
	}
	t.Setenv("MEDIA_SCAN_MAX_DEPTH", "5")
	if got := scanMaxDepth(); got != 5 {
		t.Fatalf("configured depth must win, got %d", got)
	}
	t.Setenv("MEDIA_SCAN_MAX_DEPTH", "0")
	if got := scanMaxDepth(); got != 0 {
		t.Fatalf("0 must disable the limit, got %d", got)
	}
}
