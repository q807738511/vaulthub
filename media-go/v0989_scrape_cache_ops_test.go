package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

/* v0.9.89：加锁后的读-改-写语义（副本隔离、陈旧不回冲、上限仍然生效）。 */

func TestV0989ScrapeCacheReadIsCopy(t *testing.T) {
	a, _ := newV0989App(t)
	if _, _, _, _, err := a.scrapeCacheMerge("movie1", map[string]scrapeCacheItem{
		"Resume.Test.2019.1080p.mp4": {Title: "水男孩", State: "ok", CheckedAt: 100},
	}, false); err != nil {
		t.Fatalf("merge: %v", err)
	}
	items, _, total, _, err := a.scrapeCacheRead("movie1", 0, 0)
	if err != nil || total != 1 {
		t.Fatalf("read: err=%v total=%d", err, total)
	}
	for k := range items {
		delete(items, k) // 改副本
	}
	items2, _, total2, _, err := a.scrapeCacheRead("movie1", 0, 0)
	if err != nil || total2 != 1 || len(items2) != 1 {
		t.Fatalf("副本被改后缓存不该变：err=%v total=%d len=%d", err, total2, len(items2))
	}

	// 深拷贝：改副本里的 item 也不影响缓存。
	items2["Resume.Test.2019.1080p.mp4"] = scrapeCacheItem{Title: "篡改"}
	items3, _, _, _, _ := a.scrapeCacheRead("movie1", 0, 0)
	if items3["Resume.Test.2019.1080p.mp4"].Title != "水男孩" {
		t.Fatalf("副本写回污染了缓存：%q", items3["Resume.Test.2019.1080p.mp4"].Title)
	}
}

func TestV0989ScrapeCacheMergeKeepsNewer(t *testing.T) {
	a, _ := newV0989App(t)
	path := "Resume.Test.2019.1080p.mp4"
	if _, _, _, _, err := a.scrapeCacheMerge("movie1", map[string]scrapeCacheItem{
		path: {Title: "新标题", State: "ok", CheckedAt: 2000},
	}, false); err != nil {
		t.Fatal(err)
	}
	if _, skipped, _, _, err := a.scrapeCacheMerge("movie1", map[string]scrapeCacheItem{
		path: {Title: "旧标题", State: "ok", CheckedAt: 1000},
	}, false); err != nil || skipped != 1 {
		t.Fatalf("陈旧结果应 skipped：err=%v skipped=%d", err, skipped)
	}
	items, _, _, _, _ := a.scrapeCacheRead("movie1", 0, 0)
	if items[path].Title != "新标题" {
		t.Fatalf("陈旧结果回冲了新结果：%q", items[path].Title)
	}
	// replace=true 时显式重刮必须覆盖。
	if _, _, _, _, err := a.scrapeCacheMerge("movie1", map[string]scrapeCacheItem{
		path: {Title: "重刮标题", State: "ok", CheckedAt: 1000},
	}, true); err != nil {
		t.Fatal(err)
	}
	items, _, _, _, _ = a.scrapeCacheRead("movie1", 0, 0)
	if items[path].Title != "重刮标题" {
		t.Fatalf("replace=true 未覆盖：%q", items[path].Title)
	}
}

func TestV0989ScrapeCacheClearAndReload(t *testing.T) {
	a, cachePath := newV0989App(t)
	if _, _, _, _, err := a.scrapeCacheMerge("movie1", map[string]scrapeCacheItem{
		"Resume.Test.2019.1080p.mp4": {Title: "水男孩", State: "ok", CheckedAt: 100},
	}, false); err != nil {
		t.Fatal(err)
	}
	if n, err := a.scrapeCacheClear("movie1", false); err != nil || n != 1 {
		t.Fatalf("clear: n=%d err=%v", n, err)
	}
	if _, _, total, _, _ := a.scrapeCacheRead("movie1", 0, 0); total != 0 {
		t.Fatalf("清空后 total 应为 0，得到 %d", total)
	}
	// 重新加载（模拟进程重启）后仍是空库，而不是把磁盘上的旧内容带回来。
	b, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	var parsed scrapeCacheFile
	if err := json.Unmarshal(b, &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Libraries) != 0 {
		t.Fatalf("落盘文件应已清空，得到 %v", parsed.Libraries)
	}
	fresh := &App{libs: a.libs, scrapeCachePath: filepath.Join(filepath.Dir(cachePath), "media-scrape-cache.json")}
	if _, _, total, _, err := fresh.scrapeCacheRead("movie1", 0, 0); err != nil || total != 0 {
		t.Fatalf("重启后读取：total=%d err=%v", total, err)
	}
}
