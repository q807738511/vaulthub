package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* v0.9.77 服务端契约：
   1) TMDB v4 Read Access Token（JWT）必须走 Authorization: Bearer —— 这是
      「TMDB 评分/影视推荐不生效」的根因（此前一律拼 ?api_key=，TMDB 回 401 invalid key）；
   2) 测速辅助的视频自动画质限高；
   3) PDF 漫画服务端翻页（pdftoppm）与页边界校验。 */

func TestV0977TMDBBearerDetection(t *testing.T) {
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc123"
	if !tmdbIsBearerToken(jwt) {
		t.Fatal("v4 JWT token must be detected as bearer")
	}
	if tmdbIsBearerToken("0123456789abcdef0123456789abcdef") {
		t.Fatal("v3 32-hex api key must NOT be treated as bearer")
	}
	if tmdbIsBearerToken("") || tmdbIsBearerToken("eyJonly") {
		t.Fatal("empty / malformed keys must not be bearer")
	}
}

func TestV0977AutoQualityCap(t *testing.T) {
	cases := []struct {
		bps  int64
		want int
	}{
		{0, 0}, {500_000, 480}, {1_999_999, 480}, {2_000_000, 720},
		{5_999_999, 720}, {6_000_000, 1080}, {15_999_999, 1080}, {16_000_000, 0}, {100_000_000, 0},
	}
	for _, c := range cases {
		if got := autoQualityCapForBandwidth(c.bps); got != c.want {
			t.Fatalf("cap(%d)=%d want %d", c.bps, got, c.want)
		}
	}
}

func TestV0977ApplyNetworkCap(t *testing.T) {
	m := playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "aac", Width: 3840, Height: 2160}
	plan := playbackPlan{Media: m, Mode: "direct", MaxHeight: 0}
	if got := applyNetworkCap(plan, "auto", 3_000_000); got.MaxHeight != 720 || got.Mode != "full_transcode" {
		t.Fatalf("3Mbps auto should cap to 720p, got height=%d mode=%s", got.MaxHeight, got.Mode)
	}
	if got := applyNetworkCap(plan, "1080p", 3_000_000); got.MaxHeight != 0 {
		t.Fatal("explicit quality must never be overridden by the speed test")
	}
	if got := applyNetworkCap(plan, "auto", 50_000_000); got.MaxHeight != 0 {
		t.Fatal("fast link must leave the plan untouched")
	}
	if got := applyNetworkCap(plan, "auto", 0); got.MaxHeight != 0 {
		t.Fatal("no measurement must leave the plan untouched")
	}
	small := playbackPlan{Media: playbackMedia{Height: 480}}
	if got := applyNetworkCap(small, "auto", 1_000_000); got.MaxHeight != 0 {
		t.Fatal("source already under the cap must not be transcoded")
	}
	// 已有更严格的用户上限时不得放宽
	capped := playbackPlan{Media: m, MaxHeight: 480}
	if got := applyNetworkCap(capped, "auto", 3_000_000); got.MaxHeight != 480 {
		t.Fatalf("existing tighter cap must win, got %d", got.MaxHeight)
	}
}

const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

