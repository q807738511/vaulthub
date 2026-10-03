package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

/* v0.9.88：刮削结果服务端持久化（影视 / 电子书）的契约与边界。 */

func newV0988App(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	for _, rel := range []string{"Narcos/Season 01/Narcos.S01E01.1080p.mkv", "Resume.Test.2019.1080p.mp4"} {
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cachePath := filepath.Join(root, "media-scrape-cache.json")
	a := &App{
		libs:            []Library{{ID: "movie1", Name: "电影", Type: "movie", Path: root}, {ID: "tv1", Name: "剧集", Type: "series", Path: root}},
		scrapeCachePath: cachePath,
	}
	return a, cachePath
}

func v0988Auth(t *testing.T, allow bool) {
	t.Helper()
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return allow }
	t.Cleanup(func() { managerSessionOK = old })
}

func v0988Post(t *testing.T, a *App, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodPost, "/api/media/scrape-cache", bytes.NewReader(raw)))
	return rec
}

func v0988Get(t *testing.T, a *App, query string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodGet, "/api/media/scrape-cache?"+query, nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func TestV0988ScrapeCacheRoundTripAndPermissions(t *testing.T) {
	a, cachePath := newV0988App(t)
	v0988Auth(t, true)

	rec := v0988Post(t, a, map[string]any{
		"id": "movie1",
		"items": map[string]any{
			"Resume.Test.2019.1080p.mp4": map[string]any{
				"title": "沙丘 第二部", "year": "2024", "overview": "简介",
				"poster": "https://image.tmdb.org/t/p/w342/x.jpg", "provider": "TMDB · 电影",
				"rating": 8.26, "tmdb_id": 693134, "media_type": "movie",
				"scrape_state": "ok", "checked_at": 5000,
			},
		},
	})
	if rec.Code != 200 {
		t.Fatalf("post=%d %s", rec.Code, rec.Body.String())
	}
	var posted map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &posted)
	if posted["stored"] != float64(1) {
		t.Fatalf("stored=%v", posted["stored"])
	}

	// 落盘权限必须是 0600（与 runtime / override 一致）。
	st, err := os.Stat(cachePath)
	if err != nil {
		t.Fatalf("cache file missing: %v", err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("cache mode=%v", st.Mode().Perm())
	}

	_, got := v0988Get(t, a, "id=movie1")
	if got["count"] != float64(1) {
		t.Fatalf("count=%v body=%v", got["count"], got)
	}
	items, _ := got["items"].(map[string]any)
	entry, _ := items["Resume.Test.2019.1080p.mp4"].(map[string]any)
	if entry["title"] != "沙丘 第二部" || entry["provider"] != "TMDB · 电影" {
		t.Fatalf("roundtrip lost fields: %v", entry)
	}
	if entry["rating"] != 8.3 { // 评分保留一位小数
		t.Fatalf("rating=%v", entry["rating"])
	}
	if entry["tmdb_id"] != float64(693134) {
		t.Fatalf("tmdb id lost: %v", entry)
	}

	// since 过滤：未来时间戳读不到任何条目。
	_, none := v0988Get(t, a, "id=movie1&since=9999999999999")
	if none["count"] != float64(0) {
		t.Fatalf("since filter failed: %v", none["count"])
	}
	// 未写入过的库读回空集合（而不是报错）。
	recEmpty, empty := v0988Get(t, a, "id=tv1")
	if recEmpty.Code != 200 || empty["count"] != float64(0) {
		t.Fatalf("empty lib: %d %v", recEmpty.Code, empty)
	}
}

func TestV0988ScrapeCacheMergePrefersNewerAndRejectsJunk(t *testing.T) {
	a, cachePath := newV0988App(t)
	v0988Auth(t, true)

	v0988Post(t, a, map[string]any{"id": "movie1", "items": map[string]any{
		"Resume.Test.2019.1080p.mp4": map[string]any{"title": "新结果", "checked_at": 20000},
	}})

	// 旧设备（更早的 checked_at）回传：不得覆盖新结果。
	rec := v0988Post(t, a, map[string]any{"id": "movie1", "items": map[string]any{
		"Resume.Test.2019.1080p.mp4": map[string]any{"title": "陈旧结果", "checked_at": 1000},
	}})
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["skipped"] != float64(1) || out["stored"] != float64(0) {
		t.Fatalf("stale result should be skipped: %v", out)
	}
	_, got := v0988Get(t, a, "id=movie1")
	items, _ := got["items"].(map[string]any)
	if items["Resume.Test.2019.1080p.mp4"].(map[string]any)["title"] != "新结果" {
		t.Fatal("stale overwrite happened")
	}

	// 合法垃圾：越界路径 / 绝对路径 / 非法图片地址一律拒收，且不影响已存条目。
	rec = v0988Post(t, a, map[string]any{"id": "movie1", "items": map[string]any{
		"../etc/passwd":                     map[string]any{"title": "escape", "checked_at": 30000},
		"/etc/passwd":                       map[string]any{"title": "absolute", "checked_at": 30000},
		"Resume.Test.2019.1080p.mp4.bad\\x": map[string]any{"title": "backslash", "checked_at": 30000},
		"Narcos/Season 01/Narcos.S01E01.1080p.mkv": map[string]any{
			"title": "剧集", "poster": "javascript:alert(1)", "checked_at": 30000,
		},
	}})
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["stored"] != float64(0) || out["skipped"] != float64(4) {
		t.Fatalf("junk should be rejected: %v", out)
	}
	raw, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("escape")) || bytes.Contains(raw, []byte("javascript")) {
		t.Fatalf("junk persisted: %s", raw)
	}

	// 手动编辑后重刮：replace=true 允许用更旧的 checked_at 覆盖（用户显式要求）。
	rec = v0988Post(t, a, map[string]any{"id": "movie1", "replace": true, "items": map[string]any{
		"Resume.Test.2019.1080p.mp4": map[string]any{"title": "手工改的名", "user_title": "手工改的名", "checked_at": 500},
	}})
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["stored"] != float64(1) {
		t.Fatalf("replace should store: %v", out)
	}
	_, got = v0988Get(t, a, "id=movie1")
	items, _ = got["items"].(map[string]any)
	if items["Resume.Test.2019.1080p.mp4"].(map[string]any)["user_title"] != "手工改的名" {
		t.Fatal("replace did not apply")
	}
}

