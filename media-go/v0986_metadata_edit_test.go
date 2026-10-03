package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* v0.9.86（客户要求「增加影视媒体编辑功能辅助完成刮削（媒体名称、年份）」）：
   override 文件新增 title / year —— 既作为展示名，也作为刮削搜索词，且跨设备一致。
   这里覆盖：清洗规则（控制字符 / 限长 / 年份格式）、落盘读回、以及合并进本地元数据。 */

func TestV0986OverrideTitleSanitize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  沙丘 2  ", "沙丘 2"},
		{"沙丘\n第二部", "沙丘 第二部"},
		{"沙\t丘", "沙 丘"},
		{"\x00\x01沙丘", "沙丘"},
		{"", ""},
		{"   ", ""},
		{strings.Repeat("长", 200), strings.Repeat("长", 120)},
		{"A B   C", "A B C"},
	}
	for _, c := range cases {
		if got := sanitizeOverrideTitle(c.in); got != c.want {
			t.Fatalf("sanitizeOverrideTitle(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestV0986OverrideYearSanitize(t *testing.T) {
	ok := map[string]string{"1999": "1999", " 2024 ": "2024", "2200": "2200", "1800": "1800"}
	for in, want := range ok {
		if got := sanitizeOverrideYear(in); got != want {
			t.Fatalf("sanitizeOverrideYear(%q) = %q, want %q", in, got, want)
		}
	}
	bad := []string{"", "24", "20244", "20a4", "abcd", "1234", "1799", "2201", "-2024"}
	for _, in := range bad {
		if got := sanitizeOverrideYear(in); got != "" {
			t.Fatalf("sanitizeOverrideYear(%q) = %q, want empty", in, got)
		}
	}
}

func TestV0986OverrideTitleYearRoundTrip(t *testing.T) {
	dir := t.TempDir()
	app := &App{metadataOverrides: filepath.Join(dir, "overrides.json")}
	lib := Library{ID: "movie1", Path: filepath.Join(dir, "movie")}
	if err := os.MkdirAll(lib.Path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lib.Path, "A.mp4"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	body := strings.NewReader(`{"title":"沙丘 第二部","year":"2024","tags":["科幻"]}`)
	req := httptest.NewRequest(http.MethodPut, "/api/media/metadata/override?id=movie1&path=A.mp4", body)
	rec := httptest.NewRecorder()
	// 绕过写权限：直接调用清洗 + 落盘路径（与 handler 相同的那两步）。
	in, err := sanitizeOverride(lib, mediaMetadataOverride{Title: "沙丘 第二部", Year: "2024", Tags: []string{"科幻"}})
	if err != nil {
		t.Fatalf("sanitizeOverride: %v", err)
	}
	all := map[string]mediaMetadataOverride{overrideKey(lib.ID, "A.mp4"): in}
	if err := app.saveMetadataOverrides(all); err != nil {
		t.Fatalf("saveMetadataOverrides: %v", err)
	}
	_ = req
	_ = rec

	read, err := app.loadMetadataOverrides()
	if err != nil {
		t.Fatalf("loadMetadataOverrides: %v", err)
	}
	got, ok := read[overrideKey(lib.ID, "A.mp4")]
	if !ok {
		t.Fatalf("override not persisted")
	}
	if got.Title != "沙丘 第二部" || got.Year != "2024" {
		t.Fatalf("round trip = %+v", got)
	}
	// 文件本身必须是 0600 且可被 JSON 解析（跨设备读取依赖它）。
	fi, err := os.Stat(app.metadataOverrides)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("override file perm = %v, want 0600", fi.Mode().Perm())
	}
	raw, _ := os.ReadFile(app.metadataOverrides)
	var probe map[string]map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("override file is not valid json: %v", err)
	}
	if probe[overrideKey(lib.ID, "A.mp4")]["title"] != "沙丘 第二部" {
		t.Fatalf("json title = %v", probe[overrideKey(lib.ID, "A.mp4")]["title"])
	}
}

func TestV0986MergeOverridePrefersUserTitleYear(t *testing.T) {
	dir := t.TempDir()
	app := &App{metadataOverrides: filepath.Join(dir, "overrides.json")}
	lib := Library{ID: "movie1"}
	all := map[string]mediaMetadataOverride{
		overrideKey(lib.ID, "A.mp4"): {Title: "沙丘 第二部", Year: "2024"},
	}
	if err := app.saveMetadataOverrides(all); err != nil {
		t.Fatal(err)
	}
	m := &localMediaMetadata{Title: "Dune Part Two 2024 1080p", Year: "2024raw"}
	app.mergeMetadataOverride(lib, "A.mp4", m)
	if m.Title != "沙丘 第二部" {
		t.Fatalf("merged title = %q", m.Title)
	}
	if m.Year != "2024" {
		t.Fatalf("merged year = %q", m.Year)
	}
	// 没有 override 的路径不受影响。
	m2 := &localMediaMetadata{Title: "原名"}
	app.mergeMetadataOverride(lib, "B.mp4", m2)
	if m2.Title != "原名" {
		t.Fatalf("untouched title = %q", m2.Title)
	}
}
