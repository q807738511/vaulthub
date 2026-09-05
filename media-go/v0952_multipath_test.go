package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v0.9.52 多存储路径契约：
//  1. 单路径库（Paths 为空）的 rel 不带前缀 —— 存量库行为不变；
//  2. 多路径库（Paths 非空）每个 root 的条目带 <root-base>/ 前缀，避免
//     (lib,path) 主键冲突；
//  3. safeFile 能按前缀把索引路径解析回真实文件，且多路径各自保持
//     v0.9.30 的边界安全（库根 / MEDIA_ROOT）。
func TestMultiPathLibraryScansAndServes(t *testing.T) {
	base := t.TempDir()
	mediaRoot := filepath.Join(base, "media")
	rootA := filepath.Join(mediaRoot, "music-a")
	rootB := filepath.Join(mediaRoot, "music-b")
	// 两个 root 里故意放同名文件，验证前缀消歧后都能独立取回。
	mustWrite(t, filepath.Join(rootA, "Artist", "same.mp3"))
	mustWrite(t, filepath.Join(rootB, "Artist", "same.mp3"))
	mustWrite(t, filepath.Join(rootA, "only-a.flac"))
	mustWrite(t, filepath.Join(rootB, "only-b.flac"))
	setMediaRoot(t, mediaRoot)

	a := testApp(t)
	lib := Library{ID: "lib-multi", Name: "多路径音乐库", Type: "audio", Path: rootA, Paths: []string{rootB}}
	if rr := postLibrary(t, a, lib); rr.Code != http.StatusCreated {
		t.Fatalf("create library: %d %s", rr.Code, rr.Body.String())
	}
	waitIdle(t, a, lib.ID)

	payload := filesQuery(t, a, "id=lib-multi&limit=500")
	paths := filePaths(t, payload)
	got := map[string]bool{}
	for _, p := range paths {
		got[p] = true
	}
	want := map[string]bool{
		filepath.Join(filepath.Base(rootA), "Artist", "same.mp3"): true,
		filepath.Join(filepath.Base(rootB), "Artist", "same.mp3"): true,
		filepath.Join(filepath.Base(rootA), "only-a.flac"):        true,
		filepath.Join(filepath.Base(rootB), "only-b.flac"):        true,
	}
	if len(paths) != len(want) {
		t.Fatalf("indexed %d entries want %d: %v", len(paths), len(want), paths)
	}
	for rel := range want {
		if !got[rel] {
			t.Fatalf("missing indexed entry %q (got %v)", rel, paths)
		}
		if _, _, err := safeFile(lib, rel); err != nil {
			t.Fatalf("indexed entry %q must be servable: %v", rel, err)
		}
	}
}

// 单路径库 rel 仍不带前缀 —— v0.9.52 之前所有存量库与请求契约不变。
func TestSinglePathLibraryKeepsUnprefixedPaths(t *testing.T) {
	// v0.9.55：files 读取端点需登录会话，测试里 stub manager 会话校验。
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	base := t.TempDir()
	mediaRoot := filepath.Join(base, "media")
	root := filepath.Join(mediaRoot, "films")
	mustWrite(t, filepath.Join(root, "Show", "S01E01.mkv"))
	mustWrite(t, filepath.Join(root, "Show", "S01E02.mkv"))
	setMediaRoot(t, mediaRoot)

	a := testApp(t)
	lib := Library{ID: "lib-single", Name: "单路径库", Type: "series", Path: root}
	if rr := postLibrary(t, a, lib); rr.Code != http.StatusCreated {
		t.Fatalf("create library: %d %s", rr.Code, rr.Body.String())
	}
	waitIdle(t, a, lib.ID)

	paths := filePaths(t, filesQuery(t, a, "id=lib-single&limit=500"))
	want := []string{"Show/S01E01.mkv", "Show/S01E02.mkv"}
	if len(paths) != 2 {
		t.Fatalf("got %v", paths)
	}
	for i, p := range paths {
		if p != want[i] {
			t.Fatalf("path[%d]=%q want %q (no prefix for single-path lib)", i, p, want[i])
		}
	}
}

