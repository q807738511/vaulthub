package main

import (
	"context"
	"testing"
	"time"
)

/* v0.9.93：客户反馈「播放器关闭/停止播放后后台还有数据在跑」。
   根因是后台预转码用 context.Background() 起 ffmpeg —— 前台流结束了它还在转。
   下面三个用例锁住修复后的行为契约。 */

func vh093ResetCompatState() {
	compatMu.Lock()
	compatBuilds = map[string]*compatBuildState{}
	compatWatchers = map[string]int{}
	compatMu.Unlock()
}

// 还有人在看时不能取消；最后一个观看者离开后必须立刻取消。
func TestV0993ReleaseWatcherCancelsBuildOnlyWhenIdle(t *testing.T) {
	vh093ResetCompatState()
	const cache = "/data/transcode-cache/aa/bb.mp4"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	compatBuilds[cache] = &compatBuildState{cancel: cancel, mediaPath: "/media/Show/S01E01.mkv"}

	noteCompatWatcher(cache)
	noteCompatWatcher(cache)
	releaseCompatWatcher(cache)
	select {
	case <-ctx.Done():
		t.Fatal("还有 1 个观看者时不应取消后台预转码")
	default:
	}
	releaseCompatWatcher(cache)
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("最后一个观看者离开后应取消后台预转码（否则关掉播放器后 ffmpeg 仍在跑）")
	}
	if _, ok := compatWatchers[cache]; ok {
		t.Fatal("观看者计数应被清空")
	}
}

// 「停止播放」要按库内相对路径后缀匹配到绝对路径的构建任务。
func TestV0993CancelBuildsForMediaSuffixMatch(t *testing.T) {
	vh093ResetCompatState()
	ctxA, cancelA := context.WithCancel(context.Background())
	ctxB, cancelB := context.WithCancel(context.Background())
	ctxC, cancelC := context.WithCancel(context.Background())
	defer cancelB()
	defer cancelC()
	compatBuilds["/data/cache/a.mp4"] = &compatBuildState{cancel: cancelA, mediaPath: "/media/剧集/Show Name/Season 01/S01E01.mkv"}
	compatBuilds["/data/cache/b.mp4"] = &compatBuildState{cancel: cancelB, mediaPath: "/media/剧集/Other Show/S01E01.mkv"}
	compatBuilds["/data/cache/c.mp4"] = &compatBuildState{cancel: cancelC, mediaPath: "/media/剧集/Show Name/Season 01/S01E02.mkv"}

	n := cancelCompatBuildsForMedia("Show Name/Season 01/S01E01.mkv")
	if n != 1 {
		t.Fatalf("应只取消 1 个匹配的构建，实际 %d", n)
	}
	select {
	case <-ctxA.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("匹配到的构建应被取消")
	}
	select {
	case <-ctxB.Done():
		t.Fatal("同名不同目录的剧不应被误取消")
	default:
	}
	select {
	case <-ctxC.Done():
		t.Fatal("同一部剧的其它分集不应被误取消")
	default:
	}
}

// 并发上限：已在跑的数量达到上限时不再新起后台转码。
func TestV0993BuildConcurrencyCapSkips(t *testing.T) {
	vh093ResetCompatState()
	for i := 0; i < compatBuildMaxConcurrent; i++ {
		_, cancel := context.WithCancel(context.Background())
		compatBuilds[string(rune('a'+i))+".mp4"] = &compatBuildState{cancel: cancel, mediaPath: "/media/x.mkv"}
	}
	a := &App{}
	// 达到上限：必须直接返回，不注册新任务（也就不会起 ffmpeg）。
	a.buildCompatCache(context.Background(), discInput{Spec: "/media/y.mkv", Kind: "file"}, "/data/cache/new.mp4", "", "auto", "full_transcode", 0)
	compatMu.Lock()
	n := len(compatBuilds)
	_, added := compatBuilds["/data/cache/new.mp4"]
	compatMu.Unlock()
	if added || n != compatBuildMaxConcurrent {
		t.Fatalf("并发上限内不应新增构建：n=%d added=%v", n, added)
	}
}
