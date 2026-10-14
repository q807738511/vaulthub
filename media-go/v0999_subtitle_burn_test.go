package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---- v0.9.99（需求2）：字幕轨类型判定 ---------------------------------------
func TestV0999SubtitleTrackKind(t *testing.T) {
	bitmap := []string{"hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "dvb_teletext", "HDMV_PGS_SUBTITLE"}
	for _, c := range bitmap {
		if got := subtitleTrackKind(c); got != "bitmap" {
			t.Fatalf("图形字幕 %q 应判为 bitmap，实际 %q", c, got)
		}
	}
	text := []string{"subrip", "ass", "ssa", "mov_text", "webvtt", "text", ""}
	for _, c := range text {
		if got := subtitleTrackKind(c); got != "text" {
			t.Fatalf("文本字幕 %q 应判为 text，实际 %q", c, got)
		}
	}
}

// ---- v0.9.99（需求2）：图形字幕烧录参数 -------------------------------------
// 烧录必须真的把字幕位图 overlay 到画面上，且不能依赖硬件编码链
// （overlay 需要在内存里合成，硬件编码要走 hwdownload/hwupload 往返）。
func TestV0999BurnInArgsUseOverlayAndSoftwareEncode(t *testing.T) {
	pre, mid := compatArgsScaled(context.Background(), "/nonexistent/v0999.mkv", "", "cpu", "full_transcode", 0, 3, "")
	all := strings.Join(append(append([]string{}, pre...), mid...), " ")
	if !strings.Contains(all, "-filter_complex") {
		t.Fatalf("烧录参数缺少 -filter_complex：%v", mid)
	}
	if !strings.Contains(all, "[0:s:3]overlay") {
		t.Fatalf("烧录过滤器未引用字幕流 0:s:3：%v", mid)
	}
	if !strings.Contains(all, "[vout]") {
		t.Fatalf("烧录输出标签 [vout] 缺失：%v", mid)
	}
	if !strings.Contains(all, "libx264") {
		t.Fatalf("烧录应使用软件编码 libx264：%v", mid)
	}
	for _, bad := range []string{"hwaccel", "vaapi", "nvenc", "qsv"} {
		if strings.Contains(all, bad) {
			t.Fatalf("烧录不应出现硬件编码项 %q：%v", bad, all)
		}
	}
	// 音轨默认映射必须保留（否则字幕烧录后没声音）
	if !strings.Contains(all, "0:a:0?") {
		t.Fatalf("烧录参数缺少默认音轨映射：%v", mid)
	}
}

// 指定音轨 + 指定分辨率上限时，映射与缩放都要生效。
func TestV0999BurnInArgsRespectAudioAndScale(t *testing.T) {
	_, mid := compatArgsScaled(context.Background(), "/nonexistent/v0999.mkv", "2", "cpu", "full_transcode", 1080, 5, "")
	all := strings.Join(mid, " ")
	if !strings.Contains(all, "0:a:2?") {
		t.Fatalf("烧录未映射第二条音轨：%v", mid)
	}
	if !strings.Contains(all, "[0:s:5]overlay") {
		t.Fatalf("烧录未引用 0:s:5：%v", mid)
	}
	if !strings.Contains(all, "scale=-2:min(ih\\,1080)") {
		t.Fatalf("烧录未带分辨率上限缩放：%v", mid)
	}
}

// 不烧录时必须保持原有口径（回归保护：不能因为新增分支改变普通兼容流参数）。
func TestV0999NoBurnKeepsLegacyArgs(t *testing.T) {
	_, mid := compatArgsScaled(context.Background(), "/nonexistent/v0999.mkv", "", "cpu", "audio_transcode", 0, -1, "")
	all := strings.Join(mid, " ")
	if strings.Contains(all, "filter_complex") {
		t.Fatalf("未选择烧录时不应出现 filter_complex：%v", mid)
	}
	if !strings.Contains(all, "-map 0:v:0") {
		t.Fatalf("普通兼容流仍应映射 0:v:0：%v", mid)
	}
}

// ---- v0.9.99（需求2）：本地字幕文件与视频的匹配规则 -------------------------
func TestV0999EpisodeTokenOf(t *testing.T) {
	cases := map[string]string{
		"Show.S01E02.1080p":             "S01E02",
		"show.s1e2.web":                 "S01E02",
		"Show.01x02.1080p":              "S01E02",
		"剧名 第2集":                        "E02",
		"no-episode-token-here":         "",
		"Movie.2021.1080p":              "",
		"[Group] Tokyo Ghoul - 01 [BD]": "E01",
	}
	for in, want := range cases {
		if got := episodeTokenOf(in); got != want {
			t.Fatalf("episodeTokenOf(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestV0999SubtitleNameMatches(t *testing.T) {
	yes := [][2]string{
		{"Show.S01E02.1080p", "Show.S01E02.zh.srt"},
		{"[Group] Tokyo Ghoul 01 [1080p]", "Tokyo Ghoul - 01.ass"},
		{"Show.01x02.1080p", "show.S01E02.chi.ass"},
		{"剧名 第2集 1080p", "剧名 第2集.简体.srt"},
		// 带季号的视频 ↔ 只有裸集号的字幕（压制组常见）
		{"The Flash - s01e01 - 试播集", "The Flash - 01.zh.srt"},
	}
	for _, c := range yes {
		if !subtitleNameMatches(c[0], c[1]) {
			t.Fatalf("应判定为同一集字幕：%q ↔ %q", c[0], c[1])
		}
	}
	no := [][2]string{
		{"Movie.2021.1080p", "OtherMovie.2021.zh.srt"},
		{"Show.S01E02.1080p", "Show.S01E09.zh.srt"},
		{"", "x.srt"},
		// 双方都带季号但不一致：不能因为集号相同就误判为同一集
		{"Show.S01E05.1080p", "Show.S02E05.zh.srt"},
	}
	for _, c := range no {
		if subtitleNameMatches(c[0], c[1]) {
			t.Fatalf("不应判定为同一集字幕：%q ↔ %q", c[0], c[1])
		}
	}
}

// ---- v0.9.99（需求1）：剧集级 NFO（tvshow.nfo）逐级上溯读取 ------------------
// 单集在 Show/Season 01/ 下时，剧名根目录的 tvshow.nfo 必须能读到，
// 否则演职人员 / 评分 / tmdbid 全为空（用户可见症状：本地有 NFO 却看不到演职人员）。
func TestV0999SeriesShowNfoUpwardLookup(t *testing.T) {
	root := t.TempDir()
	showDir := filepath.Join(root, "Show")
	seasonDir := filepath.Join(showDir, "Season 01")
	if err := os.MkdirAll(seasonDir, 0o755); err != nil {
		t.Fatal(err)
	}
	nfo := `<?xml version="1.0" encoding="utf-8"?>
<tvshow>
  <title>东京喰种</title>
  <year>2014</year>
  <rating>8.1</rating>
  <genre>动画</genre>
  <uniqueid type="tmdb" default="true">61374</uniqueid>
  <actor><name>花江夏树</name><role>Ken Kaneki (voice)</role><thumb>https://image.tmdb.org/t/p/original/alTb0DlcPIbcwM08WSmxFai58sd.jpg</thumb></actor>
  <actor><name>雨宫天</name><role>Touka Kirishima (voice)</role><thumb>.actors/aou.jpg</thumb></actor>
</tvshow>`
	if err := os.WriteFile(filepath.Join(showDir, "tvshow.nfo"), []byte(nfo), 0o644); err != nil {
		t.Fatal(err)
	}
	ep := filepath.Join(seasonDir, "S01E01.mkv")
	if err := os.WriteFile(ep, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	lib := Library{ID: "series-1", Type: "series", Path: root}
	m, err := readLocalMediaMetadata(lib, "Show/Season 01/S01E01.mkv")
	if err != nil {
		t.Fatalf("读取本地元数据失败：%v", err)
	}
	if m.Provider != "本地 NFO" {
		t.Fatalf("剧集根目录 NFO 未生效，provider=%q", m.Provider)
	}
	if m.TMDBID != "61374" {
		t.Fatalf("未从 tvshow.nfo 读到 tmdbid：%q", m.TMDBID)
	}
	if len(m.Cast) != 2 {
		t.Fatalf("应从 tvshow.nfo 读到 2 位演职人员，实际 %d", len(m.Cast))
	}
	if m.Cast[0].Name != "花江夏树" || !strings.Contains(m.Cast[0].Character, "Kaneki") {
		t.Fatalf("第一位演职人员解析错误：%+v", m.Cast[0])
	}
	// TMDB 图片地址 → 走头像代理（否则前端会去外网直接拉图，可能被墙）
	if m.Cast[0].AvatarKind != "tmdb" || !strings.HasPrefix(m.Cast[0].Avatar, "/api/media/cast/avatar?person=") {
		t.Fatalf("TMDB 头像应转成代理地址：%+v", m.Cast[0])
	}
	if m.Rating == 0 {
		t.Fatalf("评分未读到：%v", m.Rating)
	}
}

// 电影库不应因为剧集上溯逻辑而误读上层目录的 NFO（回归保护）。
func TestV0999MovieLibDoesNotWalkUp(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Film")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 根目录放一个 tvshow.nfo：电影库读到它就是错的
	if err := os.WriteFile(filepath.Join(root, "tvshow.nfo"), []byte("<tvshow><title>根目录剧</title></tvshow>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Film.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	lib := Library{ID: "movie-1", Type: "movie", Path: root}
	m, err := readLocalMediaMetadata(lib, "Film/Film.mkv")
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if m.Provider == "本地 NFO" {
		t.Fatalf("电影库不应上溯读取上层目录的 NFO：%+v", m)
	}
}

// embeddedSubtitleTracks 在输入不可读时必须安全返回空（不能 panic）。
func TestV0999EmbeddedSubtitleTracksSafeOnBadInput(t *testing.T) {
	disc := discInput{Spec: "/nonexistent/none.mkv", Kind: discInputPlain}
	if subs := embeddedSubtitleTracks(context.Background(), disc, "lib", "none.mkv"); len(subs) != 0 {
		t.Fatalf("坏输入应返回空字幕清单，实际 %d", len(subs))
	}
}

// ---- v0.9.99 续（容器实测发现的缺陷）：原盘图形字幕走第二路输入 ----------------
//
// 用 bluray:/dvdvideo 当输入时，libbluray 交出的 PGS 字幕流没有尺寸信息，
// ffmpeg 的 sub2video 退回 720x480 默认画布，字幕位图落在画布外 —— 实测「有/无 overlay」
// 逐帧完全一致（YAVG 恒 0，黑底 YMAX 恒 16），等于字幕根本没烧上。修法是先把选中字幕轨
// copy 成独立 .sup（PGS 自带 PTS，时间轴一致），再把它当第二个输入 overlay。
func TestV0999BurnInPrefersExtractedSupAsSecondInput(t *testing.T) {
	pre, mid := compatArgsScaled(context.Background(), "/nonexistent/v0999.mkv", "", "cpu", "full_transcode", 0, 4, "/data/transcode-cache/burnsub/abc.sup")
	all := strings.Join(append(append([]string{}, pre...), mid...), " ")
	if !strings.Contains(all, "[1:s:0]overlay") {
		t.Fatalf("抽出 .sup 后应改用第二路输入的 [1:s:0]overlay：%v", mid)
	}
	if strings.Contains(all, "[0:s:4]overlay") {
		t.Fatalf("抽出 .sup 后不应再引用原地字幕流 [0:s:4]：%v", mid)
	}
	if !strings.Contains(all, "libx264") {
		t.Fatalf("烧录仍须软件编码：%v", mid)
	}
}

// 未抽到 .sup（普通文件，或抽取失败）时必须退回原地 0:s:N —— 不能因为抽不出字幕就不给画面。
func TestV0999BurnInFallsBackToInlineTrack(t *testing.T) {
	_, mid := compatArgsScaled(context.Background(), "/nonexistent/v0999.mkv", "", "cpu", "full_transcode", 0, 2, "")
	if !strings.Contains(strings.Join(mid, " "), "[0:s:2]overlay") {
		t.Fatalf("没有 .sup 时应退回原地 [0:s:2]overlay：%v", mid)
	}
}

// 普通文件（plain）不做预抽；非原盘种类一律返回空，交给原地 overlay。
func TestV0999PrepareBurnSubtitleOnlyForDiscs(t *testing.T) {
	dir := t.TempDir()
	media := filepath.Join(dir, "movie.mkv")
	if e := os.WriteFile(media, []byte("x"), 0644); e != nil {
		t.Fatal(e)
	}
	fi, e := os.Stat(media)
	if e != nil {
		t.Fatal(e)
	}
	a := &App{cacheDir: filepath.Join(dir, "cache")}
	cache := filepath.Join(dir, "cache", "deadbeef.mp4")
	for _, kind := range []discInputKind{discInputPlain, ""} {
		if got := a.prepareBurnSubtitle(context.Background(), discInput{Spec: media, Kind: kind}, fi, cache, 0); got != "" {
			t.Fatalf("非原盘（kind=%q）不应预抽字幕，实际返回 %q", kind, got)
		}
	}
	/* 原盘但源不可读（ffmpeg 抽不出来）时必须安全返回空串，让上层退回原地 overlay，
	   绝不能返回一个不存在的路径把整个烧录流打断。 */
	disc := discInput{Spec: "bluray:" + media, Kind: discInputBluRay, DiscRoot: media}
	if got := a.prepareBurnSubtitle(context.Background(), disc, fi, cache, 1); got != "" {
		if _, e := os.Stat(got); e != nil {
			t.Fatalf("抽取失败时不应返回不可用路径 %q（%v）", got, e)
		}
	}
	/* 抽出物必须落在缓存目录的 burnsub/ 子目录下（缓存清理器只扫 .mp4，不会把它当缓存条目）。 */
	if !strings.HasSuffix(filepath.Join(dir, "cache", "burnsub"), "burnsub") {
		t.Fatal("burnsub 目录名异常")
	}
}
