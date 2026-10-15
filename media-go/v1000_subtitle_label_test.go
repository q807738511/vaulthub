package main

import (
	"context"
	"os"
	"strings"
	"testing"
)

/* v1.0.0（需求3）：内嵌字幕语言 / 内容识别的单测。
   纯函数部分（语言码映射、标题提示、样本判定）必须逐条钉死；
   subtitleLabelFor 的回落链路用「采不到内容」的输入验证层级顺序。 */

func TestV1000SubLangName(t *testing.T) {
	cases := map[string]string{
		"zho": "中文", "chi": "中文", "zh": "中文", "cmn": "中文",
		"chs": "简体中文", "cht": "繁体中文",
		"eng": "英语", "en": "英语", "jpn": "日语", "kor": "韩语",
		"fra": "法语", "deu": "德语", "spa": "西班牙语",
		"ZH": "中文", "  eng  ": "英语",
		"bul": "保加利亚语", "hrv": "克罗地亚语", "slv": "斯洛文尼亚语", "hun": "匈牙利语",
		"und": "", "": "", "xyz": "",
	}
	for in, want := range cases {
		if got := subLangName(in); got != want {
			t.Errorf("subLangName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestV1000SubtitleTitleHint(t *testing.T) {
	cases := map[string]string{
		"简体中文":            "简体中文",
		"繁體中文":            "繁体中文",
		"繁体中文":            "繁体中文",
		"Chinese Simplified": "简体中文",
		"Traditional Chinese": "繁体中文",
		"中英双语":            "中英双语",
		"ZH+EN":              "中英双语",
		"ENG+CHS":            "中英双语",
		"中文":               "中文",
		"English":            "英语",
		"英文":               "英语",
		"日文":               "日语",
		"Korean":             "韩语",
		"SDH":                "",
		"Extended Cut":       "",  // "en" 不能命中 "extended"（按整词匹配）
		"eng":                "英语",
		"CHS":                "简体中文",
		"CHT":                "繁体中文",
		"sc":                 "简体中文",
		"tc":                 "繁体中文",
		"":                   "",
	}
	for in, want := range cases {
		if got := subtitleTitleHint(in); got != want {
			t.Errorf("subtitleTitleHint(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestV1000SubtitleSampleLabelSimplifiedTraditionalBilingual(t *testing.T) {
	hans := "我们这里说话的时候对大家来说是没有问题的，请你们过来看看这个时间里发生了什么。" +
		"他们从国外回来以后，学校开门关门都会影响到很多人的生活质量与工作时间。"
	hant := "我們這裡說話的時候對大家來說是沒有問題的，請你們過來看看這個時間裡發生了什麼。" +
		"他們從國外回來以後，學校開門關門都會影響到很多人的生活品質與工作時間。"
	mix := "我们在这里说话 People here are talking about the whole thing, 时间 and 问题 are important to everyone."
	eng := "Hello there, this is a subtitle line written in plain English with several words for sampling."
	jpn := "こんにちは、これは日本語の字幕です。"
	kor := "안녕하세요, 이것은 한국어 자막입니다."
	short := "嗯。"

	if got := subtitleSampleLabel(hans); got != "简体中文" {
		t.Errorf("简体样本判定 = %q, want 简体中文", got)
	}
	if got := subtitleSampleLabel(hant); got != "繁体中文" {
		t.Errorf("繁体样本判定 = %q, want 繁体中文", got)
	}
	if got := subtitleSampleLabel(mix); got != "中英双语" {
		t.Errorf("中英混排样本判定 = %q, want 中英双语", got)
	}
	if got := subtitleSampleLabel(eng); got != "英语" {
		t.Errorf("英文样本判定 = %q, want 英语", got)
	}
	if got := subtitleSampleLabel(jpn); got != "日语" {
		t.Errorf("日文样本判定 = %q, want 日语", got)
	}
	if got := subtitleSampleLabel(kor); got != "韩语" {
		t.Errorf("韩文样本判定 = %q, want 韩语", got)
	}
	if got := subtitleSampleLabel(short); got != "" {
		t.Errorf("样本过短应返回空（不瞎猜），得 %q", got)
	}
	if got := subtitleSampleLabel(""); got != "" {
		t.Errorf("空样本应返回空，得 %q", got)
	}
}

func TestV1000SubtitleSampleBufCapsOutput(t *testing.T) {
	buf := &subtitleSampleBuf{max: 16}
	n, err := buf.Write([]byte("0123456789abcdefghij"))
	if err != nil || n != 20 {
		t.Fatalf("Write 应始终吞掉全部字节（n=20, err=nil），得 n=%d err=%v", n, err)
	}
	if buf.String() != "0123456789abcdef" {
		t.Errorf("缓冲应截断到 max=16，得 %q", buf.String())
	}
	_, _ = buf.Write([]byte("XYZ"))
	if len(buf.String()) != 16 {
		t.Errorf("超限后不应继续增长，得 %d 字节", len(buf.String()))
	}
}

func TestV1000SubtitleLabelForFallbackChain(t *testing.T) {
	ctx := context.Background()
	// ① 标题自带语言 → 直接返回，不碰内容采样（ffmpeg 不存在也不会失败）。
	plain := discInput{Spec: "movie.mkv", Kind: discInputPlain, File: "movie.mkv"}
	if got := subtitleLabelFor(ctx, plain, "subrip", "简体中文", "", "", 0); got != "简体中文" {
		t.Errorf("标题优先失败：得 %q", got)
	}
	// ② 标题无语言信息 + 文本轨内容采样失败（文件不存在）→ 回落 language 码。
	if got := subtitleLabelFor(ctx, plain, "subrip", "SDH", "eng", "", 0); got != "英语" {
		t.Errorf("language 码回落失败：得 %q", got)
	}
	// ③ 什么都没有 → 返回空（调用方回落「内嵌字幕 N」）。
	if got := subtitleLabelFor(ctx, plain, "subrip", "", "", "", 0); got != "" {
		t.Errorf("无任何线索应返回空串，得 %q", got)
	}
	// ④ 图形字幕：不做内容采样，language 码优先。
	if got := subtitleLabelFor(ctx, plain, "hdmv_pgs_subtitle", "", "zho", "", 1); got != "中文" {
		t.Errorf("图形字幕 language 回落失败：得 %q", got)
	}
	// ⑤ 图形字幕 + 有信息量的标题（非语言类）→ 原样返回标题。
	if got := subtitleLabelFor(ctx, plain, "hdmv_pgs_subtitle", "Commentary", "", "", 2); got != "Commentary" {
		t.Errorf("图形字幕标题回落失败：得 %q", got)
	}
}

func TestV1000DiscSubtitleLangInfoNeedsBluRayRoot(t *testing.T) {
	ctx := context.Background()
	// 非原盘 / 没有 disc root：直接返回空，不去读盘。
	if got := discSubtitleLangInfo(ctx, discInput{Kind: discInputPlain, Spec: "x.mkv"}); len(got.byPID) != 0 || got.only != "" {
		t.Errorf("非原盘不应回填语言，得 %+v", got)
	}
	if got := discSubtitleLangInfo(ctx, discInput{Kind: discInputBluRay, Spec: "bluray:/nope", DiscRoot: "/nonexistent-disc-root"}); len(got.byPID) != 0 || got.only != "" {
		t.Errorf("目录不存在应返回空，得 %+v", got)
	}
}

// 原盘按 PID 对齐：ffprobe 报的流 id（0x1200/0x1201）与 M2TS 内的 PID 一一对应，
// 因此「bluray: 输入无标签」也能精确回填语言，不靠位置猜。
func TestV1000NormalizeStreamPID(t *testing.T) {
	cases := map[string]string{"0x1201": "1201", "0X1200": "1200", " 0x1202 ": "1202", "1203": "1203", "": ""}
	for in, want := range cases {
		if got := normalizeStreamPID(in); got != want {
			t.Errorf("normalizeStreamPID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestV1000SubtitleSampleCacheKeyedByInputAndTrack(t *testing.T) {
	// 缓存层必须按「输入 + 轨号」分开：同一文件的多条字幕轨不能串台。
	ctx := context.Background()
	d := discInput{Spec: "no-such-file-1000.mkv", Kind: discInputPlain, File: "no-such-file-1000.mkv"}
	first := subtitleSampleCached(ctx, d, 0)
	second := subtitleSampleCached(ctx, d, 0)
	if first != second {
		t.Errorf("同一轨重复采样应命中缓存并保持一致：%q vs %q", first, second)
	}
	other := subtitleSampleCached(ctx, d, 7)
	if other != "" && first != "" && other == first {
		t.Log("两条轨都采不到内容时为同值，属预期（这里主要验证不抛异常、不串键）")
	}
	subLabelMu.Lock()
	size := len(subLabelCache)
	subLabelMu.Unlock()
	if size < 2 {
		t.Errorf("两条不同轨应各自落一条缓存，实际 %d 条", size)
	}
}

func TestV1000SubtitleKindStillSplitsBitmap(t *testing.T) {
	for _, c := range []string{"hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "dvb_teletext"} {
		if subtitleTrackKind(c) != "bitmap" {
			t.Errorf("%s 应判为图形字幕", c)
		}
	}
	for _, c := range []string{"subrip", "ass", "mov_text", "webvtt", "srt"} {
		if subtitleTrackKind(c) != "text" {
			t.Errorf("%s 应判为文本字幕", c)
		}
	}
}

func TestV1000LabelSamplingTimeoutIsBounded(t *testing.T) {
	// 采样必须有上限：断言源码里的 8s 超时，避免将来被改成 0（无限等）或被放大到拖住播放器。
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("读取 media-go/main.go 失败：%v", err)
	}
	if !strings.Contains(string(src), "context.WithTimeout(ctx, 8*time.Second)") {
		t.Error("文本字幕采样超时应收紧到 8s（播放器打开不能被单条字幕轨拖住）")
	}
	if !strings.Contains(string(src), "max: 64 << 10") {
		t.Error("采样上限应为 64 KiB —— 整条字幕轨可能有几十 MB，不能全读")
	}
}
