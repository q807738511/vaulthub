package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	a := &App{
		jobs:        map[string]uint64{},
		scanCancel:  map[string]context.CancelFunc{},
		generations: map[string]uint64{},
		deleting:    map[string]bool{},
		tasks:       map[string]context.CancelFunc{},
		scanGate:    make(chan struct{}, 1),
		config:      filepath.Join(root, "libraries.json"),
		indexDir:    filepath.Join(root, "index"),
	}
	a.openDB()
	if a.db == nil {
		t.Fatal("index database did not open")
	}
	t.Cleanup(func() { _ = a.db.Close() })
	return a
}

func postLibrary(t *testing.T, a *App, l Library) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/media/libraries", bytes.NewReader(b))
	req.Header.Set("X-VaultHub-Token", "test-token")
	rr := httptest.NewRecorder()
	a.libraries(rr, req)
	return rr
}

func makeFiles(t *testing.T, dir string, n int) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%05d.txt", i)), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func waitIdle(t *testing.T, a *App, id string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.RLock()
		running := a.jobs[id] != 0
		a.mu.RUnlock()
		if !running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("scan %s did not stop", id)
}

func pathsFor(t *testing.T, db *sql.DB, id string) []string {
	t.Helper()
	rs, err := db.Query(`SELECT path FROM files WHERE lib=? ORDER BY path`, id)
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	var out []string
	for rs.Next() {
		var p string
		if err := rs.Scan(&p); err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	if err := rs.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// Cancelling during phase 2 must never expose a partial replacement. The old
// ready index remains authoritative until the new generation is fully staged.
func TestCancelDuringWritePreservesOldIndex(t *testing.T) {
	a := testApp(t)
	dir := filepath.Join(t.TempDir(), "many")
	makeFiles(t, dir, 2500)
	lib := Library{ID: "books", Name: "Books", Type: "book", Path: dir}
	a.libs = []Library{lib}
	if _, err := a.db.Exec(`INSERT INTO files(lib,path,size,mtime) VALUES(?,?,?,?)`, lib.ID, "old.txt", 9, 1); err != nil {
		t.Fatal(err)
	}

	cancelled := make(chan struct{})
	a.scanWriteHook = func(id string, written int) {
		if id == lib.ID && written >= 2000 {
			a.mu.Lock()
			if cancel := a.scanCancel[id]; cancel != nil {
				cancel()
			}
			a.mu.Unlock()
			select {
			case <-cancelled:
			default:
				close(cancelled)
			}
		}
	}
	a.start(lib)
	waitIdle(t, a, lib.ID)
	select {
	case <-cancelled:
	default:
		t.Fatal("test did not reach phase-2 write hook")
	}
	got := pathsFor(t, a.db, lib.ID)
	if len(got) != 1 || got[0] != "old.txt" {
		t.Fatalf("cancelled replacement exposed partial index: count=%d first=%v", len(got), got[:min(len(got), 3)])
	}
}

// Removing a library invalidates its running generation and clears all DB
// state. Reusing the same ID must index only the new path, never stale results.
func TestDeleteRunningLibraryThenReuseID(t *testing.T) {
	a := testApp(t)
	oldDir := filepath.Join(t.TempDir(), "old")
	newDir := filepath.Join(t.TempDir(), "new")
	makeFiles(t, oldDir, 2500)
	makeFiles(t, newDir, 1)
	oldLib := Library{ID: "same", Name: "Old", Type: "book", Path: oldDir}
	newLib := Library{ID: "same", Name: "New", Type: "book", Path: newDir}
	a.libs = []Library{oldLib}

	startedWriting := make(chan struct{})
	releaseWrite := make(chan struct{})
	a.scanWriteHook = func(id string, written int) {
		if id == oldLib.ID && written >= 2000 {
			select {
			case <-startedWriting:
			default:
				close(startedWriting)
			}
			<-releaseWrite
		}
	}
	a.start(oldLib)
	select {
	case <-startedWriting:
	case <-time.After(10 * time.Second):
		t.Fatal("old scan never reached write phase")
	}

	removed := make(chan error, 1)
	go func() {
		found, err := a.removeLibrary(oldLib.ID)
		if err == nil && !found {
			err = fmt.Errorf("library not found")
		}
		removed <- err
	}()
	close(releaseWrite)
	if err := <-removed; err != nil {
		t.Fatal(err)
	}
	if got := pathsFor(t, a.db, oldLib.ID); len(got) != 0 {
		t.Fatalf("deleted library retained file rows: %v", got[:min(len(got), 5)])
	}
	for table, query := range map[string]string{
		"status":  `SELECT count(*) FROM index_status WHERE lib=?`,
		"staging": `SELECT count(*) FROM scan_staging WHERE lib=?`,
	} {
		var n int
		if err := a.db.QueryRow(query, oldLib.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("deleted library retained %s rows: %d", table, n)
		}
	}

	a.mu.Lock()
	a.libs = []Library{newLib}
	if err := a.saveLibrariesLocked(a.libs); err != nil {
		a.mu.Unlock()
		t.Fatal(err)
	}
	a.mu.Unlock()
	a.start(newLib)
	waitIdle(t, a, newLib.ID)

	got := pathsFor(t, a.db, newLib.ID)
	if len(got) != 1 || got[0] != "00000.txt" {
		t.Fatalf("reused id contains stale/incorrect rows: %v", got[:min(len(got), 5)])
	}
	var statusRows int
	if err := a.db.QueryRow(`SELECT count(*) FROM index_status WHERE lib=?`, newLib.ID).Scan(&statusRows); err != nil {
		t.Fatal(err)
	}
	if statusRows != 1 {
		t.Fatalf("expected exactly one status row for new generation, got %d", statusRows)
	}
}

// Reusing an ID while DELETE is between config removal and DB cleanup must be
// rejected; otherwise the old DELETE can erase the new index.
func TestConcurrentDeleteBlocksSameIDRecreate(t *testing.T) {
	t.Setenv("ADMIN_TOKEN", "test-token")
	a := testApp(t)
	oldDir := filepath.Join(t.TempDir(), "old")
	newDir := filepath.Join(t.TempDir(), "new")
	makeFiles(t, oldDir, 1)
	makeFiles(t, newDir, 1)
	oldLib := Library{ID: "same", Name: "Old", Type: "book", Path: oldDir}
	newLib := Library{ID: "same", Name: "New", Type: "book", Path: newDir}
	a.libs = []Library{oldLib}
	if err := a.saveLibrariesLocked(a.libs); err != nil {
		t.Fatal(err)
	}

	deletePaused := make(chan struct{})
	releaseDelete := make(chan struct{})
	a.removeHook = func(string) {
		close(deletePaused)
		<-releaseDelete
	}
	removed := make(chan error, 1)
	go func() {
		_, err := a.removeLibrary(oldLib.ID)
		removed <- err
	}()
	select {
	case <-deletePaused:
	case <-time.After(5 * time.Second):
		t.Fatal("delete did not reach protected cleanup window")
	}
	if rr := postLibrary(t, a, newLib); rr.Code != http.StatusConflict {
		t.Fatalf("same-ID POST during delete = %d, want 409; body=%s", rr.Code, rr.Body.String())
	}
	close(releaseDelete)
	if err := <-removed; err != nil {
		t.Fatal(err)
	}
	a.removeHook = nil
	if rr := postLibrary(t, a, newLib); rr.Code != http.StatusCreated {
		t.Fatalf("same-ID POST after delete = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}
	waitIdle(t, a, newLib.ID)
	got := pathsFor(t, a.db, newLib.ID)
	if len(got) != 1 || got[0] != "00000.txt" {
		t.Fatalf("new index was erased or polluted after delete: %v", got)
	}
}
