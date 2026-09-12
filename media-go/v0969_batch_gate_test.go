package main

import "testing"

/* v0.9.69：批量歌词闸门（闭包释放）的正确性。
   审查指出早先的实现用「独立 endLyricsBatch() + select/default」：
   任何一次非持有者的 end 都会清空持有者令牌，让两个批量同时跑。
   这里验证闭包模式：只有取得令牌的那次调用能释放它，且配对无误。 */

func TestLyricsBatchGateClosurePairing(t *testing.T) {
	var a App
	a.lyricsBatchSem = make(chan struct{}, 1)

	release1, ok1 := a.beginLyricsBatch()
	if !ok1 {
		t.Fatal("空闲时首个批量应取得令牌")
	}
	if _, ok := a.beginLyricsBatch(); ok {
		t.Fatal("持有期间第二个批量必须被拒（对应 429 分支）")
	}
	release1()
	release2, ok2 := a.beginLyricsBatch()
	if !ok2 {
		t.Fatal("释放后应可再次取得令牌")
	}
	release2()
	select {
	case <-a.lyricsBatchSem:
		t.Fatal("释放后闸门应清空（否则令牌泄漏，配额被永久占用）")
	default:
	}
}

func TestLyricsBatchGateUninitializedFailsClosed(t *testing.T) {
	// 未初始化（如测试里直接 new(App) 打端点）时必须 fail-closed：拿到 false → 端点回 429，
	// 而不是 panic 或放行。
	var a App
	if _, ok := a.beginLyricsBatch(); ok {
		t.Fatal("未初始化闸门必须拒绝而不是放行")
	}
}
