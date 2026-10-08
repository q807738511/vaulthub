package main

/* v0.9.92 单元测试：封面/海报 sidecar 判定与「不入索引」，
   以及缓存目录（cache_dir）变更后分页缓存目录的重新派生。

   背景：
   - 客户反馈「电子书栏目目录里出现 .cover 文件」——cover_persist 写入的
     <媒体名>.cover.jpg 与 v0.9.89 的角色图 sidecar 在扫描端没有被排除。
   - 客户反馈「缓存目录映射配置要能测」——旧实现只在启动时派生
     pageCacheDir，运行时改 cache_dir 后分页缓存仍写旧目录。 */

import (
	"path/filepath"
	"testing"
)

func TestV0992SidecarImageNames(t *testing.T) {
	cases := []struct {
		base string
		want bool
	}{
		{"One Piece v01.cover.jpg", true},
		{"海贼王 第1卷.cover.png", true},
		{"a.cover.WEBP", true},
		{"movie.cover.jpeg", true},
		{"movie.cover.gif", true},
		{"Movie-poster.jpg", true},
		{"Movie-fanart.jpg", true},
		{"Movie-backdrop.png", true},
		{"Movie-logo.png", true},
		/* 媒体库级封面（local_metadata 认可）必须保留 */
		{"cover.jpg", false},
		{"poster.jpg", false},
		{"folder.jpg", false},
		/* 正常的媒体/文本文件 */
		{"第01集.mp4", false},
		{"book.txt", false},
		{"One Piece v01.cbz", false},
		{"一页漫画.jpg", false},
		{"001.jpg", false},
		/* 边界：非图片扩展、没有扩展名、没有名字 */
		{"a.cover.txt", false},
		{"a.cover", false},
		{".cover.jpg", false},
		{"", false},
	}
	for _, c := range cases {
		if got := isMediaSidecarImage(c.base); got != c.want {
			t.Fatalf("isMediaSidecarImage(%q) = %v, want %v", c.base, got, c.want)
		}
	}
}

func TestV0992SkipIndexSkipsSidecarsEverywhere(t *testing.T) {
	// sidecar 在任何库类型下都不该进索引（不只是蓝光原盘结构目录）。
	skip := []string{
		"One Piece v01.cover.jpg",
		"dir/书.cover.png",
		"电影/片名-poster.jpg",
		"音乐/歌名-fanart.jpg",
		"BDMV/STREAM/00011.m2ts.cover.jpg",
	}
	for _, rel := range skip {
		if !skipIndexFile(rel) {
			t.Fatalf("skipIndexFile(%q) = false，封面 sidecar 不该入库", rel)
		}
	}
	keep := []string{
		"cover.jpg",              // 库级封面
		"poster.jpg",             // 库级封面
		"第01集.mp4",               // 正常视频
		"书.txt",                  // 正常电子书
		"页/001.jpg",              // 漫画散图仍是内容
		"BDMV/STREAM/00011.m2ts", // 原盘里的真实片段仍保留
	}
	for _, rel := range keep {
		if skipIndexFile(rel) {
			t.Fatalf("skipIndexFile(%q) = true，不该跳过", rel)
		}
	}
}

func TestV0992CacheDirChangeRepointsPageCache(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old-cache")
	fresh := filepath.Join(dir, "new-cache")
	a := &App{
		runtimeConfig: filepath.Join(dir, "runtime.json"),
		cacheDir:      old,
		pageCacheDir:  filepath.Join(old, "page-cache"),
		pageCache:     newPageCache(filepath.Join(old, "page-cache"), 1<<20),
		cacheWake:     make(chan struct{}, 1),
	}
	cfg := RuntimeConfig{
		ScraperMode:               "auto",
		TMDBAPIBase:               "https://api.themoviedb.org/3",
		TMDBImageBase:             "https://image.tmdb.org/t/p",
		TVDBAPIBase:               "https://api4.thetvdb.com/v4",
		CacheDir:                  fresh,
		CacheMaxAgeHours:          12,
		CacheCleanupIntervalHours: 2,
	}
	if err := a.saveRuntimeConfig(cfg); err != nil {
		t.Fatalf("saveRuntimeConfig: %v", err)
	}
	if a.cacheDir != fresh {
		t.Fatalf("cacheDir = %q, want %q", a.cacheDir, fresh)
	}
	if want := filepath.Join(fresh, "page-cache"); a.pageCacheDir != want {
		t.Fatalf("pageCacheDir = %q, want %q（改缓存目录后分页缓存必须跟着走）", a.pageCacheDir, want)
	}
	if a.pageCache != nil {
		t.Fatal("pageCache 实例应被丢弃，等待按新目录重建")
	}

	// 显式配置 MEDIA_PAGE_CACHE_DIR 时以它为准，不被 cache_dir 覆盖。
	b := &App{
		runtimeConfig:      filepath.Join(dir, "runtime2.json"),
		cacheDir:           old,
		pageCacheDir:       filepath.Join(dir, "pinned"),
		pageCacheDirPinned: true,
		cacheWake:          make(chan struct{}, 1),
	}
	if err := b.saveRuntimeConfig(cfg); err != nil {
		t.Fatalf("saveRuntimeConfig(pinned): %v", err)
	}
	if b.pageCacheDir != filepath.Join(dir, "pinned") {
		t.Fatalf("显式配置时 pageCacheDir 被改成了 %q", b.pageCacheDir)
	}
}
