package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v0.9.67 归档页转码缓存：键稳定性、命中、LRU 淘汰、重启重建、禁用开关。

func TestPageCacheKeyStabilityAndSensitivity(t *testing.T) {
	a := pageCacheKey("lib1", "/mh/x.zip", "01.jpg", 100, 200, 1600, 82)
	b := pageCacheKey("lib1", "/mh/x.zip", "01.jpg", 100, 200, 1600, 82)
	if a != b {
		t.Fatalf("同参数应产生相同键: %s vs %s", a, b)
	}
	if len(a) != 40 {
		t.Fatalf("期望 sha1 十六进制键（40 字符），得到 %d", len(a))
	}
	cases := []struct {
		name string
		key  string
	}{
		{"归档路径变化", pageCacheKey("lib1", "/mh/y.zip", "01.jpg", 100, 200, 1600, 82)},
		{"条目变化", pageCacheKey("lib1", "/mh/x.zip", "02.jpg", 100, 200, 1600, 82)},
		{"归档 size 变化", pageCacheKey("lib1", "/mh/x.zip", "01.jpg", 101, 200, 1600, 82)},
		{"归档 mtime 变化", pageCacheKey("lib1", "/mh/x.zip", "01.jpg", 100, 201, 1600, 82)},
		{"宽度变化", pageCacheKey("lib1", "/mh/x.zip", "01.jpg", 100, 200, 1280, 82)},
		{"质量变化", pageCacheKey("lib1", "/mh/x.zip", "01.jpg", 100, 200, 1600, 70)},
		{"库变化", pageCacheKey("lib2", "/mh/x.zip", "01.jpg", 100, 200, 1600, 82)},
	}
	for _, c := range cases {
		if c.key == a {
			t.Fatalf("%s 应改变缓存键（否则会读到脏数据）", c.name)
		}
	}
}

func TestPageCachePutGetEvict(t *testing.T) {
	dir := t.TempDir()
	// 配额 1000 字节，写入 3 个 400 字节对象 → 必须淘汰到配额内。
	c := newPageCache(dir, 1000)
	if !c.enabled() {
		t.Fatal("缓存应处于启用状态")
	}
	payload := make([]byte, 400)
	keys := []string{strings.Repeat("a",40), strings.Repeat("b",40), strings.Repeat("c",40)}
	for i, k := range keys {
		payload[0] = byte('A' + i)
		if _, ok := c.put(k, payload, "jpg"); !ok {
			t.Fatalf("写入 %s 失败", k[:2])
		}
	}
	count, total, _, _ := c.stats()
	if total > 1000 {
		t.Fatalf("总占用 %d 超配额 1000", total)
	}
	if count == 0 {
		t.Fatal("淘汰过度：缓存里应至少保留最近写入的条目")
	}
	// 最后写入的必须命中
	if _, ok := c.get(keys[2]); !ok {
		t.Fatal("最近写入的条目应命中")
	}
}

func TestPageCacheRescanAndTmpCleanup(t *testing.T) {
	dir := t.TempDir()
	c := newPageCache(dir, 1<<20)
	key := strings.Repeat("d", 40)
	if _, ok := c.put(key, []byte("hello"), "jpg"); !ok {
		t.Fatal("写入失败")
	}
	// 人为丢一个半成品文件进去：重建时必须被清理
	shard := filepath.Join(dir, key[:2])
	if err := os.WriteFile(filepath.Join(shard, key+"jpg.tmp"), []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}
	c2 := newPageCache(dir, 1<<20)
	if _, ok := c2.get(key); !ok {
		t.Fatal("重建索引后应仍能命中已缓存条目")
	}
	if _, err := os.Stat(filepath.Join(shard, key+"jpg.tmp")); !os.IsNotExist(err) {
		t.Fatal("重建时应清理 .tmp 半成品")
	}
}

func TestPageCacheDisabledWhenZeroQuota(t *testing.T) {
	c := newPageCache(t.TempDir(), 0)
	if c.enabled() {
		t.Fatal("配额为 0 时必须禁用（保证请求侧回落直出）")
	}
	if _, ok := c.put(strings.Repeat("e", 40), []byte("x"), "jpg"); ok {
		t.Fatal("禁用状态不应写入")
	}
	if _, ok := c.get(strings.Repeat("e", 40)); ok {
		t.Fatal("禁用状态不应命中")
	}
}

func TestPageCacheDetectsExternalRemoval(t *testing.T) {
	dir := t.TempDir()
	c := newPageCache(dir, 1<<20)
	key := strings.Repeat("f", 40)
	path, ok := c.put(key, []byte("data"), "jpg")
	if !ok {
		t.Fatal("写入失败")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.get(key); ok {
		t.Fatal("文件被外部删除后不应再命中（否则会下发空响应）")
	}
}
