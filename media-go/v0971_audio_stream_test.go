package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

/* v0.9.71 弱网服务端守卫：限码率音频流 + 下行探测。
 *
 * 这里不依赖 ffmpeg：转码路径只验证「失败时的行为」（源文件不是有效音频 / 环境无
 * ffmpeg 都应返回 500 而不是挂死或返回半个响应）；缓存命中路径直接预写缓存文件，
 * 用真实 HTTP 请求验证 Content-Type、档位响应头、缓存状态与 Range。
 */

func TestV0971ParseAudioBitrate(t *testing.T) {
	valid := map[string]int{"96k": 96, "96": 96, "128K": 128, "320kbps": 320, " 192k ": 192, "64k": 64}
	for raw, want := range valid {
		got, err := parseAudioBitrate(raw)
		if err != nil || got != want {
			t.Fatalf("parseAudioBitrate(%q) = %d/%v, want %d", raw, got, err, want)
		}
	}
	invalid := []string{"", "0", "-128", "100", "999", "abc", "128kk", "1e3"}
	for _, raw := range invalid {
		if got, err := parseAudioBitrate(raw); err == nil {
			t.Fatalf("parseAudioBitrate(%q) 必须拒绝，却返回 %d", raw, got)
		}
	}
}

func TestV0971AudioStreamCacheKey(t *testing.T) {
	now := time.Now()
	base := audioStreamCacheKey("/YY/a.mp3", now, 128)
	if base != audioStreamCacheKey("/YY/a.mp3", now, 128) {
		t.Fatal("同输入必须得到同缓存键（否则缓存永不命中）")
	}
	if base == audioStreamCacheKey("/YY/a.mp3", now, 96) {
		t.Fatal("码率不同必须换键")
	}
	if base == audioStreamCacheKey("/YY/b.mp3", now, 128) {
		t.Fatal("源文件不同必须换键")
	}
	if base == audioStreamCacheKey("/YY/a.mp3", now.Add(time.Second), 128) {
		t.Fatal("源文件修改时间变化必须换键（否则改了文件还命中旧转码）")
	}
	if len(base) != 40 {
		t.Fatalf("缓存键应是 sha1 十六进制，实际长度 %d", len(base))
	}
}

func TestV0971WeakProbePayload(t *testing.T) {
	small := weakProbePayload(1024)
	if len(small) != 1024 {
		t.Fatalf("探测负载长度应为 1024，实际 %d", len(small))
	}
	if string(weakProbePayload(1024)) != string(small) {
		t.Fatal("探测负载必须确定性（便于断言与缓存），两次结果不一致")
	}
	if len(weakProbePayload(2048*1024)) != 2048*1024 {
		t.Fatal("上限尺寸必须可满足")
	}
	// 不可压缩性：随机字节的重复率应远低于可压缩文本
	distinct := map[byte]bool{}
	for _, b := range small {
		distinct[b] = true
	}
	if len(distinct) < 120 {
		t.Fatalf("探测负载疑似可压缩（不同字节仅 %d），会让测速失真", len(distinct))
	}
}

