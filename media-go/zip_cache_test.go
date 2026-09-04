package main

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func writeTestZip(t *testing.T, path string, pages []string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, name := range pages {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, "page-content-"+name); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestV0953ZipCacheReusesEntryForSameFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "comic.cbz")
	writeTestZip(t, p, []string{"001.jpg", "002.jpg", "003.jpg"})

	c := newZipArchiveCache(4)
	e1, err := c.acquire(p)
	if err != nil {
		t.Fatal(err)
	}
	e2, err := c.acquire(p)
	if err != nil {
		t.Fatal(err)
	}
	if e1 != e2 {
		t.Fatal("same file should reuse the cached entry")
	}
	if len(e2.files) != 3 || e2.display[2] != "003.jpg" {
		t.Fatalf("unexpected entries: %d", len(e2.files))
	}
	if i := e2.indexOf("002.jpg"); i != 1 {
		t.Fatalf("raw indexOf got %d want 1", i)
	}
	c.release(e1)
	c.release(e2)
}

func TestV0953ZipCacheReopensAfterFileReplaced(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "comic.cbz")
	writeTestZip(t, p, []string{"001.jpg", "002.jpg"})

	c := newZipArchiveCache(4)
	e1, err := c.acquire(p)
	if err != nil {
		t.Fatal(err)
	}
	c.release(e1)

	// Replace the archive with more pages: stat changes, cache must reopen.
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	writeTestZip(t, p, []string{"001.jpg", "002.jpg", "003.jpg", "004.jpg"})
	e2, err := c.acquire(p)
	if err != nil {
		t.Fatal(err)
	}
	defer c.release(e2)
	if e1 == e2 {
		t.Fatal("replaced file should produce a fresh entry")
	}
	if len(e2.files) != 4 {
		t.Fatalf("reopened archive has %d entries, want 4", len(e2.files))
	}
}

func TestV0953ZipCacheEvictsLeastRecentlyUsed(t *testing.T) {
	dir := t.TempDir()
	p1 := filepath.Join(dir, "a.cbz")
	p2 := filepath.Join(dir, "b.cbz")
	writeTestZip(t, p1, []string{"a1.jpg"})
	writeTestZip(t, p2, []string{"b1.jpg"})

	c := newZipArchiveCache(1)
	e1, err := c.acquire(p1)
	if err != nil {
		t.Fatal(err)
	}
	c.release(e1)
	e2, err := c.acquire(p2)
	if err != nil {
		t.Fatal(err)
	}
	defer c.release(e2)
	if len(c.items) != 1 {
		t.Fatalf("capacity exceeded: %d cached", len(c.items))
	}
	if _, ok := c.items[p1]; ok {
		t.Fatal("p1 should have been evicted")
	}
}

func TestV0953ZipCacheConcurrentAccessNoRace(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "comic.cbz")
	pages := make([]string, 40)
	for i := range pages {
		pages[i] = "p" + string(rune('0'+i/10)) + string(rune('0'+i%10)) + ".jpg"
	}
	writeTestZip(t, p, pages)

	c := newZipArchiveCache(8)
	var wg sync.WaitGroup
	for w := 0; w < 12; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				ent, err := c.acquire(p)
				if err != nil {
					t.Error(err)
					return
				}
				if len(ent.files) != 40 {
					t.Errorf("entries=%d", len(ent.files))
				}
				c.release(ent)
			}
		}()
	}
	wg.Wait()
	if len(c.orphans) != 0 {
		t.Fatalf("orphans left open: %d", len(c.orphans))
	}
}
