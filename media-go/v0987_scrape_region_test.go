package main

/* v0.9.87：刮削地区（中/日/美）单元测试。
   客户需求：「增加刮削地区配置(中/日/美)并在后续的信息刮削中进行同步
   （防止刮削后出现直接使用资源名称的情况）配置地区后同步关联到 TMDB 的刮削信息中」。
   覆盖：地区归一化 / 白名单校验 / 地区→TMDB language / 保存校验与持久化 /
   以及 tmdb 处理器的语言解析优先级（显式 lang > region 参数 > 已配置地区 > zh-CN）。 */

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestV0987NormalizeScrapeRegion(t *testing.T) {
	cases := map[string]string{
		"": "auto", "auto": "auto", "AUTO ": "auto", "unknown": "auto",
		"cn": "cn", "zh": "cn", "zh-CN": "cn", "China": "cn", "中国": "cn", "中國": "cn",
		"jp": "jp", "ja": "jp", "ja-JP": "jp", "Japan": "jp", "日本": "jp",
		"us": "us", "en": "us", "en-US": "us", "usa": "us", "美国": "us", "美國": "us",
	}
	for in, want := range cases {
		if got := normalizeScrapeRegion(in); got != want {
			t.Fatalf("normalizeScrapeRegion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestV0987ValidScrapeRegion(t *testing.T) {
	for _, ok := range []string{"auto", "cn", "jp", "us", "JP", "日本", ""} {
		if !validScrapeRegion(ok) {
			t.Fatalf("validScrapeRegion(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"de", "kr", "xx", "cnx"} {
		if validScrapeRegion(bad) {
			t.Fatalf("validScrapeRegion(%q) = true, want false", bad)
		}
	}
}

func TestV0987ScrapeRegionLanguage(t *testing.T) {
	cases := map[string]string{"cn": "zh-CN", "jp": "ja-JP", "us": "en-US", "auto": "", "": ""}
	for in, want := range cases {
		if got := scrapeRegionLanguage(in); got != want {
			t.Fatalf("scrapeRegionLanguage(%q) = %q, want %q", in, got, want)
		}
	}
}

/* 地区语言必须落在 tmdbLanguage 白名单内（否则 TMDB 会收到非法 language）。 */
func TestV0987RegionLanguagePassesTmdbWhitelist(t *testing.T) {
	for _, region := range []string{"cn", "jp", "us"} {
		lang := scrapeRegionLanguage(region)
		if lang == "" {
			t.Fatalf("region %s has no language", region)
		}
		if got := tmdbLanguage(lang); got != lang {
			t.Fatalf("tmdbLanguage(%q) = %q —— 白名单未放行该地区语言", lang, got)
		}
	}
}

func TestV0987TmdbLanguageAcceptsJapanese(t *testing.T) {
	for _, in := range []string{"ja", "ja-JP", "JA-JP", " ja "} {
		if got := tmdbLanguage(in); got != "ja-JP" {
			t.Fatalf("tmdbLanguage(%q) = %q, want ja-JP", in, got)
		}
	}
	/* 非法值仍回落 zh-CN（v0.9.85 行为保持）。 */
	for _, in := range []string{"de", "kr", "zh", ""} {
		if got := tmdbLanguage(in); got != "zh-CN" {
			t.Fatalf("tmdbLanguage(%q) = %q, want zh-CN", in, got)
		}
	}
}

func TestV0987RuntimeConfigPersistsScrapeRegion(t *testing.T) {
	d := t.TempDir()
	a := &App{runtimeConfig: filepath.Join(d, "runtime.json"), cacheDir: filepath.Join(d, "old"), cacheWake: make(chan struct{}, 1)}
	c := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3",
		TMDBImageBase: "https://image.tmdb.org/t/p", TVDBAPIBase: "https://api4.thetvdb.com/v4",
		ScrapeRegion: "日本", CacheDir: filepath.Join(d, "cache"), CacheMaxBytes: 1, CacheMaxAgeHours: 1, CacheCleanupIntervalHours: 1}
	if err := a.saveRuntimeConfig(c); err != nil {
		t.Fatal(err)
	}
	if a.scrapeRegion != "jp" {
		t.Fatalf("地区未生效：%q", a.scrapeRegion)
	}
	b, err := os.ReadFile(a.runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	var saved RuntimeConfig
	if json.Unmarshal(b, &saved) != nil || saved.ScrapeRegion != "jp" {
		t.Fatalf("地区未持久化：%s", b)
	}
	/* 空值保留原值（前端表单总带值，空值只能是老客户端）。 */
	if err := a.saveRuntimeConfig(RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3",
		TMDBImageBase: "https://image.tmdb.org/t/p", TVDBAPIBase: "https://api4.thetvdb.com/v4",
		CacheDir: filepath.Join(d, "cache"), CacheMaxBytes: 1, CacheMaxAgeHours: 1, CacheCleanupIntervalHours: 1}); err != nil {
		t.Fatal(err)
	}
	if a.scrapeRegion != "jp" {
		t.Fatalf("空值应保留原地区，实得 %q", a.scrapeRegion)
	}
}

func TestV0987RuntimeConfigRejectsInvalidScrapeRegion(t *testing.T) {
	d := t.TempDir()
	a := &App{runtimeConfig: filepath.Join(d, "runtime.json"), cacheDir: filepath.Join(d, "old"), cacheWake: make(chan struct{}, 1)}
	base := RuntimeConfig{ScraperMode: "auto", TMDBAPIBase: "https://api.themoviedb.org/3",
		TMDBImageBase: "https://image.tmdb.org/t/p", TVDBAPIBase: "https://api4.thetvdb.com/v4",
		CacheDir: filepath.Join(d, "cache"), CacheMaxBytes: 1, CacheMaxAgeHours: 1, CacheCleanupIntervalHours: 1}
	bad := base
	bad.ScrapeRegion = "de"
	if err := a.saveRuntimeConfig(bad); err == nil {
		t.Fatal("非法地区应被拒绝（否则用户以为切了地区而实际没生效）")
	}
}

/* 语言解析优先级：显式 lang > region 参数 > 已配置地区 > zh-CN。 */
func TestV0987TmdbLanguageResolutionOrder(t *testing.T) {
	a := &App{scrapeRegion: "jp"}
	resolve := func(lang, region string) string {
		out := ""
		if lang != "" {
			out = tmdbLanguage(lang)
		} else if region != "" {
			out = scrapeRegionLanguage(region)
		}
		if out == "" {
			a.mu.RLock()
			r := a.scrapeRegion
			a.mu.RUnlock()
			out = scrapeRegionLanguage(r)
		}
		if out == "" {
			out = "zh-CN"
		}
		return out
	}
	if got := resolve("en-US", ""); got != "en-US" {
		t.Fatalf("显式 lang 应最高优先：%q", got)
	}
	if got := resolve("", "us"); got != "en-US" {
		t.Fatalf("region 参数优先于已配置地区：%q", got)
	}
	if got := resolve("", ""); got != "ja-JP" {
		t.Fatalf("未指定时用已配置地区：%q", got)
	}
	a.scrapeRegion = "auto"
	if got := resolve("", ""); got != "zh-CN" {
		t.Fatalf("auto 应回落历史默认 zh-CN：%q", got)
	}
}

func TestV0987TmdbHandlerUsesConfiguredRegionSource(t *testing.T) {
	/* 处理器里必须读取已配置地区（而不是只认前端传参），否则「配置地区」在
	   没有 lang 参数的调用路径上会静默失效。 */
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	for _, needle := range []string{"region := a.scrapeRegion", "scrapeRegionLanguage(region)", "scrape_region"} {
		if !strings.Contains(text, needle) {
			t.Fatalf("main.go 缺少刮削地区落点：%s", needle)
		}
	}
}

/* 端到端（服务端）：真实调用 /api/media/tmdb 处理器，用 httptest 顶替 TMDB，
   断言上游请求 URL 里的 language 就是「刮削地区」对应的语言。 */
func TestV0987TmdbHandlerSendsRegionLanguage(t *testing.T) {
	var gotURL string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":1,"title":"ok"}`))
	}))
	defer stub.Close()

	oldSession, oldClient := managerSessionOK, outboundHTTPClient
	managerSessionOK = func(*http.Request) bool { return true }
	outboundHTTPClient = func(string) (*http.Client, error) { return stub.Client(), nil }
	defer func() { managerSessionOK, outboundHTTPClient = oldSession, oldClient }()

	call := func(a *App, query string) string {
		gotURL = ""
		rr := httptest.NewRecorder()
		a.tmdb(rr, httptest.NewRequest(http.MethodGet, "/api/media/tmdb?"+query, nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
		}
		return gotURL
	}

	a := &App{tmdbAPIKey: strings.Repeat("a", 32), tmdbAPIBase: stub.URL, scrapeRegion: "jp"}
	if u := call(a, "query=Narcos&type=series"); !strings.Contains(u, "language=ja-JP") {
		t.Fatalf("地区=日本 未同步到 TMDB 请求：%s", u)
	}
	/* 前端显式带 lang 时以它为准（详情页/演职人员等按界面语言的旧路径保持可用）。 */
	if u := call(a, "query=Narcos&type=series&lang=en-US"); !strings.Contains(u, "language=en-US") {
		t.Fatalf("显式 lang 未生效：%s", u)
	}
	/* region 参数可临时覆盖已配置地区。 */
	if u := call(a, "query=Narcos&type=series&region=us"); !strings.Contains(u, "language=en-US") {
		t.Fatalf("region 参数未生效：%s", u)
	}
	a.scrapeRegion = "cn"
	if u := call(a, "query=Narcos&type=series"); !strings.Contains(u, "language=zh-CN") {
		t.Fatalf("地区=中国 未同步：%s", u)
	}
	a.scrapeRegion = "auto"
	if u := call(a, "query=Narcos&type=series"); !strings.Contains(u, "language=zh-CN") {
		t.Fatalf("地区=auto 应回落 zh-CN：%s", u)
	}
	/* 快照必须同时下发地区与其语言（前端直接读用）。 */
	a.scrapeRegion = "us"
	snap := a.runtimeConfigSnapshot(false)
	if snap["scrape_region"] != "us" || snap["scrape_region_lang"] != "en-US" {
		t.Fatalf("快照未下发地区/语言：%v / %v", snap["scrape_region"], snap["scrape_region_lang"])
	}
}
