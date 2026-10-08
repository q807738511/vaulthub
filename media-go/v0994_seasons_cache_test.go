package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

/* v0.9.94 测试：
 *   需求8 —— 转码缓存卷自检（cacheDisk 判定"是否独立于主数据卷"）。
 *   需求9 —— 季标签刮削：TMDB 代理放开 tv/{id}/season/{n}、季字段持久化与限长。
 */

// TestV0994CacheDiskSeparateVolume 用一份可控的 /proc/mounts 夹具验证：
// 缓存目录与主数据目录落在不同块设备 → Separate=true；同一设备 → false。
func TestV0994CacheDiskSeparateVolume(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "vol3", "cache", "transcode")
	dataDir := filepath.Join(root, "vol1", "vaulthub", "data")
	for _, d := range []string{cacheDir, dataDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	mounts := filepath.Join(root, "mounts")
	content := strings.Join([]string{
		"/dev/sda1 / ext4 rw 0 0",
		"/dev/sdb1 " + filepath.Join(root, "vol1") + " ext4 rw 0 0",
		"/dev/sdc1 " + filepath.Join(root, "vol3") + " ext4 rw 0 0",
	}, "\n") + "\n"
	if err := os.WriteFile(mounts, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SYSTEM_MONITOR_MOUNTS", mounts)

	// 独立卷：缓存挂 vol3，主数据在 vol1（两个目录都真实存在，statfs 才有容量可报）
	sep := cacheDisk(cacheDir, dataDir, nil)
	if sep.Device != "/dev/sdc1" || sep.DataDevice != "/dev/sdb1" {
		t.Fatalf("设备识别错误：cache=%q data=%q", sep.Device, sep.DataDevice)
	}
	if !sep.Separate {
		t.Fatalf("缓存与主数据不在同一设备时应判定为独立卷：%+v", sep)
	}
	if sep.Total == 0 {
		t.Fatalf("应报出缓存卷容量：%+v", sep)
	}

	// 同卷：缓存写在主数据卷里（就是要被自检抓出来的部署错误）
	same := cacheDisk(filepath.Join(dataDir, "transcode-cache"), dataDir, nil)
	if same.Separate {
		t.Fatalf("同一设备不应判定为独立卷：%+v", same)
	}
	if same.Device != same.DataDevice || same.Device == "" {
		t.Fatalf("同卷时设备应一致且非空：%+v", same)
	}

	// 空路径：不 panic、返回零值
	if empty := cacheDisk("", dataDir, nil); empty.Separate || empty.Path != "" {
		t.Fatalf("空缓存目录应返回零值结构：%+v", empty)
	}
}

// TestV0994SanitizeSeasonFields 季字段清洗：限长、非法季号归零、不影响整条接收。
func TestV0994SanitizeSeasonFields(t *testing.T) {
	item, ok := sanitizeScrapeCacheItem(scrapeCacheItem{
		Title:          "第 4 季 第 12 集",
		ShowTitle:      "幽游白书",
		State:          "ok",
		SeasonNum:      4,
		SeasonTag:      strings.Repeat("幽", 500), // 超长，应被裁剪
		SeasonName:     "幽游白书 第四季",
		SeasonOverview: strings.Repeat("简介", 3000), // 超长，应被裁剪
	})
	if !ok {
		t.Fatal("合法条目不该被拒收")
	}
	if item.SeasonNum != 4 {
		t.Fatalf("季号应保留 4，得到 %d", item.SeasonNum)
	}
	if len([]rune(item.SeasonTag)) > scrapeCacheMaxSmall {
		t.Fatalf("季标签未限长：%d", len([]rune(item.SeasonTag)))
	}
	if len([]rune(item.SeasonOverview)) > scrapeCacheMaxDesc {
		t.Fatalf("季简介未限长：%d", len([]rune(item.SeasonOverview)))
	}
	if item.SeasonName != "幽游白书 第四季" {
		t.Fatalf("季名被改坏：%q", item.SeasonName)
	}

	// 非法季号：负数 / 超出 99 → 归零，但整条仍接收（不因为一个季号把刮削结果丢掉）
	for _, bad := range []int{-1, 100, 999} {
		out, ok := sanitizeScrapeCacheItem(scrapeCacheItem{Title: "x", ShowTitle: "y", State: "ok", SeasonNum: bad})
		if !ok {
			t.Fatalf("季号 %d 不该导致整条被拒收", bad)
		}
		if out.SeasonNum != 0 {
			t.Fatalf("非法季号 %d 应归零，得到 %d", bad, out.SeasonNum)
		}
	}

	// 季字段进 JSON 后能原样读回（跨设备持久化的关键）
	blob, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	var back scrapeCacheItem
	if err := json.Unmarshal(blob, &back); err != nil {
		t.Fatal(err)
	}
	if back.SeasonNum != item.SeasonNum || back.SeasonTag != item.SeasonTag || back.SeasonName != item.SeasonName {
		t.Fatalf("季字段往返丢失：%+v", back)
	}
}

// TestV0994TMDbSeasonEndpoint 验证 TMDB 代理：
//   · season=N 时请求 tv/{id}/season/N（而不是 tv/{id}）
//   · 季端点不带 append_to_response（TMDB 会因此报错）
//   · 非法季号直接 400，不打上游
func TestV0994TMDbSeasonEndpoint(t *testing.T) {
	/* 与仓库内其它端到端用例一致：直接放行会话校验（结束后还原）。 */
	oldSession := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldSession }()
	/* 出站客户端默认带 SSRF 防护（拒绝私网/回环目标，network_test.go 单独覆盖），
	   httptest 监听的是 127.0.0.1 —— 这里临时换成默认客户端，专门验证「代理把请求
	   发到哪个上游路径」，防护本身不受影响、用例结束后还原。 */
	oldClient := outboundHTTPClient
	outboundHTTPClient = func(string) (*http.Client, error) { return http.DefaultClient, nil }
	defer func() { outboundHTTPClient = oldClient }()

	var mu sync.Mutex
	var gotPath, gotQuery string

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"幽游白书 第四季","overview":"demo","poster_path":"/p.jpg","episodes":[{"episode_number":1,"name":"第一集"}]}`))
	}))
	defer upstream.Close()

	a := &App{}
	a.load()
	a.mu.Lock()
	a.tmdbAPIKey = "0123456789abcdef0123456789abcdef"
	a.tmdbAPIBase = upstream.URL
	a.mu.Unlock()

	// 1) 合法季号 → tv/1234/season/4，且不带 append_to_response
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/media/tmdb?id=1234&type=series&season=4&lang=zh-CN", nil)
	a.tmdb(rec, req)
	if rec.Code != 200 {
		t.Fatalf("季详情请求应 200，得到 %d：%s", rec.Code, rec.Body.String())
	}
	mu.Lock()
	path, query := gotPath, gotQuery
	mu.Unlock()
	if path != "/tv/1234/season/4" {
		t.Fatalf("季端点路径错误：%q", path)
	}
	if strings.Contains(query, "append_to_response") {
		t.Fatalf("季端点不该带 append_to_response：%q", query)
	}
	if !strings.Contains(query, "language=zh-CN") {
		t.Fatalf("季端点应带语言参数：%q", query)
	}
	// 前端 fetchSeriesSeason 依赖的字段要能透传
	if !strings.Contains(rec.Body.String(), "episodes") || !strings.Contains(rec.Body.String(), "poster_path") {
		t.Fatalf("季详情响应应包含 episodes/poster_path：%s", rec.Body.String())
	}

	// 2) 影视详情仍带 append_to_response（回归：不要为了季端点把详情弄丢）
	rec2 := httptest.NewRecorder()
	a.tmdb(rec2, httptest.NewRequest("GET", "/api/media/tmdb?id=1234&type=series&lang=zh-CN", nil))
	mu.Lock()
	path2, query2 := gotPath, gotQuery
	mu.Unlock()
	if path2 != "/tv/1234" || !strings.Contains(query2, "append_to_response=credits,recommendations,images") {
		t.Fatalf("影视详情应保持 tv/{id} + append_to_response：path=%q query=%q", path2, query2)
	}

	// 3) 非法季号 → 400，且不打上游
	for _, bad := range []string{"abc", "-1", "100", "4.5"} {
		mu.Lock()
		gotPath = ""
		mu.Unlock()
		rec3 := httptest.NewRecorder()
		a.tmdb(rec3, httptest.NewRequest("GET", "/api/media/tmdb?id=1234&type=series&season="+bad, nil))
		if rec3.Code != 400 {
			t.Fatalf("非法季号 %q 应 400，得到 %d", bad, rec3.Code)
		}
		mu.Lock()
		called := gotPath != ""
		mu.Unlock()
		if called {
			t.Fatalf("非法季号 %q 不该请求上游", bad)
		}
	}

	// 4) 电影端点不受影响（season 只对 tv 生效）
	rec4 := httptest.NewRecorder()
	a.tmdb(rec4, httptest.NewRequest("GET", "/api/media/tmdb?id=55&type=movie&season=4", nil))
	mu.Lock()
	path4 := gotPath
	mu.Unlock()
	if path4 != "/movie/55" {
		t.Fatalf("电影端点不该被 season 影响：%q", path4)
	}
}

// 确保 syscall.Statfs 在本平台可用（cacheDisk 依赖它；跨平台构建失败要早发现）。
var _ = syscall.Statfs
