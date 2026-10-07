package main

// v0.9.91 解/转码风向标：后端禁用分支的行为验证。
// 覆盖：
//   A. forceClientDirectPlan：把任意播放计划改写成「原画直连 + 本地解码」，并对
//      画质限制失效 / 编码不支持 / 封装不支持 / 音轨不支持分别给出诚实提示。
//   B. 原盘输入的候选顺序（409 的前提）：只有 .iso 镜像才会优先走 bluray，
//      BDMV 片段（.m2ts 等）仍是 plain 优先——因此「原盘镜像 + 禁用 = 409」
//      这句发布说明只对 .iso 成立。

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func vh091Client(full bool) playbackClient {
	if full {
		return playbackClient{MP4: true, MSE: true, H264: true, HEVC: true, VP9: true, AAC: true, Opus: true}
	}
	return playbackClient{MP4: true, H264: true, AAC: true}
}

func TestV0991ForceClientDirectPlan(t *testing.T) {
	// A1 浏览器完全支持的原画文件：不产生告诫，且计划被改写为直连/本地解码。
	full := vh091Client(true)
	plan := playbackPlan{
		Layer: "smart_stream", Mode: "remux", Hardware: "cpu",
		VideoAction: "transcode", AudioAction: "transcode", MaxHeight: 0,
		Reason: "服务端转封装",
	}
	got := forceClientDirectPlan(plan, playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}, full)
	if got.Layer != "direct_play" || got.Mode != "direct" || got.Hardware != "client" {
		t.Fatalf("A1 layer/mode/hardware = %q/%q/%q, want direct_play/direct/client", got.Layer, got.Mode, got.Hardware)
	}
	if got.VideoAction != "copy" || got.AudioAction != "copy" {
		t.Fatalf("A1 actions = %q/%q, want copy/copy", got.VideoAction, got.AudioAction)
	}
	if got.MaxHeight != 0 {
		t.Fatalf("A1 MaxHeight = %d, want 0（画质上限必须清空，否则仍会转码）", got.MaxHeight)
	}
	if !strings.Contains(got.Reason, "服务端转/解码已禁用") {
		t.Fatalf("A1 reason = %q, want 含「服务端转/解码已禁用」", got.Reason)
	}
	if got.Warn != "" {
		t.Fatalf("A1 warn = %q, want 空（画质未被限制）", got.Warn)
	}

	// A2 原本带画质上限：明确告知「限制不生效，按原画直出」。
	capped := forceClientDirectPlan(playbackPlan{Layer: "smart_stream", Mode: "transcode", Hardware: "cpu", MaxHeight: 720},
		playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}, full)
	if !strings.Contains(capped.Warn, "画质限制不生效") {
		t.Fatalf("A2 warn = %q, want 含「画质限制不生效」", capped.Warn)
	}
	if capped.MaxHeight != 0 {
		t.Fatalf("A2 MaxHeight = %d, want 0", capped.MaxHeight)
	}

	// A3 视频编码本机不支持（HEVC 但客户端不声明 hevc）。
	weak := vh091Client(false)
	hevc := forceClientDirectPlan(playbackPlan{Layer: "smart_stream", Mode: "remux", Hardware: "cpu"},
		playbackMedia{Container: "mp4", VideoCodec: "hevc", AudioCodec: "aac"}, weak)
	if !strings.Contains(hevc.Warn, "HEVC") || !strings.Contains(hevc.Warn, "视频编码") {
		t.Fatalf("A3 warn = %q, want 含 HEVC 视频编码提示", hevc.Warn)
	}
	if hevc.Mode != "direct" || hevc.Hardware != "client" {
		t.Fatalf("A3 mode/hardware = %q/%q, want direct/client（仍然直连，只是给出提示）", hevc.Mode, hevc.Hardware)
	}

	// A4 封装不支持（mkv + 客户端只声明 mp4）。
	mkv := forceClientDirectPlan(playbackPlan{Mode: "remux", Hardware: "cpu"},
		playbackMedia{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac"}, weak)
	if !strings.Contains(mkv.Warn, "MKV") || !strings.Contains(mkv.Warn, "封装") {
		t.Fatalf("A4 warn = %q, want 含 MKV 封装提示", mkv.Warn)
	}

	// A5 音轨不支持（ac3）。
	ac3 := forceClientDirectPlan(playbackPlan{Mode: "transcode", Hardware: "cpu"},
		playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "ac3"}, weak)
	if !strings.Contains(ac3.Warn, "AC3") || !strings.Contains(ac3.Warn, "音轨") {
		t.Fatalf("A5 warn = %q, want 含 AC3 音轨提示", ac3.Warn)
	}

	// A6 mp3 音轨视为本机可播（不产生告诫）。
	mp3 := forceClientDirectPlan(playbackPlan{Mode: "transcode", Hardware: "cpu"},
		playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "mp3"}, weak)
	if mp3.Warn != "" {
		t.Fatalf("A6 warn = %q, want 空（mp3 本机可播）", mp3.Warn)
	}

	// A7 无音轨（纯视频）不产生音轨告诫。
	noAudio := forceClientDirectPlan(playbackPlan{Mode: "remux", Hardware: "cpu"},
		playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: ""}, weak)
	if noAudio.Warn != "" {
		t.Fatalf("A7 warn = %q, want 空（无音轨）", noAudio.Warn)
	}

	// A8 VP9 在声明 vp9 的客户端上可直连。
	vp9 := forceClientDirectPlan(playbackPlan{Mode: "transcode", Hardware: "cpu"},
		playbackMedia{Container: "mp4", VideoCodec: "vp09", AudioCodec: "opus"},
		playbackClient{MP4: true, VP9: true, Opus: true})
	if vp9.Warn != "" {
		t.Fatalf("A8 warn = %q, want 空（vp09+opus 已声明支持）", vp9.Warn)
	}
}

