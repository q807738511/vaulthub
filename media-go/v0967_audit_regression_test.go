package main

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

/* v0.9.67 回归测试：由独立安全审查发现的两个缺陷。
   ① put 可能把自己刚写入的条目淘汰掉，却仍返回成功 → 调用方按缓存路径下发 → 用户 404。
   ② endPageJob 先摘 map 再关闭 done，窗口内同 key 会出现第二个 leader（重复解码）。
*/

func TestPutReturnsTrueOnlyWhenFileExists(t *testing.T) {
	dir := t.TempDir()
	// 配额 128 字节，而每次写入 512 字节：任何「写入成功」都必须保证文件真的在。
	c := newPageCache(dir, 128)
	payload := bytes.Repeat([]byte{7}, 512)
	for i := 0; i < 3; i++ {
		key := strings.Repeat(string(rune('a'+i)), 40)
		path, ok := c.put(key, payload, "jpg")
		if !ok {
			continue // 未缓存 → 调用方回落直出，这是允许的
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("put 返回 true 但文件不存在（会变成 404）：%v", err)
		}
		if hit, ok2 := c.get(key); !ok2 {
			t.Fatalf("刚写入的条目应立即命中，得到 %q %v", hit, ok2)
		}
	}
}

func TestEvictNeverDropsFreshEntry(t *testing.T) {
	dir := t.TempDir()
	c := newPageCache(dir, 4096)
	fresh := strings.Repeat("z", 40)
	// 先塞满配额的旧条目
	old := bytes.Repeat([]byte{1}, 3000)
	for i := 0; i < 3; i++ {
		c.put(strings.Repeat(string(rune('m'+i)), 40), old, "jpg")
	}
	// 再写入一个新条目：允许淘汰旧条目，但绝不能淘汰自己
	path, ok := c.put(fresh, bytes.Repeat([]byte{2}, 2000), "jpg")
	if !ok {
		t.Fatal("新条目应写入成功")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("新条目被自己触发的淘汰删除：%v", err)
	}
	if _, ok := c.get(fresh); !ok {
		t.Fatal("新条目必须仍可命中")
	}
}

func TestEndPageJobPublishesResultBeforeClosing(t *testing.T) {
	var a App
	const key = "single-flight-key"
	j1, leader := a.beginPageJob(key)
	if !leader {
		t.Fatal("首个请求应为 leader")
	}
	j2, leader2 := a.beginPageJob(key)
	if leader2 {
		t.Fatal("同 key 的第二个请求不应成为新 leader（否则会重复解码同页）")
	}
	if j2 != j1 {
		t.Fatal("同 key 的等待方必须复用同一 job")
	}
	a.endPageJob(key, j1, "/cache/x.jpg", true)
	select {
	case <-j2.done:
	default:
		t.Fatal("endPageJob 必须关闭 done，否则等待方永久阻塞")
	}
	if j2.file != "/cache/x.jpg" || !j2.ok {
		t.Fatalf("等待方读到的结果必须已写入：file=%q ok=%v", j2.file, j2.ok)
	}
	// 结束后表项必须被摘除，后续请求重新成为 leader（缓存已就绪，通常直接命中）
	j3, leader3 := a.beginPageJob(key)
	if !leader3 {
		t.Fatal("结束后表项应被摘除")
	}
	if j3 == j1 {
		t.Fatal("不应复用已结束的 job")
	}
	a.endPageJob(key, j3, "", false)
}