func TestV0971WeakProbeHandler(t *testing.T) {
	// 未登录 → 401
	a := &App{}
	rec := httptest.NewRecorder()
	a.weakProbe(rec, httptest.NewRequest(http.MethodGet, "/api/media/weak/probe?kb=64", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，实际 %d", rec.Code)
	}

	oldOK := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldOK }()

	// 默认 256 KiB + 禁压缩/禁缓存头
	rec = httptest.NewRecorder()
	a.weakProbe(rec, httptest.NewRequest(http.MethodGet, "/api/media/weak/probe", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("默认探测应 200，实际 %d", rec.Code)
	}
	if rec.Body.Len() != 256*1024 {
		t.Fatalf("默认负载应为 262144 字节，实际 %d", rec.Body.Len())
	}
	if got := rec.Header().Get("X-Vaulthub-Probe-Bytes"); got != strconv.Itoa(256*1024) {
		t.Fatalf("X-Vaulthub-Probe-Bytes = %q", got)
	}
	if rec.Header().Get("Content-Encoding") != "identity" {
		t.Fatalf("必须声明不做压缩（否则中间层压缩会让测速虚高）：%q", rec.Header().Get("Content-Encoding"))
	}
	if !strings.Contains(rec.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("探测响应不得被缓存：%q", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("Content-Length") != strconv.Itoa(256*1024) {
		t.Fatalf("Content-Length 必须与实际字节一致：%q", rec.Header().Get("Content-Length"))
	}

	// 指定大小
	rec = httptest.NewRecorder()
	a.weakProbe(rec, httptest.NewRequest(http.MethodGet, "/api/media/weak/probe?kb=512", nil))
	if rec.Body.Len() != 512*1024 {
		t.Fatalf("kb=512 应返回 524288 字节，实际 %d", rec.Body.Len())
	}

	// 越界与非法参数
	for _, q := range []string{"?kb=4", "?kb=4096", "?kb=abc"} {
		rec = httptest.NewRecorder()
		a.weakProbe(rec, httptest.NewRequest(http.MethodGet, "/api/media/weak/probe"+q, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s 应 400，实际 %d", q, rec.Code)
		}
	}
	// 非 GET
	rec = httptest.NewRecorder()
	a.weakProbe(rec, httptest.NewRequest(http.MethodPost, "/api/media/weak/probe", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 应 405，实际 %d", rec.Code)
	}
}

// newStreamTestApp 造一个含真实音频文件的库与临时缓存目录。
func newStreamTestApp(t *testing.T) (*App, string, string) {
	t.Helper()
	mediaDir := t.TempDir()
	cacheDir := t.TempDir()
	src := filepath.Join(mediaDir, "song.mp3")
	if err := os.WriteFile(src, []byte("ID3\x04\x00\x00\x00\x00\x00\x00fake-audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &App{libs: []Library{{ID: "l1", Name: "音乐", Type: "audio", Path: mediaDir}}, cacheDir: cacheDir}
	return a, src, cacheDir
}

func TestV0971AudioStreamValidation(t *testing.T) {
	a, _, _ := newStreamTestApp(t)

	rec := httptest.NewRecorder()
	a.audioStream(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/stream?id=l1&path=song.mp3&bitrate=128k", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，实际 %d", rec.Code)
	}

	oldOK := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldOK }()

	cases := []struct {
		url  string
		code int
	}{
		{"/api/media/audio/stream?id=nope&path=song.mp3&bitrate=128k", http.StatusNotFound},
		{"/api/media/audio/stream?id=l1&path=missing.mp3&bitrate=128k", http.StatusNotFound},
		{"/api/media/audio/stream?id=l1&path=../etc/passwd&bitrate=128k", http.StatusNotFound},
		{"/api/media/audio/stream?id=l1&path=song.mp3&bitrate=100k", http.StatusBadRequest},
		{"/api/media/audio/stream?id=l1&path=song.mp3", http.StatusBadRequest},
		{"/api/media/audio/stream?id=l1&path=song.mp3&bitrate=abc", http.StatusBadRequest},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		a.audioStream(rec, httptest.NewRequest(http.MethodGet, c.url, nil))
		if rec.Code != c.code {
			t.Fatalf("%s 应返回 %d，实际 %d（%s）", c.url, c.code, rec.Code, strings.TrimSpace(rec.Body.String()))
		}
	}

	// 非音频扩展名必须拒绝（不能拿它去转码任意文件）
	if err := os.WriteFile(filepath.Join(a.libs[0].Path, "movie.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	a.audioStream(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/stream?id=l1&path=movie.mkv&bitrate=128k", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非音频文件应 400，实际 %d", rec.Code)
	}
}

func TestV0971AudioStreamServesCacheHitWithRange(t *testing.T) {
	a, src, cacheDir := newStreamTestApp(t)
	oldOK := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldOK }()

	info, err := os.Stat(src)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(cacheDir, audioStreamCacheDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte("ID3\x04\x00\x00\x00\x00\x00\x00transcoded-mp3-bytes")
	cachePath := filepath.Join(dir, audioStreamCacheKey(src, info.ModTime(), 128)+".mp3")
	if err := os.WriteFile(cachePath, body, 0o644); err != nil {
		t.Fatal(err)
	}

	// 缓存命中：必须带上档位、状态与音频类型
	rec := httptest.NewRecorder()
	a.audioStream(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/stream?id=l1&path=song.mp3&bitrate=128k", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("缓存命中应 200，实际 %d（%s）", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "audio/mpeg") {
		t.Fatalf("Content-Type = %q", got)
	}
	if rec.Header().Get("X-Vaulthub-Audio-Cache") != "hit" {
		t.Fatalf("缓存状态头 = %q", rec.Header().Get("X-Vaulthub-Audio-Cache"))
	}
	if rec.Header().Get("X-Vaulthub-Audio-Bitrate") != "128k" {
		t.Fatalf("档位头 = %q", rec.Header().Get("X-Vaulthub-Audio-Bitrate"))
	}
	if !strings.Contains(rec.Header().Get("Cache-Control"), "private") {
		t.Fatalf("缓存头 = %q", rec.Header().Get("Cache-Control"))
	}
	if rec.Body.String() != string(body) {
		t.Fatal("响应体必须与缓存文件一致")
	}

	// Range：浏览器拖动进度依赖它
	req := httptest.NewRequest(http.MethodGet, "/api/media/audio/stream?id=l1&path=song.mp3&bitrate=128k", nil)
	req.Header.Set("Range", "bytes=0-2")
	rec = httptest.NewRecorder()
	a.audioStream(rec, req)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("Range 请求应 206，实际 %d", rec.Code)
	}
	if rec.Body.String() != "ID3" {
		t.Fatalf("206 响应体 = %q", rec.Body.String())
	}

	// 不同码率不共享缓存
	rec = httptest.NewRecorder()
	a.audioStream(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/stream?id=l1&path=song.mp3&bitrate=96k", nil))
	if got := rec.Header().Get("X-Vaulthub-Audio-Cache"); got == "hit" {
		t.Fatal("不同码率不得命中同一缓存文件")
	}
}

func TestV0971AudioStreamTranscodeFailureIsServerError(t *testing.T) {
	a, _, _ := newStreamTestApp(t)
	oldOK := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldOK }()

	// 缓存未命中 → 走转码；源文件不是有效音频（或环境无 ffmpeg）→ 必须 500，
	// 而不是挂死、也不是返回空的 200（前端据此回落原文件直出）。
	rec := httptest.NewRecorder()
	a.audioStream(rec, httptest.NewRequest(http.MethodGet, "/api/media/audio/stream?id=l1&path=song.mp3&bitrate=128k", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("转码失败应 500，实际 %d（%s）", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("错误响应应为 JSON：%s", rec.Body.String())
	}
	if msg, _ := payload["error"].(string); msg == "" {
		t.Fatal("错误响应必须带 error 字段")
	}
	// 失败不得留下半截缓存文件（否则后续请求会读到坏数据）
	dir := filepath.Join(a.cacheDir, audioStreamCacheDirName)
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".mp3") {
			t.Fatalf("转码失败后不应留下 .mp3 缓存：%s", entry.Name())
		}
		if strings.HasPrefix(entry.Name(), ".audio-") {
			t.Fatalf("临时文件必须清理：%s", entry.Name())
		}
	}
}

func TestV0971AudioStreamPrunesOldCache(t *testing.T) {
	a, src, cacheDir := newStreamTestApp(t)
	dir := filepath.Join(cacheDir, audioStreamCacheDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 三个「两小时前」的缓存文件；上限只容得下一个 → 必须删最旧，且保留最新
	var names []string
	old := time.Now().Add(-2 * time.Hour)
	for i := 0; i < 3; i++ {
		name := filepath.Join(dir, "cache-"+strconv.Itoa(i)+".mp3")
		if err := os.WriteFile(name, make([]byte, 1024), 0o644); err != nil {
			t.Fatal(err)
		}
		when := old.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(name, when, when); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	a.pruneAudioStreamCache(1024) // 只留下一个文件的空间
	kept := []string{}
	for _, n := range names {
		if _, err := os.Stat(n); err == nil {
			kept = append(kept, filepath.Base(n))
		}
	}
	if len(kept) != 1 || kept[0] != "cache-2.mp3" {
		t.Fatalf("应只保留最新的 cache-2.mp3，实际保留 %v", kept)
	}

	// 按龄过期：超过 audioStreamCacheMaxAge 的缓存即使配额充足也必须清掉
	// （发布说明与客户手册都写了「默认 7 天」，这一条让声明可被突变验证）。
	stale := filepath.Join(dir, "stale.mp3")
	if err := os.WriteFile(stale, make([]byte, 1024), 0o644); err != nil {
		t.Fatal(err)
	}
	longAgo := time.Now().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(stale, longAgo, longAgo); err != nil {
		t.Fatal(err)
	}
	a.pruneAudioStreamCache(1 << 30) // 配额充足 → 只有过期规则能删它
	if _, err := os.Stat(stale); err == nil {
		t.Fatal("超过缓存有效期（7 天）的文件必须被清理")
	}

	// 一小时内的新文件受保护（可能正在被读取）
	fresh := filepath.Join(dir, "fresh.mp3")
	if err := os.WriteFile(fresh, make([]byte, 1024), 0o644); err != nil {
		t.Fatal(err)
	}
	a.pruneAudioStreamCache(0)
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("一小时内的缓存文件不得被清理（可能正在被读取）")
	}
	_ = src
}

func TestV0971AudioStreamLimitIsBounded(t *testing.T) {
	a := &App{cacheMaxBytes: 100 << 30}
	if got := a.audioStreamCacheLimit(); got != 2<<30 {
		t.Fatalf("音频缓存上限应封顶 2 GiB，实际 %d", got)
	}
	a.cacheMaxBytes = 1 << 30
	if got := a.audioStreamCacheLimit(); got != 512<<20 {
		t.Fatalf("小于 4 GiB 的主缓存应取一半，实际 %d", got)
	}
	a.cacheMaxBytes = 0
	if got := a.audioStreamCacheLimit(); got != 2<<30 {
		t.Fatalf("未配置主缓存时应回落 2 GiB，实际 %d", got)
	}
}

// 路由必须注册：否则前端/客户手册里的 curl 全 404。
func TestV0971WeakNetworkRoutesRegistered(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{
		`mux.HandleFunc("/api/media/audio/stream", a.audioStream)`,
		`mux.HandleFunc("/api/media/weak/probe", a.weakProbe)`,
	} {
		if !strings.Contains(string(src), route) {
			t.Fatalf("缺少路由注册：%s", route)
		}
	}
}

/* 同键并发必须只转码一次（singleflight 的**行为**守卫）。
   之前只测了 beginAudioJob 这个辅助函数，把 audioStream 里的合并逻辑改掉测试仍然通过
   （突变 M28 未捕获）；这里用假 ffmpeg 记录调用次数，直接打两个并发 HTTP 请求。 */
func TestV0971AudioStreamMergesConcurrentTranscodes(t *testing.T) {
	a, _, _ := newStreamTestApp(t)
	oldOK := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldOK }()

	binDir := t.TempDir()
	counter := filepath.Join(t.TempDir(), "calls.log")
	// 假 ffmpeg：记录一次调用，延迟 800ms 让两个请求真正重叠，然后写出假 MP3。
	// 真正的 ffmpeg 参数里输出路径是最后一个参数（-y <tmp>）。
	script := "#!/bin/sh\n" +
		"echo call >> " + counter + "\n" +
		"sleep 0.8\n" +
		"for a in \"$@\"; do out=\"$a\"; done\n" +
		"printf 'ID3fake-transcoded' > \"$out\"\n"
	if err := os.WriteFile(filepath.Join(binDir, "ffmpeg"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))

	srv := httptest.NewServer(http.HandlerFunc(a.audioStream))
	defer srv.Close()
	target := srv.URL + "/api/media/audio/stream?id=l1&path=song.mp3&bitrate=128k"

	var wg sync.WaitGroup
	codes := make([]int, 2)
	bodies := make([]string, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := http.Get(target)
			if err != nil {
				codes[i] = -1
				return
			}
			defer res.Body.Close()
			codes[i] = res.StatusCode
			body, _ := io.ReadAll(res.Body)
			bodies[i] = string(body)
		}(i)
	}
	wg.Wait()

	raw, _ := os.ReadFile(counter)
	calls := strings.Count(string(raw), "call")
	if calls != 1 {
		t.Fatalf("同键并发应只调用一次转码器，实际 %d 次（HTTP 状态 %v，响应 %q/%q）", calls, codes, bodies[0], bodies[1])
	}
	for i, code := range codes {
		if code != http.StatusOK {
			t.Fatalf("第 %d 个请求应 200，实际 %d", i+1, code)
		}
		if bodies[i] != "ID3fake-transcoded" {
			t.Fatalf("第 %d 个请求响应体应来自缓存转码结果，实际 %q", i+1, bodies[i])
		}
	}
}
