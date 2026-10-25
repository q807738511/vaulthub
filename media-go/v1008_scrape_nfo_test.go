package main

import (
	"encoding/json"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* v1.0.8（需求7）：刮削结果落媒体同目录。
 *
 * 旧实现 NFO 只在「浏览器翻到该条目」时由前端触发写入；整库刮完但没人翻过的条目
 * 永远没有产物。本版把写盘挪到服务端：scrape-cache 落库后直接写 NFO。
 *
 * 这里覆盖四条硬边界：
 *   1. 影视库写 <文件名>.nfo，剧集另写 show 根 tvshow.nfo；
 *   2. 非影视库（音乐/书刊）不写；
 *   3. 已存在的他人 NFO 不覆盖（kept 计数）；
 *   4. 刮削未成功（state != ok）的条目不写。
 */

func newV1008ScrapeApp(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	for _, rel := range []string{
		"水男孩/水男孩.2021.1080p.mkv",
		"某剧/Season 01/某剧.S01E01.mkv",
	} {
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a := &App{
		libs: []Library{
			{ID: "movie1", Name: "电影", Type: "movie", Path: root},
			{ID: "tv1", Name: "剧集", Type: "series", Path: root},
			{ID: "audio1", Name: "音乐", Type: "audio", Path: root},
		},
		scrapeCachePath: filepath.Join(root, "media-scrape-cache.json"),
	}
	return a, root
}

func TestV1008PersistScrapeNFOWritesBesideMedia(t *testing.T) {
	a, root := newV1008ScrapeApp(t)
	items := map[string]scrapeCacheItem{
		"水男孩/水男孩.2021.1080p.mkv": {
			Title: "五个扑水的少年", Year: "2021", Overview: "剧情简介", Rating: 7.4,
			State: "ok", Kind: "movie", CheckedAt: 1,
		},
	}
	written, _ := a.persistScrapeNFO("movie1", items)
	if written == 0 {
		t.Fatalf("期望写入 NFO，实际 written=0")
	}
	nfo := filepath.Join(root, "水男孩", "水男孩.2021.1080p.nfo")
	raw, err := os.ReadFile(nfo)
	if err != nil {
		t.Fatalf("NFO 未写到媒体同目录: %v", err)
	}
	if !strings.Contains(string(raw), "五个扑水的少年") || !strings.Contains(string(raw), "VaultHub") {
		t.Fatalf("NFO 内容异常: %s", string(raw))
	}
	/* 目录里只有一个媒体文件 → 允许写 movie.nfo（其它刮削器通用名）。 */
	if _, err := os.Stat(filepath.Join(root, "水男孩", "movie.nfo")); err != nil {
		t.Fatalf("单文件目录应写 movie.nfo: %v", err)
	}
}

func TestV1008PersistScrapeNFOSeriesWritesShowRoot(t *testing.T) {
	a, root := newV1008ScrapeApp(t)
	items := map[string]scrapeCacheItem{
		"某剧/Season 01/某剧.S01E01.mkv": {
			Title: "第一集", ShowTitle: "某剧", Year: "2024", State: "ok", Kind: "series",
		},
	}
	if written, _ := a.persistScrapeNFO("tv1", items); written == 0 {
		t.Fatalf("剧集应写入 NFO")
	}
	if _, err := os.Stat(filepath.Join(root, "某剧", "tvshow.nfo")); err != nil {
		t.Fatalf("剧集应在 show 根写 tvshow.nfo: %v", err)
	}
}

func TestV1008PersistScrapeNFOKeepsForeignNFO(t *testing.T) {
	a, root := newV1008ScrapeApp(t)
	dir := filepath.Join(root, "水男孩")
	foreign := "<?xml version=\"1.0\"?><movie><title>用户手写</title></movie>"
	if err := os.WriteFile(filepath.Join(dir, "水男孩.2021.1080p.nfo"), []byte(foreign), 0o644); err != nil {
		t.Fatal(err)
	}
	items := map[string]scrapeCacheItem{
		"水男孩/水男孩.2021.1080p.mkv": {Title: "五个扑水的少年", State: "ok"},
	}
	/* 同名的 <文件名>.nfo 是他人手写的 → 必须 kept；movie.nfo 是另一个目标文件，
	   写它不影响用户原文件（读取端优先读 <文件名>.nfo）。 */
	_, kept := a.persistScrapeNFO("movie1", items)
	if kept == 0 {
		t.Fatalf("已有他人 NFO 时必须记为 kept，实际 kept=0")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "水男孩.2021.1080p.nfo"))
	if string(raw) != foreign {
		t.Fatalf("他人 NFO 被覆盖了: %s", string(raw))
	}
}

func TestV1008PersistScrapeNFOSkipsNonVideoAndFailed(t *testing.T) {
	a, root := newV1008ScrapeApp(t)
	if w, _ := a.persistScrapeNFO("audio1", map[string]scrapeCacheItem{
		"水男孩/水男孩.2021.1080p.mkv": {Title: "歌名", State: "ok"},
	}); w != 0 {
		t.Fatalf("音乐库不应写 NFO（走 vaulthub.json 通道）")
	}
	if w, _ := a.persistScrapeNFO("movie1", map[string]scrapeCacheItem{
		"水男孩/水男孩.2021.1080p.mkv": {Title: "五个扑水的少年", State: "failed"},
	}); w != 0 {
		t.Fatalf("未成功的刮削不应写 NFO")
	}
	if _, err := os.Stat(filepath.Join(root, "水男孩", "水男孩.2021.1080p.nfo")); err == nil {
		t.Fatalf("不该产生 NFO")
	}
}

func TestV1008ScrapeCachePostReportsNFO(t *testing.T) {
	a, root := newV1008ScrapeApp(t)
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	t.Cleanup(func() { managerSessionOK = old })
	body := map[string]any{
		"id": "movie1",
		"items": map[string]any{
			"水男孩/水男孩.2021.1080p.mkv": map[string]any{
				"title": "五个扑水的少年", "year": "2021", "scrape_state": "ok", "checked_at": 1,
			},
		},
	}
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodPost, "/api/media/scrape-cache", bytes.NewReader(raw)))
	if rec.Code != 200 {
		t.Fatalf("期望 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if _, ok := out["nfo_written"]; !ok {
		t.Fatalf("响应应回显 nfo_written: %s", rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "水男孩", "水男孩.2021.1080p.nfo")); err != nil {
		t.Fatalf("POST 之后媒体目录应有 NFO: %v", err)
	}
}
