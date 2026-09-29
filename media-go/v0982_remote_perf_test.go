package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* v0.9.82：远程（DDNS）访问提速的回归守卫。
 *
 * 1) /api/media/files 必须带 ETag + version，并在 If-None-Match 命中时回 304 空体 ——
 *    否则每次切库/刷新都要在 WAN 上重传整份媒体索引。
 * 2) /api/media/cover 支持 w 缩略：海报墙拿十几 KB 的 JPEG 而不是 MB 级原图；
 *    无 w 时仍流式直出原图（老客户端不受影响）。
 */

func filesRequest(t *testing.T, a *App, query string, ifNoneMatch string) *httptest.ResponseRecorder {
	t.Helper()
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	req := httptest.NewRequest(http.MethodGet, "/api/media/files?"+query, nil)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	rr := httptest.NewRecorder()
	a.files(rr, req)
	return rr
}

func seedIndex(t *testing.T, a *App, libID string, rows [][3]any) {
	t.Helper()
	for _, r := range rows {
		if _, err := a.db.Exec(`INSERT INTO files(lib,path,size,mtime) VALUES(?,?,?,?)`, libID, r[0], r[1], r[2]); err != nil {
			t.Fatalf("seed %v: %v", r, err)
		}
	}
}

func TestV0982FilesConditionalRequest(t *testing.T) {
	a := testApp(t)
	dir := t.TempDir()
	a.libs = []Library{{ID: "m1", Name: "电影", Type: "movie", Path: dir}}
	seedIndex(t, a, "m1", [][3]any{
		{"Dune.2021.mkv", int64(1000), int64(1700000000)},
		{"Heat.1995.mkv", int64(2000), int64(1700000100)},
	})

	first := filesRequest(t, a, "id=m1&offset=0&limit=500", "")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body=%s", first.Code, first.Body.String())
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("响应缺少 ETag：远程客户端无法做条件请求")
	}
	if cc := first.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Fatalf("Cache-Control = %q，应为 private, no-cache（可缓存但强制回源校验）", cc)
	}
	var payload struct {
		Version string `json:"version"`
		Total   int    `json:"total"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Version == "" || payload.Total != 2 {
		t.Fatalf("version=%q total=%d", payload.Version, payload.Total)
	}

	second := filesRequest(t, a, "id=m1&offset=0&limit=500", etag)
	if second.Code != http.StatusNotModified {
		t.Fatalf("条件请求 status = %d，应为 304（命中时不重传索引）body=%s", second.Code, second.Body.String())
	}
	if second.Body.Len() != 0 {
		t.Fatalf("304 响应体必须为空，实际 %d 字节", second.Body.Len())
	}

	/* 索引变化（扫描写入新行）后 ETag 必须变化，避免客户端拿到陈旧索引。 */
	seedIndex(t, a, "m1", [][3]any{{"New.2024.mkv", int64(3000), int64(1700000200)}})
	third := filesRequest(t, a, "id=m1&offset=0&limit=500", etag)
	if third.Code != http.StatusOK {
		t.Fatalf("索引变化后仍回 %d，应重新下发", third.Code)
	}
	if third.Header().Get("ETag") == etag {
		t.Fatal("索引已变但 ETag 未变")
	}

	/* 不同分页 URL 的 ETag 必须互不相同（HTTP 语义：ETag 是针对该 URL 的）。 */
	paged := filesRequest(t, a, "id=m1&offset=0&limit=1", "")
	if paged.Header().Get("ETag") == third.Header().Get("ETag") {
		t.Fatal("不同分页参数的 ETag 相同")
	}
}

func TestV0982CoverThumbnail(t *testing.T) {
	dir := t.TempDir()
	// 800×600 的真实 PNG（模拟刮削到的大封面）。
	src := image.NewRGBA(image.Rect(0, 0, 800, 600))
	for x := 0; x < 800; x++ {
		for y := 0; y < 600; y++ {
			src.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 90, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, src); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "movie.mkv"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	coverPNG := buf.Bytes()
	if err := os.WriteFile(filepath.Join(dir, "movie.cover.png"), coverPNG, 0644); err != nil {
		t.Fatal(err)
	}

	cacheDir := filepath.Join(dir, "page-cache")
	a := &App{libs: []Library{{ID: "m1", Name: "电影", Type: "movie", Path: dir}},
		pageCacheDir: cacheDir, pageCacheMaxBytes: 64 << 20}

	thumbURL := "/api/media/cover?id=m1&path=movie.cover.png&w=64"
	miss := httptest.NewRecorder()
	a.coverGet(miss, httptest.NewRequest(http.MethodGet, thumbURL, nil))
	if miss.Code != 200 {
		t.Fatalf("缩略请求 status = %d body=%s", miss.Code, miss.Body.String())
	}
	if ct := miss.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("缩略 Content-Type = %q，应为 image/jpeg", ct)
	}
	if miss.Header().Get("X-Vaulthub-Cover-Cache") != "miss" {
		t.Fatalf("首次应标记 miss，实际 %q", miss.Header().Get("X-Vaulthub-Cover-Cache"))
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(miss.Body.Bytes()))
	if err != nil || format != "jpeg" {
		t.Fatalf("缩略不是可解码 JPEG: %v %q", err, format)
	}
	if cfg.Width != 64 {
		t.Fatalf("缩略宽度 = %d，应为 64", cfg.Width)
	}
	if miss.Body.Len() >= len(coverPNG) {
		t.Fatalf("缩略体积 %d 未小于原图 %d", miss.Body.Len(), len(coverPNG))
	}

	hit := httptest.NewRecorder()
	a.coverGet(hit, httptest.NewRequest(http.MethodGet, thumbURL, nil))
	if hit.Header().Get("X-Vaulthub-Cover-Cache") != "hit" {
		t.Fatalf("二次请求应命中磁盘缓存，实际 %q", hit.Header().Get("X-Vaulthub-Cover-Cache"))
	}
	if !bytes.Equal(hit.Body.Bytes(), miss.Body.Bytes()) {
		t.Fatal("缓存命中的缩略字节与首次不一致")
	}
	// 落盘位置在按页缓存目录内（内容寻址），不污染媒体目录。
	entries, _ := os.ReadDir(cacheDir)
	if len(entries) == 0 {
		t.Fatal("缩略未落盘到 page-cache 目录")
	}

	/* 条件请求：带上 ETag 应回 304（海报墙重复浏览时零字节）。 */
	etag := hit.Header().Get("ETag")
	if etag == "" {
		t.Fatal("缩略响应缺少 ETag")
	}
	revalidate := httptest.NewRequest(http.MethodGet, thumbURL, nil)
	revalidate.Header.Set("If-None-Match", etag)
	revalidateRec := httptest.NewRecorder()
	a.coverGet(revalidateRec, revalidate)
	if revalidateRec.Code != http.StatusNotModified {
		t.Fatalf("缩略条件请求 status = %d，应为 304", revalidateRec.Code)
	}

	/* 无 w：仍流式直出原图，老客户端/老 URL 行为不变。 */
	raw := httptest.NewRecorder()
	a.coverGet(raw, httptest.NewRequest(http.MethodGet, "/api/media/cover?id=m1&path=movie.cover.png", nil))
	if raw.Code != 200 {
		t.Fatalf("原图请求 status = %d", raw.Code)
	}
	if ct := raw.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("原图 Content-Type = %q，应为 image/png", ct)
	}
	if !bytes.Equal(raw.Body.Bytes(), coverPNG) {
		t.Fatal("无 w 时下发的字节与源文件不一致")
	}

	/* 过大/非法的 w 不得建缓存，但对不可转码的源仍必须回原图。 */
	odd := httptest.NewRecorder()
	a.coverGet(odd, httptest.NewRequest(http.MethodGet, "/api/media/cover?id=m1&path=movie.cover.png&w=99999", nil))
	if odd.Code != 200 || !bytes.Equal(odd.Body.Bytes(), coverPNG) {
		t.Fatalf("超出上限的 w 应回落原图，status=%d len=%d", odd.Code, odd.Body.Len())
	}
	text := filepath.Join(dir, "note.cover.txt")
	os.WriteFile(text, []byte("not an image"), 0644)
	bad := httptest.NewRecorder()
	a.coverGet(bad, httptest.NewRequest(http.MethodGet, "/api/media/cover?id=m1&path=note.cover.txt&w=64", nil))
	if bad.Code != 404 {
		t.Fatalf("非图片封面应 404，实际 %d", bad.Code)
	}
	if strings.Contains(bad.Body.String(), "panic") {
		t.Fatal("非图片封面触发了异常路径")
	}
}

func TestV0982CoverThumbFallsBackWhenNoGain(t *testing.T) {
	dir := t.TempDir()
	// 40×30 的 JPEG：请求 w=64 时不放大（nw=40 无缩放）且源本身已是 JPEG
	// → 转码无体积收益，必须原样直出，绝不能因为「转换失败」变成 404 或空白海报。
	src := image.NewRGBA(image.Rect(0, 0, 40, 30))
	for x := 0; x < 40; x++ {
		for y := 0; y < 30; y++ {
			src.Set(x, y, color.RGBA{uint8(x * 6 % 256), uint8(y * 8 % 256), 40, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: 88}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "a.mkv"), []byte("x"), 0644)
	os.WriteFile(filepath.Join(dir, "a.cover.jpg"), buf.Bytes(), 0644)
	a := &App{libs: []Library{{ID: "m1", Name: "电影", Type: "movie", Path: dir}},
		pageCacheDir: filepath.Join(dir, "pc"), pageCacheMaxBytes: 64 << 20}
	cache := a.pageCacheRef()
	beforeEntries, _, _, _ := cache.stats()
	rr := httptest.NewRecorder()
	a.coverGet(rr, httptest.NewRequest(http.MethodGet, "/api/media/cover?id=m1&path=a.cover.jpg&w=64", nil))
	if rr.Code != 200 || rr.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("无收益时应直出原图，status=%d ct=%q", rr.Code, rr.Header().Get("Content-Type"))
	}
	if !bytes.Equal(rr.Body.Bytes(), buf.Bytes()) {
		t.Fatal("无收益时下发的字节与源文件不一致（被无谓重编码）")
	}
	afterEntries, _, _, _ := cache.stats()
	if afterEntries != beforeEntries {
		t.Fatalf("无收益的请求不应写入缓存，条目 %d → %d", beforeEntries, afterEntries)
	}
}