// stubPoppler 造一对 pdfinfo/pdftoppm 桩脚本：pdfinfo 报 3 页，pdftoppm 落一个 PNG。
func stubPoppler(t *testing.T, dir string) (infoPath, renderPath string) {
	t.Helper()
	infoPath = filepath.Join(dir, "pdfinfo")
	renderPath = filepath.Join(dir, "pdftoppm")
	png := filepath.Join(dir, "tiny.png")
	raw, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(png, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(infoPath, []byte("#!/bin/sh\necho 'Pages:          3'\necho 'Encrypted:      no'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	// 桩：把预置 PNG 复制成 <prefix>-1.png，模拟 pdftoppm 单页输出。
	script := "#!/bin/sh\nprefix=\"\"\nfor a in \"$@\"; do prefix=\"$a\"; done\ncp \"" + png + "\" \"$prefix-1.png\"\n"
	if err := os.WriteFile(renderPath, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	return infoPath, renderPath
}

func withStubPoppler(t *testing.T, dir string) {
	t.Helper()
	info, render := stubPoppler(t, dir)
	pdfToolMu.Lock()
	pdfInfoOverride, pdfToolOverride = info, render
	pdfToolMu.Unlock()
	t.Cleanup(func() {
		pdfToolMu.Lock()
		pdfInfoOverride, pdfToolOverride = "", ""
		pdfToolMu.Unlock()
	})
}

func newPDFTestApp(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "MH")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	pdfPath := filepath.Join(dir, "comic.pdf")
	if err := os.WriteFile(pdfPath, []byte("%PDF-1.4 stub\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &App{
		libs:              []Library{{ID: "comic-1", Name: "漫画", Type: "comic", Path: dir}},
		cacheDir:          t.TempDir(),
		cacheMaxBytes:     8 << 20,
		pageCacheDir:      t.TempDir(),
		pageCacheMaxBytes: 8 << 20,
	}
	a.pageCache = newPageCache(a.pageCacheDir, a.pageCacheMaxBytes)
	return a, pdfPath
}

// allowAllReadAuth 让 readAuth 系列端点在本测试里通过（与既有测试同一手法：
// managerSessionOK 是包级变量，测试内替换）。返回还原函数。
func allowAllReadAuth(t *testing.T) {
	t.Helper()
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	t.Cleanup(func() { managerSessionOK = old })
}

func TestV0977PDFInfoAndPage(t *testing.T) {
	allowAllReadAuth(t)
	dir := t.TempDir()
	withStubPoppler(t, dir)
	a, _ := newPDFTestApp(t)

	rec := httptest.NewRecorder()
	a.pdfInfo(rec, httptest.NewRequest(http.MethodGet, "/api/media/pdf/info?id=comic-1&path=comic.pdf", nil))
	if rec.Code != 200 {
		t.Fatalf("pdfInfo status=%d body=%s", rec.Code, rec.Body.String())
	}
	var info struct {
		Pages int `json:"pages"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &info) != nil || info.Pages != 3 {
		t.Fatalf("pdfInfo pages wrong: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	a.pdfPage(rec, httptest.NewRequest(http.MethodGet, "/api/media/pdf/page?id=comic-1&path=comic.pdf&page=2&w=800", nil))
	if rec.Code != 200 {
		t.Fatalf("pdfPage status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() == 0 {
		t.Fatal("pdfPage returned an empty page")
	}
}

func TestV0977PDFRejectsBadInput(t *testing.T) {
	allowAllReadAuth(t)
	dir := t.TempDir()
	withStubPoppler(t, dir)
	a, _ := newPDFTestApp(t)

	cases := []string{
		"/api/media/pdf/page?id=comic-1&path=comic.pdf",                 // 缺 page
		"/api/media/pdf/page?id=comic-1&path=comic.pdf&page=0",          // 越界
		"/api/media/pdf/page?id=comic-1&path=comic.pdf&page=abc",        // 非数字
		"/api/media/pdf/page?id=comic-1&path=notes.txt&page=1",          // 非 PDF
		"/api/media/pdf/page?id=nope&path=comic.pdf&page=1",             // 库不存在
		"/api/media/pdf/page?id=comic-1&path=../../etc/passwd&page=1",   // 目录穿越
		"/api/media/pdf/page?id=comic-1&path=comic.pdf&page=1&w=999999", // 宽度越界
	}
	for _, target := range cases {
		rec := httptest.NewRecorder()
		a.pdfPage(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code == 200 {
			t.Fatalf("%s must be rejected, got 200", target)
		}
	}
}

func TestV0977PDFPageCacheReuse(t *testing.T) {
	allowAllReadAuth(t)
	dir := t.TempDir()
	withStubPoppler(t, dir)
	a, pdf := newPDFTestApp(t)

	st, err := os.Stat(pdf)
	if err != nil {
		t.Fatal(err)
	}
	key := pdfPageCacheKey("comic-1", pdf, 1, 800, 82, st.Size(), st.ModTime().Unix())
	first := httptest.NewRecorder()
	a.pdfPage(first, httptest.NewRequest(http.MethodGet, "/api/media/pdf/page?id=comic-1&path=comic.pdf&page=1&w=800", nil))
	if first.Code != 200 {
		t.Fatalf("first render failed: %d %s", first.Code, first.Body.String())
	}
	if first.Header().Get("X-Vaulthub-Page-Cache") != "miss" {
		t.Fatalf("first render should be a cache miss, got %q", first.Header().Get("X-Vaulthub-Page-Cache"))
	}
	if _, ok := a.pageCacheRef().get(key); !ok {
		t.Fatal("rendered page must land in the shared page cache")
	}
	second := httptest.NewRecorder()
	a.pdfPage(second, httptest.NewRequest(http.MethodGet, "/api/media/pdf/page?id=comic-1&path=comic.pdf&page=1&w=800", nil))
	if second.Header().Get("X-Vaulthub-Page-Cache") != "hit" {
		t.Fatalf("second render should be a cache hit, got %q", second.Header().Get("X-Vaulthub-Page-Cache"))
	}
}

func TestV0977RoutesRegistered(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{`"/api/media/pdf/info"`, `"/api/media/pdf/page"`, `"/api/media/pdf/cover"`} {
		if !containsText(string(src), route) {
			t.Fatalf("route %s not registered", route)
		}
	}
}

func TestV0977ScrubSecret(t *testing.T) {
	key := "abc123SECRETtoken"
	body := `{"status_message":"Invalid API key: abc123SECRETtoken was rejected","api_key":"abc123SECRETtoken"}`
	out := scrubSecret(body, key)
	if containsText(out, key) {
		t.Fatalf("secret must be scrubbed from upstream errors, got %s", out)
	}
	if !containsText(out, "***") {
		t.Fatal("scrubbed text should show a redaction marker")
	}
	// URL 转义形态同样要擦掉（密钥可能出现在被回显的请求 URL 里）
	esc := url.QueryEscape(key)
	if containsText(scrubSecret("GET /x?api_key="+esc, key), esc) {
		t.Fatal("url-escaped secret form must be scrubbed too")
	}
	// 无密钥时保持原样
	if scrubSecret("plain", "") != "plain" {
		t.Fatal("empty secret must pass text through untouched")
	}
	// 长文本截断
	long := strings.Repeat("x", 500)
	if len(scrubSecret(long, "k")) != 300 {
		t.Fatalf("oversized error body must be truncated, got %d", len(scrubSecret(long, "k")))
	}
}

func TestV0977PDFPageOutOfRangeRejected(t *testing.T) {
	allowAllReadAuth(t)
	dir := t.TempDir()
	withStubPoppler(t, dir) // 桩 pdfinfo 报 3 页
	a, _ := newPDFTestApp(t)
	rec := httptest.NewRecorder()
	a.pdfPage(rec, httptest.NewRequest(http.MethodGet, "/api/media/pdf/page?id=comic-1&path=comic.pdf&page=9&w=800", nil))
	if rec.Code != 404 {
		t.Fatalf("page beyond the real count must 404, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestV0977PDFDefaultWidthApplied(t *testing.T) {
	allowAllReadAuth(t)
	dir := t.TempDir()
	withStubPoppler(t, dir)
	a, pdf := newPDFTestApp(t)
	rec := httptest.NewRecorder()
	a.pdfPage(rec, httptest.NewRequest(http.MethodGet, "/api/media/pdf/page?id=comic-1&path=comic.pdf&page=1", nil))
	if rec.Code != 200 {
		t.Fatalf("page without w must still render, got %d %s", rec.Code, rec.Body.String())
	}
	st, err := os.Stat(pdf)
	if err != nil {
		t.Fatal(err)
	}
	key := pdfPageCacheKey("comic-1", pdf, 1, pdfDefaultPageWidth, 82, st.Size(), st.ModTime().Unix())
	if _, ok := a.pageCacheRef().get(key); !ok {
		t.Fatal("page without explicit width must be cached at the default width")
	}
}

func TestV0977PDFCountCacheReuse(t *testing.T) {
	allowAllReadAuth(t)
	dir := t.TempDir()
	withStubPoppler(t, dir)
	a, pdf := newPDFTestApp(t)
	st, err := os.Stat(pdf)
	if err != nil {
		t.Fatal(err)
	}
	first, _, err := a.pdfCountCached(context.Background(), pdf, st)
	if err != nil || first != 3 {
		t.Fatalf("first count = %d err=%v", first, err)
	}
	pdfCountMu.Lock()
	_, cached := pdfCountCache[pdf]
	pdfCountMu.Unlock()
	if !cached {
		t.Fatal("page count must be memoised")
	}
	second, _, err := a.pdfCountCached(context.Background(), pdf, st)
	if err != nil || second != 3 {
		t.Fatalf("cached count = %d err=%v", second, err)
	}
}

func TestV0977ContainsTextAndHelpersCompiled(t *testing.T) {
	// 路由与常量在同一文件里被引用，缺一个都编译不过；这里顺带固定常量值。
	if pdfDefaultPageWidth != 1600 {
		t.Fatalf("default page width changed: %d", pdfDefaultPageWidth)
	}
	if pdfMaxPages <= 0 || pdfRenderTimeout <= 0 {
		t.Fatal("pdf limits must be positive")
	}
}

func containsText(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
