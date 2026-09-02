package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// filesQuery drives GET /api/media/files with an arbitrary query string and
// decodes the JSON payload the frontend consumes.
func filesQuery(t *testing.T, a *App, query string) map[string]any {
	t.Helper()
	rr := httptest.NewRecorder()
	a.files(rr, httptest.NewRequest(http.MethodGet, "/api/media/files?"+query, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v body=%s", err, rr.Body.String())
	}
	return out
}

func filePaths(t *testing.T, payload map[string]any) []string {
	t.Helper()
	raw, _ := payload["files"].([]any)
	paths := make([]string, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("unexpected file entry %#v", item)
		}
		paths = append(paths, m["path"].(string))
	}
	return paths
}

// v0.9.17: the 媒体搜索 page queries the index directly through ?q=, so the
// backend must filter case-insensitively and treat LIKE metacharacters as
// literals instead of wildcards.
func TestFilesQueryFiltersByKeyword(t *testing.T) {
	a := testApp(t)
	dir := t.TempDir()
	names := []string{
		"Interstellar.2014.1080p.mkv",
		"interstellar.behind.the.scenes.mp4",
		"Dune.Part.Two.2024.mkv",
		"100%.Wolf.2020.mkv",
		"a_b.special.mkv",
		"axb.other.mkv",
	}
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("v"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	lib := Library{ID: "films", Name: "我的电影库", Type: "movie", Path: dir}
	if rr := postLibrary(t, a, lib); rr.Code != http.StatusCreated {
		t.Fatalf("create library: %d %s", rr.Code, rr.Body.String())
	}
	waitIdle(t, a, lib.ID)

	all := filesQuery(t, a, "id=films&limit=500")
	if got := int(all["total"].(float64)); got != len(names) {
		t.Fatalf("unfiltered total=%d want %d", got, len(names))
	}

	// Case-insensitive substring match across both casings.
	hit := filesQuery(t, a, "id=films&q=INTERSTELLAR&limit=500")
	if got := int(hit["total"].(float64)); got != 2 {
		t.Fatalf("keyword total=%d want 2 (%v)", got, filePaths(t, hit))
	}
	if hit["query"] != "INTERSTELLAR" {
		t.Fatalf("query echo=%v", hit["query"])
	}
	if hit["has_more"] != false {
		t.Fatalf("has_more=%v want false", hit["has_more"])
	}
	for _, p := range filePaths(t, hit) {
		if p != "Interstellar.2014.1080p.mkv" && p != "interstellar.behind.the.scenes.mp4" {
			t.Fatalf("unexpected hit %q", p)
		}
	}

	// A miss must report zero rather than falling back to the full listing.
	miss := filesQuery(t, a, "id=films&q=nosuchtitle&limit=500")
	if got := int(miss["total"].(float64)); got != 0 {
		t.Fatalf("miss total=%d want 0 (%v)", got, filePaths(t, miss))
	}
	if len(filePaths(t, miss)) != 0 {
		t.Fatalf("miss returned files: %v", filePaths(t, miss))
	}

	// "%" must match the literal character, not every row.
	percent := filesQuery(t, a, "id=films&q=100%25&limit=500")
	if got := filePaths(t, percent); len(got) != 1 || got[0] != "100%.Wolf.2020.mkv" {
		t.Fatalf("percent search=%v", got)
	}

	// "_" must match the literal underscore, not any single character.
	under := filesQuery(t, a, "id=films&q=a_b&limit=500")
	if got := filePaths(t, under); len(got) != 1 || got[0] != "a_b.special.mkv" {
		t.Fatalf("underscore search=%v", got)
	}
}

// Pagination must stay consistent while filtering so the UI can page results.
func TestFilesQueryPaginates(t *testing.T) {
	a := testApp(t)
	dir := t.TempDir()
	for _, n := range []string{"show.s01e01.mkv", "show.s01e02.mkv", "show.s01e03.mkv", "other.mkv"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("v"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	lib := Library{ID: "tv", Name: "剧集库", Type: "series", Path: dir}
	if rr := postLibrary(t, a, lib); rr.Code != http.StatusCreated {
		t.Fatalf("create library: %d %s", rr.Code, rr.Body.String())
	}
	waitIdle(t, a, lib.ID)

	first := filesQuery(t, a, "id=tv&q=show&limit=2")
	if got := int(first["total"].(float64)); got != 3 {
		t.Fatalf("total=%d want 3", got)
	}
	if first["has_more"] != true {
		t.Fatalf("has_more=%v want true", first["has_more"])
	}
	if got := filePaths(t, first); len(got) != 2 {
		t.Fatalf("page1=%v", got)
	}
	second := filesQuery(t, a, "id=tv&q=show&limit=2&offset=2")
	if second["has_more"] != false {
		t.Fatalf("page2 has_more=%v want false", second["has_more"])
	}
	if got := filePaths(t, second); len(got) != 1 || got[0] != "show.s01e03.mkv" {
		t.Fatalf("page2=%v", got)
	}
}

func TestSQLiteLikeEscape(t *testing.T) {
	cases := map[string]string{
		`plain`:   `plain`,
		`100%`:    `100\%`,
		`a_b`:     `a\_b`,
		`back\sl`: `back\\sl`,
	}
	for in, want := range cases {
		if got := sqliteLikeEscape(in); got != want {
			t.Fatalf("sqliteLikeEscape(%q)=%q want %q", in, got, want)
		}
	}
}
