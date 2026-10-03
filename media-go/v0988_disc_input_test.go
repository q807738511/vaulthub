package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

/* v0.9.88：原盘（ISO / BDMV）输入解析。
   实测依据（容器内 ffmpeg 7.1.5 + libbluray + libudfread）：
     · ffprobe bluray:/x.iso 能读 UDF 蓝光镜像（ISO9660 镜像会报 failed opening UDF image）；
     · ffprobe -f dvdvideo /x.iso 读 DVD 镜像；
     · 旧实现把 .iso 当普通文件，读到的是镜像裸字节。 */

func v0988FakeRunner(accept map[discInputKind]bool, calls *int32) func(context.Context, discInput) bool {
	return func(_ context.Context, in discInput) bool {
		if calls != nil {
			atomic.AddInt32(calls, 1)
		}
		return accept[in.Kind]
	}
}

func v0988TempISO(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "黑鹰坠落.Blu-ray.1080p.iso")
	if err := os.WriteFile(p, []byte("iso-fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestV0988DiscInputCandidates(t *testing.T) {
	iso := discInputCandidates("/media/MO/黑鹰坠落/黑鹰坠落.iso")
	if len(iso) != 3 {
		t.Fatalf("iso candidates=%d", len(iso))
	}
	if iso[0].Kind != discInputBluRay || !strings.HasPrefix(iso[0].Spec, "bluray:/media/MO/") {
		t.Fatalf("iso first candidate=%+v", iso[0])
	}
	if iso[1].Kind != discInputDVD || iso[1].Spec != "/media/MO/黑鹰坠落/黑鹰坠落.iso" {
		t.Fatalf("iso second candidate=%+v", iso[1])
	}
	if iso[2].Kind != discInputPlain {
		t.Fatalf("iso last candidate must be the raw file: %+v", iso[2])
	}

	frag := "/media/MO/黑鹰坠落/BDMV/STREAM/00011.m2ts"
	cands := discInputCandidates(frag)
	if len(cands) != 2 || cands[0].Kind != discInputPlain || cands[0].Spec != frag {
		t.Fatalf("bdmv fragment must keep the proven fragment path first: %+v", cands)
	}
	if cands[1].Kind != discInputBluRay || cands[1].Spec != "bluray:/media/MO/黑鹰坠落" || cands[1].DiscRoot == "" {
		t.Fatalf("bdmv fallback=%+v", cands[1])
	}

	plain := discInputCandidates("/media/MO/普通电影/Resume.Test.2019.mp4")
	if len(plain) != 1 || plain[0].Kind != discInputPlain {
		t.Fatalf("plain file must not get extra candidates: %+v", plain)
	}
}

func TestV0988BluRayDiscRootAndDetectors(t *testing.T) {
	if got := bluRayDiscRootOf("/media/MO/黑鹰坠落/BDMV/STREAM/00011.m2ts"); got != "/media/MO/黑鹰坠落" {
		t.Fatalf("root=%q", got)
	}
	if got := bluRayDiscRootOf("BDMV/STREAM/00011.m2ts"); got != "" {
		t.Fatalf("relative path must not produce a root: %q", got)
	}
	if got := bluRayDiscRootOf("/media/MO/x.mp4"); got != "" {
		t.Fatalf("non-disc=%q", got)
	}
	if !isDiscImagePath("/media/MO/片/片.ISO") {
		t.Fatal("uppercase ISO not detected")
	}
	if !isBluRayFragment("/media/MO/片/BDMV/Stream/00011.M2TS") {
		t.Fatal("fragment (case-insensitive) not detected")
	}
	if isBluRayFragment("/media/MO/片/00011.m2ts") {
		t.Fatal("a loose m2ts outside BDMV/STREAM is not a disc fragment")
	}
}

func TestV0988ResolveDiscInputChainAndCache(t *testing.T) {
	oldRunner := discProbeRunner
	defer func() { discProbeRunner = oldRunner }()
	defer resetDiscInputCache()

	iso := v0988TempISO(t)

	// ① 蓝光镜像可读 → 直接用 bluray:（只探测一次）。
	var calls int32
	resetDiscInputCache()
	discProbeRunner = v0988FakeRunner(map[discInputKind]bool{discInputBluRay: true}, &calls)
	a := &App{}
	got := a.resolveDiscInput(context.Background(), iso)
	if got.Kind != discInputBluRay || got.Spec != "bluray:"+iso {
		t.Fatalf("chain①=%+v", got)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("chain① probes=%d want 1", n)
	}
	// ② 再问一次：命中缓存，不再探测。
	if again := a.resolveDiscInput(context.Background(), iso); again.Spec != got.Spec {
		t.Fatalf("cache miss: %+v", again)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("cache not used, probes=%d", n)
	}

	// ② 蓝光读不了（例如 ISO9660 镜像）→ 退回 dvdvideo。
	calls = 0
	resetDiscInputCache()
	discProbeRunner = v0988FakeRunner(map[discInputKind]bool{discInputDVD: true}, &calls)
	got = (&App{}).resolveDiscInput(context.Background(), iso)
	if got.Kind != discInputDVD {
		t.Fatalf("chain②=%+v", got)
	}
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("chain② probes=%d want 2", n)
	}

	// ③ 全部读不了 → 退回裸文件（而不是报错），并缓存该结论。
	calls = 0
	resetDiscInputCache()
	discProbeRunner = v0988FakeRunner(nil, &calls)
	got = (&App{}).resolveDiscInput(context.Background(), iso)
	if got.Kind != discInputPlain || got.Spec != iso {
		t.Fatalf("chain③=%+v", got)
	}
	_ = (&App{}).resolveDiscInput(context.Background(), iso)
	if n := atomic.LoadInt32(&calls); n != 3 {
		t.Fatalf("failed chain must be cached too, probes=%d", n)
	}

	// ④ BDMV 片段：原片段可读 → 维持既有行为（不引入额外探测开销）。
	dir := t.TempDir()
	frag := filepath.Join(dir, "BDMV", "STREAM", "00011.m2ts")
	if err := os.MkdirAll(filepath.Dir(frag), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(frag, []byte("m2ts"), 0o644); err != nil {
		t.Fatal(err)
	}
	calls = 0
	resetDiscInputCache()
	discProbeRunner = v0988FakeRunner(map[discInputKind]bool{discInputPlain: true}, &calls)
	got = (&App{}).resolveDiscInput(context.Background(), frag)
	if got.Kind != discInputPlain || got.Spec != frag {
		t.Fatalf("chain④=%+v", got)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("chain④ probes=%d want 1", n)
	}

	// ⑤ 片段读不了 → 退回原盘根（bluray:），并带上 DiscRoot。
	calls = 0
	resetDiscInputCache()
	discProbeRunner = v0988FakeRunner(map[discInputKind]bool{discInputBluRay: true}, &calls)
	got = (&App{}).resolveDiscInput(context.Background(), frag)
	if got.Kind != discInputBluRay || got.Spec != "bluray:"+dir || got.DiscRoot != dir {
		t.Fatalf("chain⑤=%+v", got)
	}

	// ⑥ 普通文件：完全不走探测（性能与旧版一致）。
	calls = 0
	resetDiscInputCache()
	discProbeRunner = v0988FakeRunner(nil, &calls)
	plainFile := filepath.Join(dir, "Resume.Test.2019.mp4")
	if err := os.WriteFile(plainFile, []byte("mp4"), 0o644); err != nil {
		t.Fatal(err)
	}
	got = (&App{}).resolveDiscInput(context.Background(), plainFile)
	if got.Kind != discInputPlain || atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("plain file must skip probing: %+v probes=%d", got, calls)
	}
}

