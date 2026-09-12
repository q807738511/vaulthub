package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/* v0.9.67 回归测试（第二轮）：独立安全审查发现的其余三项。
   A2 条件请求曾用子串包含判断 → 无关标签也返回 304。
   A3/B1 转码无全局并发上限 + 像素上限过宽 → 并发请求可把容器内存打爆。
   A4 歌词标签解析曾整文件读入 → 大文件放进音乐库即可打爆内存。
*/

func TestIfNoneMatchExactMatchOnly(t *testing.T) {
	const key = "0123456789abcdef0123456789abcdef01234567"
	cases := []struct {
		header string
		want   bool
	}{
		{`"` + key + `"`, true},
		{`W/"` + key + `"`, true},
		{"*", true},
		{`"aaaa", "` + key + `"`, true},
		{`"othertag` + key + `junk"`, false}, // 子串包含不是命中（旧实现会误判 304）
		{`"` + key + `x"`, false},
		{`"aaaa", "bbbb"`, false},
		{"", false},
		{`W/"other"`, false},
	}
	for _, c := range cases {
		if got := ifNoneMatchSatisfied(c.header, key); got != c.want {
			t.Fatalf("If-None-Match=%q 期望 %v，得到 %v", c.header, c.want, got)
		}
	}
}

func TestTranscodeConcurrencyGateBoundedAndNonBlocking(t *testing.T) {
	var a App
	// 闸门容量必须有限且不超过 3（内存上限的硬约束）
	release1, ok1 := a.acquireTranscode(context.Background())
	if !ok1 {
		t.Fatal("空闲时应立即获得转码许可")
	}
	release2, ok2 := a.acquireTranscode(context.Background())
	if !ok2 {
		t.Fatal("第二个许可应可用（容量 ≥2）")
	}
	release3, _ := a.acquireTranscode(context.Background())
	release4, ok4 := a.acquireTranscode(context.Background())
	if len(a.transcodeSem) > 3 {
		t.Fatalf("并发闸门容量过大（>3）：%d", len(a.transcodeSem))
	}
	// 已取消的请求不应排队等待，而应立即回落（返回 false 由调用方直出）
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if release, ok := a.acquireTranscode(ctx); ok {
		release()
		t.Fatal("上下文已取消时不应拿到许可")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("取消上下文应立即返回，实际耗时 %v", elapsed)
	}
	release1()
	release2()
	if release3 != nil {
		release3()
	}
	if ok4 && release4 != nil {
		release4()
	}
}

func TestReadTagWindowsBoundedMemoryAndFindsTail(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "big.mp4")
	const size = 32 << 20 // 32MB
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	// 在文件末尾放一个 ©lyr 标记（模拟 moov 原子在尾部的 MP4）
	marker := append([]byte{0xA9, 'l', 'y', 'r'}, make([]byte, 8)...)
	if _, err := f.WriteAt(marker, size-int64(len(marker))-4); err != nil {
		t.Fatal(err)
	}
	f.Close()

	b, err := readTagWindows(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > 2*tagScanWindow {
		t.Fatalf("读取量必须受窗口限制（≤2×8MB），实际 %d 字节", len(b))
	}
	if int64(len(b)) >= size {
		t.Fatalf("不应整文件读入：文件 %d 字节，读取 %d 字节", size, len(b))
	}
	if !strings.Contains(string(b), "\xa9lyr") && !containsBytes(b, []byte{0xA9, 'l', 'y', 'r'}) {
		t.Fatal("尾部窗口应包含文件末尾的 ©lyr 标记")
	}
	// 超过上限的文件直接放弃解析（返回 false），不会分配大内存
	if _, ok := embeddedLyrics(p); ok {
		t.Fatal("无真实歌词的文件不应解析成功")
	}
}

func containsBytes(hay []byte, needle []byte) bool {
	return len(hay) >= len(needle) && strings.Contains(string(hay), string(needle))
}
