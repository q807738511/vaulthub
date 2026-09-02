package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// v0.9.30: reading progress must survive a browser change / cache clear, so it is
// persisted server-side behind the manager session, with the same media-path
// containment rules as playback.
func newProgressApp(t *testing.T) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Book.txt"), []byte("body"), 0644); err != nil {
		t.Fatal(err)
	}
	a := &App{
		libs:              []Library{{ID: "books", Name: "我的书房", Type: "book", Path: dir}},
		metadataOverrides: filepath.Join(t.TempDir(), "overrides.json"),
	}
	t.Setenv("MEDIA_READING_PROGRESS", filepath.Join(t.TempDir(), "reading.json"))
	return a, dir
}

func putProgress(t *testing.T, a *App, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPut, "/api/media/reading/progress?id=books&path="+path, bytes.NewBufferString(body))
	a.readingProgress(w, r)
	return w
}

func TestReadingProgressRoundTrip(t *testing.T) {
	withManagerSession(t)
	a, _ := newProgressApp(t)

	if w := putProgress(t, a, "Book.txt", `{"progress":42.5}`); w.Code != 200 {
		t.Fatalf("PUT want 200 got %d: %s", w.Code, w.Body.String())
	}

	w := httptest.NewRecorder()
	a.readingProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/reading/progress?id=books", nil))
	if w.Code != 200 {
		t.Fatalf("GET want 200 got %d: %s", w.Code, w.Body.String())
	}
	var out struct {
		ID    string                          `json:"id"`
		Items map[string]readingProgressEntry `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != "books" {
		t.Fatalf("library id mismatch: %+v", out)
	}
	entry, ok := out.Items["Book.txt"]
	if !ok {
		t.Fatalf("progress not persisted: %+v", out.Items)
	}
	if entry.Progress != 42.5 {
		t.Fatalf("progress want 42.5 got %v", entry.Progress)
	}
	if entry.UpdatedAt <= 0 {
		t.Fatalf("updated_at must be stamped: %+v", entry)
	}
}

func TestReadingProgressClampsAndRejectsBadInput(t *testing.T) {
	withManagerSession(t)
	a, _ := newProgressApp(t)

	for body, want := range map[string]float64{
		`{"progress":-20}`:  0,
		`{"progress":250}`:  100,
		`{"progress":99.9}`: 99.9,
	} {
		if w := putProgress(t, a, "Book.txt", body); w.Code != 200 {
			t.Fatalf("PUT %s want 200 got %d", body, w.Code)
		}
		var entry readingProgressEntry
		w := httptest.NewRecorder()
		a.readingProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/reading/progress?id=books", nil))
		var out struct {
			Items map[string]readingProgressEntry `json:"items"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		entry = out.Items["Book.txt"]
		if entry.Progress != want {
			t.Fatalf("%s want %v got %v", body, want, entry.Progress)
		}
	}

	if w := putProgress(t, a, "Book.txt", `{"progress":"x"}`); w.Code != 400 {
		t.Fatalf("non-numeric progress must be rejected, got %d", w.Code)
	}
	if w := putProgress(t, a, "../escape.txt", `{"progress":10}`); w.Code != 404 {
		t.Fatalf("path traversal must be rejected, got %d", w.Code)
	}
	w := httptest.NewRecorder()
	a.readingProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/reading/progress?id=nope", nil))
	if w.Code != 404 {
		t.Fatalf("unknown library must 404, got %d", w.Code)
	}
	w = httptest.NewRecorder()
	a.readingProgress(w, httptest.NewRequest(http.MethodDelete, "/api/media/reading/progress?id=books", nil))
	if w.Code != 405 {
		t.Fatalf("unsupported method must 405, got %d", w.Code)
	}
}

func TestReadingProgressRequiresSession(t *testing.T) {
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return false }
	t.Cleanup(func() { managerSessionOK = old })
	a, _ := newProgressApp(t)

	w := httptest.NewRecorder()
	a.readingProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/reading/progress?id=books", nil))
	if w.Code != 401 {
		t.Fatalf("GET without session must 401, got %d", w.Code)
	}
	if w := putProgress(t, a, "Book.txt", `{"progress":10}`); w.Code != 401 {
		t.Fatalf("PUT without session must 401, got %d", w.Code)
	}
}

func TestReadingProgressIsolatesLibraries(t *testing.T) {
	withManagerSession(t)
	a, _ := newProgressApp(t)
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "Comic.cbz"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	a.libs = append(a.libs, Library{ID: "comics", Name: "漫画", Type: "comic", Path: other})

	if w := putProgress(t, a, "Book.txt", `{"progress":11}`); w.Code != 200 {
		t.Fatalf("books PUT failed: %d", w.Code)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPut, "/api/media/reading/progress?id=comics&path=Comic.cbz", bytes.NewBufferString(`{"progress":77}`))
	a.readingProgress(w, r)
	if w.Code != 200 {
		t.Fatalf("comics PUT failed: %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	a.readingProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/reading/progress?id=comics", nil))
	var out struct {
		Items map[string]readingProgressEntry `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Items) != 1 {
		t.Fatalf("library scoping broken: %+v", out.Items)
	}
	if out.Items["Comic.cbz"].Progress != 77 {
		t.Fatalf("comics progress wrong: %+v", out.Items)
	}
}