// POST 重复提交同一 ID 且仅扩展路径集合变化 → 200 且配置被更新。
func TestLibraryPostUpdatesExtraPaths(t *testing.T) {
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	base := t.TempDir()
	mediaRoot := filepath.Join(base, "media")
	rootA := filepath.Join(mediaRoot, "a")
	rootB := filepath.Join(mediaRoot, "b")
	rootC := filepath.Join(mediaRoot, "c")
	for _, d := range []string{rootA, rootB, rootC} {
		mustWrite(t, filepath.Join(d, "x.mkv"))
	}
	setMediaRoot(t, mediaRoot)

	a := testApp(t)
	lib := Library{ID: "lib-dup", Name: "扩展库", Type: "movie", Path: rootA}
	if rr := postLibrary(t, a, lib); rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body.String())
	}
	waitIdle(t, a, lib.ID)

	// 追加一个扩展路径后再次提交同一 ID。
	lib2 := lib
	lib2.Paths = []string{rootB, rootC}
	rr := httptest.NewRecorder()
	a.libraries(rr, httptest.NewRequest(http.MethodPost, "/api/media/libraries", jsonBody(t, lib2)))
	if rr.Code != http.StatusOK {
		t.Fatalf("repost: %d %s", rr.Code, rr.Body.String())
	}
	got, ok := a.find("lib-dup")
	if !ok {
		t.Fatal("library missing")
	}
	if len(got.Paths) != 2 || got.Paths[0] != rootB || got.Paths[1] != rootC {
		t.Fatalf("paths not updated: %v", got.Paths)
	}
	waitIdle(t, a, lib.ID)
	// 两个扩展 root 的条目都应出现（带各自 root 名前缀）。
	paths := filePaths(t, filesQuery(t, a, "id=lib-dup&limit=500"))
	seen := map[string]bool{}
	for _, p := range paths {
		seen[p] = true
	}
	for _, want := range []string{
		filepath.Join(filepath.Base(rootB), "x.mkv"),
		filepath.Join(filepath.Base(rootC), "x.mkv"),
	} {
		if !seen[want] {
			t.Fatalf("missing %q in %v", want, paths)
		}
	}
}

func jsonBody(t *testing.T, v any) *os.File {
	t.Helper()
	f, err := os.CreateTemp("", "vh-lib-*.json")
	if err != nil {
		t.Fatal(err)
	}
	enc := json.NewEncoder(f)
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	return f
}

// v0.9.52 T4：series 单集位于 Show/Season 01/ 下时，本地元数据必须向上回溯
// 到剧集根目录读取海报（poster.jpg/folder.jpg），并映射成可服务的索引 URL。
func TestSeriesMetadataFallsBackToShowRootPoster(t *testing.T) {
	base := t.TempDir()
	mediaRoot := filepath.Join(base, "media")
	root := filepath.Join(mediaRoot, "tv")
	epDir := filepath.Join(root, "Show", "Season 01")
	mustWrite(t, filepath.Join(epDir, "S01E01.mkv"))
	mustWrite(t, filepath.Join(root, "Show", "poster.jpg"))
	setMediaRoot(t, mediaRoot)

	a := testApp(t)
	lib := Library{ID: "lib-tv", Name: "剧集库", Type: "series", Path: root}
	if rr := postLibrary(t, a, lib); rr.Code != http.StatusCreated {
		t.Fatalf("create library: %d %s", rr.Code, rr.Body.String())
	}
	waitIdle(t, a, lib.ID)

	m, err := readLocalMediaMetadata(lib, "Show/Season 01/S01E01.mkv")
	if err != nil {
		t.Fatalf("read metadata: %v", err)
	}
	if m.Poster == "" {
		t.Fatal("series episode must inherit show-root poster")
	}
	// Poster URL 必须能被 safeFile 解析回真实文件（可播放/可显示）。
	u := strings.TrimPrefix(m.Poster, "/api/media/file?")
	parts := map[string]string{}
	for _, kv := range strings.Split(u, "&") {
		kv2 := strings.SplitN(kv, "=", 2)
		if len(kv2) == 2 {
			parts[kv2[0]], _ = url.QueryUnescape(kv2[1])
		}
	}
	if _, _, err := safeFile(lib, parts["path"]); err != nil {
		t.Fatalf("poster url path must be servable: %q err=%v", parts["path"], err)
	}
}