func TestV0988ScrapeCacheAuthAndDelete(t *testing.T) {
	a, _ := newV0988App(t)
	v0988Auth(t, true)
	v0988Post(t, a, map[string]any{"id": "movie1", "items": map[string]any{
		"Resume.Test.2019.1080p.mp4": map[string]any{"title": "片", "checked_at": 100},
	}})

	// 未登录：读/写/删都必须 401。
	v0988Auth(t, false)
	if rec, _ := v0988Get(t, a, "id=movie1"); rec.Code != 401 {
		t.Fatalf("anon read=%d", rec.Code)
	}
	raw, _ := json.Marshal(map[string]any{"id": "movie1", "items": map[string]any{"a.mp4": map[string]any{"title": "x"}}})
	rec := httptest.NewRecorder()
	a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodPost, "/api/media/scrape-cache", bytes.NewReader(raw)))
	if rec.Code != 401 {
		t.Fatalf("anon write=%d", rec.Code)
	}
	rec = httptest.NewRecorder()
	a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodDelete, "/api/media/scrape-cache?id=movie1", nil))
	if rec.Code != 401 {
		t.Fatalf("anon delete=%d", rec.Code)
	}

	v0988Auth(t, true)
	// 不存在的媒体库：拒收（避免写入永不被读取的库 ID）。
	rec = v0988Post(t, a, map[string]any{"id": "nope", "items": map[string]any{
		"Resume.Test.2019.1080p.mp4": map[string]any{"title": "片"},
	}})
	if rec.Code != 404 {
		t.Fatalf("unknown lib=%d", rec.Code)
	}
	// 重新刮削：清空该库。
	rec = httptest.NewRecorder()
	a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodDelete, "/api/media/scrape-cache?id=movie1", nil))
	var cleared map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &cleared)
	if rec.Code != 200 || cleared["cleared"] != float64(1) {
		t.Fatalf("delete lib=%d %v", rec.Code, cleared)
	}
	if _, got := v0988Get(t, a, "id=movie1"); got["count"] != float64(0) {
		t.Fatalf("cache not cleared: %v", got["count"])
	}
}

