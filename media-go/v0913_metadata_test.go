package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withManagerSession(t *testing.T) {
	t.Helper()
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	t.Cleanup(func() { managerSessionOK = old })
}

func TestV0913ArtworkRolesAndStemPriority(t *testing.T) {
	d := t.TempDir()
	for _, name := range []string{"Film.mkv", "Film-poster.jpg", "poster.jpg", "Film-logo.png", "logo.png", "Film-fanart.jpg", "fanart.jpg", "Film-backdrop.jpg", "backdrop.jpg"} {
		if err := os.WriteFile(filepath.Join(d, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := readLocalMediaMetadata(Library{ID: "movie", Type: "movie", Path: d}, "Film.mkv")
	if err != nil {
		t.Fatal(err)
	}
	for field, value := range map[string]string{"poster": got.Poster, "logo": got.Logo, "fanart": got.Fanart, "backdrop": got.Backdrop} {
		if !strings.Contains(value, "Film-"+field) {
			t.Fatalf("%s role selected wrong file: %+v", field, got)
		}
	}
}

func TestV0913CommonArtworkRolesForSingleVideoDirectory(t *testing.T) {
	d := t.TempDir()
	for _, name := range []string{"Film.mkv", "poster.jpg", "logo.png", "fanart.jpg", "backdrop.jpg"} {
		os.WriteFile(filepath.Join(d, name), []byte(name), 0644)
	}
	got, err := readLocalMediaMetadata(Library{ID: "movie", Type: "movie", Path: d}, "Film.mkv")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.Poster, "poster.jpg") || !strings.Contains(got.Logo, "logo.png") || !strings.Contains(got.Fanart, "fanart.jpg") || !strings.Contains(got.Backdrop, "backdrop.jpg") {
		t.Fatalf("roles=%+v", got)
	}
}

func TestV0913MetadataOverridePersistsAndMerges(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "Film.mkv"), []byte("v"), 0644)
	os.WriteFile(filepath.Join(d, "custom-logo.png"), []byte("png"), 0644)
	a := &App{libs: []Library{{ID: "movie", Type: "movie", Path: d}}, metadataOverrides: filepath.Join(t.TempDir(), "overrides.json")}
	withManagerSession(t)
	body := `{"poster":"https://images.example/poster.jpg","logo":"/api/media/file?id=movie&path=custom-logo.png","fanart":"https://images.example/fanart.jpg","backdrop":"https://images.example/backdrop.jpg","tags":["科幻","收藏"],"watched":true}`
	w := httptest.NewRecorder()
	a.metadataOverride(w, httptest.NewRequest(http.MethodPut, "/api/media/metadata/override?id=movie&path=Film.mkv", bytes.NewBufferString(body)))
	if w.Code != 200 {
		t.Fatalf("put=%d %s", w.Code, w.Body.String())
	}
	b, err := os.ReadFile(a.metadataOverrides)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "images.example/poster.jpg") {
		t.Fatalf("not persisted: %s", b)
	}
	w = httptest.NewRecorder()
	a.localMetadata(w, httptest.NewRequest(http.MethodGet, "/api/media/metadata?id=movie&path=Film.mkv", nil))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var got localMediaMetadata
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Watched || got.Logo == "" || got.Fanart == "" || got.Backdrop == "" || len(got.Tags) != 2 {
		t.Fatalf("merge=%+v", got)
	}
}

func TestV0913OverrideRejectsUnsafeURLAndNeedsSession(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "Film.mkv"), []byte("v"), 0644)
	a := &App{libs: []Library{{ID: "movie", Type: "movie", Path: d}}, metadataOverrides: filepath.Join(t.TempDir(), "overrides.json")}
	old := managerSessionOK
	defer func() { managerSessionOK = old }()
	managerSessionOK = func(*http.Request) bool { return false }
	w := httptest.NewRecorder()
	a.metadataOverride(w, httptest.NewRequest(http.MethodPut, "/api/media/metadata/override?id=movie&path=Film.mkv", bytes.NewBufferString(`{"poster":"https://ok.example/a.jpg"}`)))
	if w.Code != 401 {
		t.Fatalf("anonymous=%d", w.Code)
	}
	managerSessionOK = func(*http.Request) bool { return true }
	for _, bad := range []string{"javascript:alert(1)", "data:image/svg+xml,x", "file:///etc/passwd", "https://user:pass@example/a.jpg"} {
		w = httptest.NewRecorder()
		a.metadataOverride(w, httptest.NewRequest(http.MethodPut, "/api/media/metadata/override?id=movie&path=Film.mkv", bytes.NewBufferString(`{"poster":"`+bad+`"}`)))
		if w.Code != 400 {
			t.Fatalf("accepted %q: %d %s", bad, w.Code, w.Body.String())
		}
	}
}

func TestV0913ArtworkCandidatesOnlyFromMediaDirectory(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "Film.mkv"), []byte("v"), 0644)
	os.WriteFile(filepath.Join(d, "poster.jpg"), []byte("p"), 0644)
	os.WriteFile(filepath.Join(d, "note.txt"), []byte("x"), 0644)
	a := &App{libs: []Library{{ID: "movie", Type: "movie", Path: d}}}
	withManagerSession(t)
	w := httptest.NewRecorder()
	a.artworkCandidates(w, httptest.NewRequest(http.MethodGet, "/api/media/metadata/artwork?id=movie&path=Film.mkv", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "poster.jpg") || strings.Contains(w.Body.String(), "note.txt") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}
