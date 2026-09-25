package main

import (
	"os"
	"path/filepath"
	"testing"
)

// v0.9.79：新增的 page_cache_max_bytes 与 scan_max_depth 并入运行时配置，
// 使原依赖 env/vaulthub.env 的「归档页缓存配额」「扫描深度」可在线编辑。
func TestV0979PageCacheAndScanDepthRoundTrip(t *testing.T) {
	dir := t.TempDir()
	a := &App{
		indexDir:      filepath.Join(dir, "idx"),
		cacheDir:      filepath.Join(dir, "cache"),
		cacheMaxBytes: 10 * 1024 * 1024 * 1024,
		cacheMaxAge:   168,
		cacheCleanup:  24,
		pageCacheMaxBytes: 0,
		scanMaxDepth:  0,
	}
	a.runtimeConfig = filepath.Join(dir, "media-runtime.json")

	// 设置新字段并保存
	c := RuntimeConfig{
		ScraperMode:  "auto",
		TMDBAPIBase:   "https://api.themoviedb.org/3",
		TMDBImageBase:  "https://image.tmdb.org/t/p",
		TVDBAPIBase:    "https://api4.thetvdb.com/v4",
		CacheDir:       a.cacheDir,
		CacheMaxBytes:   10 * 1024 * 1024 * 1024,
		CacheMaxAgeHours: 336,
		CacheCleanupIntervalHours: 24,
		PageCacheMaxBytes: 16 * 1024 * 1024 * 1024,
		ScanMaxDepth:    12,
	}
	if err := a.saveRuntimeConfig(c); err != nil {
		t.Fatalf("saveRuntimeConfig: %v", err)
	}

	// 重新从磁盘载入，校验内存生效
	a2 := &App{runtimeConfig: a.runtimeConfig}
	a2.loadRuntimeConfig()
	if a2.scanMaxDepth != 12 {
		t.Fatalf("scanMaxDepth: want 12 got %d", a2.scanMaxDepth)
	}
	if a2.pageCacheMaxBytes != 16*1024*1024*1024 {
		t.Fatalf("pageCacheMaxBytes: want 16GiB got %d", a2.pageCacheMaxBytes)
	}
	if got := a2.cacheMaxBytes; got != 10*1024*1024*1024 {
		t.Fatalf("cacheMaxBytes: want 10GiB got %d", got)
	}

	// effectiveScanMaxDepth 应返回在线配置值 12（优先于 env 默认）
	if got := a2.effectiveScanMaxDepth(); got != 12 {
		t.Fatalf("effectiveScanMaxDepth: want 12 got %d", got)
	}

	// 非法负值应被拒绝
	bad := c
	bad.ScanMaxDepth = -1
	if err := a2.saveRuntimeConfig(bad); err == nil {
		t.Fatal("expected error for negative scan_max_depth")
	}
	_ = os.Remove(a.runtimeConfig)
}