func TestV0988ScrapeMinMatchConfig(t *testing.T) {
	if !validScrapeMinMatch(0.7) || !validScrapeMinMatch(scrapeMinMatchFloor) || !validScrapeMinMatch(1) {
		t.Fatal("valid thresholds rejected")
	}
	if validScrapeMinMatch(0.2) || validScrapeMinMatch(1.1) || validScrapeMinMatch(math.NaN()) {
		t.Fatal("invalid thresholds accepted")
	}
	if got := normalizeScrapeMinMatch(0.123); got != scrapeMinMatchFloor {
		t.Fatalf("floor clamp=%v", got)
	}
	if got := normalizeScrapeMinMatch(1.9); got != 1 {
		t.Fatalf("ceil clamp=%v", got)
	}
	if got := normalizeScrapeMinMatch(0.556); got != 0.56 {
		t.Fatalf("round=%v", got)
	}
	if got := normalizeScrapeMinMatch(0); got != defaultScrapeMinMatch {
		t.Fatalf("default=%v", got)
	}
	if got := envFloat("VAULTHUB_TEST_MIN_MATCH", 0.7); got != 0.7 {
		t.Fatalf("envFloat default=%v", got)
	}
	t.Setenv("VAULTHUB_TEST_MIN_MATCH", "65%")
	if got := envFloat("VAULTHUB_TEST_MIN_MATCH", 0.7); got != 0.65 {
		t.Fatalf("envFloat percent=%v", got)
	}

	root := t.TempDir()
	a := &App{runtimeConfig: filepath.Join(root, "media-runtime.json"), cacheDir: filepath.Join(root, "cache"), scrapeMinMatch: defaultScrapeMinMatch}
	base := RuntimeConfig{
		ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3", TMDBImageBase: "https://image.tmdb.org/t/p",
		TVDBAPIBase: "https://api4.thetvdb.com/v4", ScrapeRegion: "auto",
		CacheDir: a.cacheDir, CacheMaxAgeHours: 168, CacheCleanupIntervalHours: 24, ScrapeMinMatch: 0.1,
	}
	if err := a.saveRuntimeConfig(base); err == nil {
		t.Fatal("out-of-range threshold must be rejected")
	}
	base.ScrapeMinMatch = 0.8
	if err := a.saveRuntimeConfig(base); err != nil {
		t.Fatalf("save: %v", err)
	}
	snap := a.runtimeConfigSnapshot(false)
	if snap["scrape_min_match"] != 0.8 {
		t.Fatalf("snapshot=%v", snap["scrape_min_match"])
	}
	b, err := os.ReadFile(a.runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"scrape_min_match": 0.8`)) {
		t.Fatalf("runtime file missing threshold: %s", b)
	}
	// 0 = 表单未带值：沿用当前值而不是回到默认。
	base.ScrapeMinMatch = 0
	if err := a.saveRuntimeConfig(base); err != nil {
		t.Fatalf("save keep: %v", err)
	}
	if got := a.runtimeConfigSnapshot(false)["scrape_min_match"]; got != 0.8 {
		t.Fatalf("threshold not preserved on empty input: %v", got)
	}
}