func TestV0988DiscProbeHintAndInputArgs(t *testing.T) {
	if got := discProbeHint("/media/MO/片/片.iso"); !strings.Contains(got, "UDF") {
		t.Fatalf("iso hint=%q", got)
	}
	if got := discProbeHint("/media/MO/片/BDMV/STREAM/00011.m2ts"); !strings.Contains(got, "BDMV/STREAM") {
		t.Fatalf("bdmv hint=%q", got)
	}
	if got := discProbeHint("/media/MO/片/片.mp4"); got != "" {
		t.Fatalf("plain file must not get a disc hint: %q", got)
	}
	if args := ffprobeInputArgs(discInputDVD); len(args) != 2 || args[0] != "-f" || args[1] != "dvdvideo" {
		t.Fatalf("dvd args=%v", args)
	}
	if args := ffprobeInputArgs(discInputBluRay); args != nil {
		t.Fatalf("bluray needs no extra args: %v", args)
	}
}

func TestV0988DiscInputCacheKeyChangesWithFile(t *testing.T) {
	p := v0988TempISO(t)
	k1 := discInputCacheKey(p)
	if err := os.WriteFile(p, []byte("iso-fixture-changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	if k2 := discInputCacheKey(p); k2 == k1 {
		t.Fatalf("cache key must change when the image changes: %s", k1)
	}
	if !strings.HasPrefix(k1, filepath.ToSlash(p)+"|") {
		t.Fatalf("unexpected key shape: %s", k1)
	}
}