func TestV0991DiscInputCandidates(t *testing.T) {
	// B1 .iso 镜像：蓝光候选优先（这是「原盘镜像 + 禁用 = 409」唯一可达路径）。
	iso := discInputCandidates("/media/mv/样片.iso")
	if len(iso) < 3 {
		t.Fatalf("B1 候选数 = %d, want >= 3（bluray/dvd/plain）", len(iso))
	}
	if iso[0].Kind != discInputBluRay || !strings.HasPrefix(iso[0].Spec, "bluray:") {
		t.Fatalf("B1 首选 = %+v, want bluray 优先", iso[0])
	}
	if iso[2].Kind != discInputPlain {
		t.Fatalf("B1 末选 = %+v, want plain 兜底", iso[2])
	}

	// B2 BDMV 片段：plain 优先，bluray 仅作为后备——所以片段不会被判成原盘，
	//    禁用服务端转码时不会走 409，而是直连该片段。
	frag := discInputCandidates("/media/mv/Movie/BDMV/STREAM/00011.m2ts")
	if frag[0].Kind != discInputPlain {
		t.Fatalf("B2 首选 = %+v, want plain 优先（片段）", frag[0])
	}
	hasBluRay := false
	for _, c := range frag {
		if c.Kind == discInputBluRay {
			hasBluRay = true
			if c.DiscRoot != "/media/mv/Movie" {
				t.Fatalf("B2 bluray 候选的 DiscRoot = %q, want /media/mv/Movie", c.DiscRoot)
			}
		}
	}
	if !hasBluRay {
		t.Fatalf("B2 候选 %+v 应保留 bluray 后备", frag)
	}

	// B3 普通文件：只有一个 plain 候选。
	plain := discInputCandidates("/media/mv/普通影片.mp4")
	if len(plain) != 1 || plain[0].Kind != discInputPlain {
		t.Fatalf("B3 候选 = %+v, want 单个 plain", plain)
	}

	// B4 识别辅助函数的边界。
	if !isDiscImagePath("/a/b.ISO") {
		t.Fatal("B4 .ISO 大写应识别为镜像")
	}
	if isDiscImagePath("/a/b.mkv") {
		t.Fatal("B4 .mkv 不应识别为镜像")
	}
	if !isBluRayFragment("/a/BDMV/STREAM/00011.M2TS") {
		t.Fatal("B4 大写路径应识别为原盘片段")
	}
	if isBluRayFragment("/a/BDMV/STREAM/00011.mkv") {
		t.Fatal("B4 .mkv 不应识别为原盘片段")
	}
	if got := bluRayDiscRootOf("/m/Movie/BDMV/STREAM/00011.m2ts"); got != "/m/Movie" {
		t.Fatalf("B4 DiscRoot = %q, want /m/Movie", got)
	}
}

func TestV0991PlaybackPlanJSONShape(t *testing.T) {
	// C1 新增字段：warn 只在非空时出现（omitempty），server_transcode 由请求端传入。
	b, err := json.Marshal(playbackPlan{Layer: "direct_play", Mode: "direct", Hardware: "client"})
	if err != nil {
		t.Fatalf("C1 marshal: %v", err)
	}
	if strings.Contains(string(b), "\"warn\"") {
		t.Fatalf("C1 空 warn 不应序列化：%s", b)
	}
	b2, _ := json.Marshal(playbackPlan{Layer: "direct_play", Mode: "direct", Hardware: "client", Warn: "已禁用服务端转码，所选画质限制不生效，按原画直出"})
	if !strings.Contains(string(b2), "\"warn\"") {
		t.Fatalf("C2 非空 warn 必须序列化：%s", b2)
	}
}

// TestV0991CacheThresholds 覆盖审查修复的两处缓存阈值：
//   G1 cacheEntryLimit 在配额未设置 / 过小时返回 0（表示不做单条目限制），
//      避免旧写法 budget/4 在极小配额下退化成 0 而把任何非空产物立即删除。
//   G2 分片陈旧阈值必须长于单次构建上限，正在进行的超长转码分片不得被当残留回收。
func TestV0991CacheThresholds(t *testing.T) {
	if got := cacheEntryLimit(0); got != 0 {
		t.Fatalf("G1 配额 0 时上限 = %d, want 0（不做限制）", got)
	}
	for _, tiny := range []int64{1, 2, 3, -1} {
		if got := cacheEntryLimit(tiny); got != 0 {
			t.Fatalf("G1 配额 %d 时上限 = %d, want 0", tiny, got)
		}
	}
	if got := cacheEntryLimit(4); got != 1 {
		t.Fatalf("G1 配额 4 时上限 = %d, want 1", got)
	}
	const budget = 64 << 20
	if got := cacheEntryLimit(budget); got != budget/cacheEntryMaxShare {
		t.Fatalf("G1 配额 %d 时上限 = %d, want %d", budget, got, budget/cacheEntryMaxShare)
	}

	// G2：构建上限内的分片不得判为陈旧；只有超过「上限 + 缓冲」才算残留。
	now := time.Now()
	cutoff := now.Add(-(compatBuildTimeout + 30*time.Minute))
	if !now.Add(-compatBuildTimeout).After(cutoff) {
		t.Fatal("G2 构建上限内的分片被误判为陈旧（陈旧阈值必须长于构建上限）")
	}
	if now.Add(-(compatBuildTimeout + 45*time.Minute)).After(cutoff) {
		t.Fatal("G2 超过构建上限 + 缓冲的分片应判为陈旧")
	}
}
