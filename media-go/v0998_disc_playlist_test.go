package main

/* v0.9.98 单测：原盘播放菜单（播放列表解析 / 主影片判定 / 播放参数）与
   本地 NFO 演职人员头像（TMDB 图片地址→代理、本地 .actors/ 文件→本地代理）。 */

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/* 真实《黑鹰坠落》BDMV 的 ffprobe -v info 输出（截取关键行，实测原文照抄）。 */
const v0998RealBluRayLog = `[bluray @ 0x5579a2b65840] 8 usable playlists:
[bluray @ 0x5579a2b65840] playlist 00012.mpls (2:29:17)
[bluray @ 0x5579a2b65840] playlist 00004.mpls (2:23:42)
[bluray @ 0x5579a2b65840] playlist 00006.mpls (0:29:56)
[bluray @ 0x5579a2b65840] playlist 00005.mpls (0:23:11)
[bluray @ 0x5579a2b65840] playlist 00008.mpls (0:17:57)
[bluray @ 0x5579a2b65840] selected 00012.mpls
bluray.c:299: 00006.m2ts: no timestamp for SPN 0 (got 0). clip 27000000-89596033.
duration=8957.0`

func TestV0998DiscPlaylistParseRealBluRayLog(t *testing.T) {
	items, selected := discPlaylistsFromLog(v0998RealBluRayLog)
	if len(items) != 5 {
		t.Fatalf("应解析出 5 个播放列表，实际 %d：%+v", len(items), items)
	}
	if selected != 12 {
		t.Fatalf("selected 应解析为 12，实际 %d", selected)
	}
	items = finalizeDiscPlaylists(items, selected)
	if !items[0].Main {
		t.Fatalf("最长者应为主影片：%+v", items[0])
	}
	if items[0].Ref != 12 || items[0].DurationText != "2:29:17" {
		t.Fatalf("主影片应为 00012 / 2:29:17，实际 %+v", items[0])
	}
	if items[0].Label != "主影片" {
		t.Fatalf("主影片标签错误：%q", items[0].Label)
	}
	if !items[0].Selected {
		t.Fatalf("00012 同时是 libbluray 默认项，应标记 Selected")
	}
	if items[1].Ref != 4 || items[1].Seconds <= items[2].Seconds {
		t.Fatalf("应按时长降序：%+v", items)
	}
	if items[1].Label != "标题 4" {
		t.Fatalf("非主影片标签应为「标题 N」：%q", items[1].Label)
	}
	// 索引连续，供播放器菜单排序使用
	for i, it := range items {
		if it.Index != i {
			t.Fatalf("Index 应为序号 %d，实际 %d", i, it.Index)
		}
	}
}

func TestV0998DiscPlaylistSelectedNorMain(t *testing.T) {
	items := []discPlaylistEntry{
		{Kind: "playlist", Ref: 1, Seconds: 600, DurationText: "0:10:00"},
		{Kind: "playlist", Ref: 2, Seconds: 300, DurationText: "0:05:00"},
	}
	got := finalizeDiscPlaylists(items, 2)
	if !got[0].Main || got[0].Ref != 1 {
		t.Fatalf("主影片应为最长者 1：%+v", got)
	}
	if !got[1].Selected || got[1].Label != "标题 2（默认）" {
		t.Fatalf("默认项应标注「（默认）」：%+v", got[1])
	}
}

func TestV0998DiscDurationAndTitle(t *testing.T) {
	if got := discDurationText(8957); got != "2:29:17" {
		t.Fatalf("时长文本 %q", got)
	}
	if got := discDurationText(0); got != "" {
		t.Fatalf("0 秒应返回空：%q", got)
	}
	if got := discTitleFromRoot("/MO/[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray/BDMV/STREAM/00005.m2ts"); got != "[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray" {
		t.Fatalf("原盘目录名解析错误：%q", got)
	}
	// ISO 镜像：标题取镜像名（去扩展名），与前端 movieTitleFromPath 的 ISO 口径一致
	if got := discTitleFromRoot("/YY/某演唱会/演唱会.iso"); got != "演唱会" {
		t.Fatalf("镜像名应去掉扩展名：%q", got)
	}
	// ISO 镜像：整条路径就是原盘根，取文件名本身
	if got := discTitleFromRoot("/MO/电影/Black.Hawk.Down.2001.iso"); got != "Black.Hawk.Down.2001" {
		t.Fatalf("ISO 标题错误：%q", got)
	}
}

func TestV0998DiscInputArgsCarryPlaylist(t *testing.T) {
	bd := discInput{Spec: "bluray:/MO/x", Kind: discInputBluRay}
	if args := bd.InputArgs(); len(args) != 0 {
		t.Fatalf("未选播放列表时蓝光不应带额外参数：%+v", args)
	}
	bd.Playlist = 12
	args := bd.InputArgs()
	if strings.Join(args, " ") != "-playlist 12" {
		t.Fatalf("蓝光应带 -playlist 12，实际 %+v", args)
	}
	dvd := discInput{Spec: "/YY/x.iso", Kind: discInputDVD, Title: 3}
	args = dvd.InputArgs()
	if strings.Join(args, " ") != "-f dvdvideo -title 3" {
		t.Fatalf("DVD 应带 -f dvdvideo -title 3，实际 %+v", args)
	}
	if bd.SelectedRef() != 12 || dvd.SelectedRef() != 3 {
		t.Fatalf("SelectedRef 错误：%d / %d", bd.SelectedRef(), dvd.SelectedRef())
	}
}

/* resolveDiscInputWithPlaylist：显式标题要落到 bluray:<原盘根> + -playlist N。 */
func TestV0998ResolveDiscInputWithPlaylist(t *testing.T) {
	frag := "/media/MO/黑鹰坠落 (2001)/BDMV/STREAM/00005.m2ts"
	oldRunner := discProbeRunner
	defer func() { discProbeRunner = oldRunner }()
	discProbeRunner = func(_ context.Context, _ discInput) bool { return false }
	resetDiscInputCache()

	app := &App{}
	/* playlist=0 必须与 v0.9.88 的旧口径逐字段一致（老调用点零风险）。 */
	auto := app.resolveDiscInputWithPlaylist(context.Background(), frag, 0)
	legacy := app.resolveDiscInput(context.Background(), frag)
	if auto != legacy {
		t.Fatalf("playlist=0 时行为必须与旧口径一致：%+v vs %+v", auto, legacy)
	}
	if auto.Playlist != 0 || auto.Title != 0 {
		t.Fatalf("playlist=0 不应带播放列表参数：%+v", auto)
	}
	picked := app.resolveDiscInputWithPlaylist(context.Background(), frag, 4)
	if picked.Kind != discInputBluRay || picked.Playlist != 4 {
		t.Fatalf("选了标题应切到 bluray 输入：%+v", picked)
	}
	if picked.Spec != "bluray:/media/MO/黑鹰坠落 (2001)" {
		t.Fatalf("输入应指向原盘根：%q", picked.Spec)
	}
	if picked.File != frag {
		t.Fatalf("File 必须仍是库内真实文件（大小/缓存键用它）：%q", picked.File)
	}
	iso := "/media/MO/Black.Hawk.Down.2001.iso"
	pickedISO := app.resolveDiscInputWithPlaylist(context.Background(), iso, 3)
	if pickedISO.Spec != "bluray:"+iso || pickedISO.Playlist != 3 {
		t.Fatalf("ISO 选标题同样按 bluray 播放：%+v", pickedISO)
	}
}

/* v0.9.98 回归护栏：预算算式不能溢出（Duration*Duration 会让上下文立刻过期）。 */
func TestV0998DiscPlaylistBudgetNotOverflow(t *testing.T) {
	b := discPlaylistBudget()
	want := discPlaylistTimeout + time.Duration(discDVDTitleMaxProbe)*discDVDTitleTimeout
	if b != want || b <= 0 {
		t.Fatalf("预算算式异常：%v（期望 %v）", b, want)
	}
	if b < 60*time.Second || b > 10*time.Minute {
		t.Fatalf("预算不合理：%v", b)
	}
}
func TestV0998DiscPlaylistArgParsing(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/media/file?id=lib&path=x&disc_playlist=12", nil)
	if got := discPlaylistArg(req); got != 12 {
		t.Fatalf("disc_playlist 解析错误：%d", got)
	}
	for _, raw := range []string{"0", "-3", "abc", "999999"} {
		if got := discPlaylistArg(httptest.NewRequest("GET", "/api/media/file?id=lib&path=x&disc_playlist="+raw, nil)); got != 0 {
			t.Fatalf("非法 disc_playlist=%s 应回落 0，实际 %d", raw, got)
		}
	}
	if got := discPlaylistArg(nil); got != 0 {
		t.Fatalf("nil 请求应回落 0，实际 %d", got)
	}
}

/* 本地 NFO 演职人员头像：三种形态。 */
func TestV0998LocalCastAvatar(t *testing.T) {
	lib := Library{ID: "lib1", Path: "/media/MO"}
	dir := t.TempDir()
	// ① TMDB 图片地址 → 头像代理
	av, kind, raw := localCastAvatar(lib, dir, "https://image.tmdb.org/t/p/w500/9gbnm4.jpg")
	if av != "/api/media/cast/avatar?person=%2F9gbnm4.jpg" || kind != "tmdb" || raw == "" {
		t.Fatalf("TMDB 头像转换错误：%q %q", av, kind)
	}
	// ② 其它 http 地址 → 原样
	av, kind, _ = localCastAvatar(lib, dir, "https://example.invalid/a.jpg")
	if av != "https://example.invalid/a.jpg" || kind != "remote" {
		t.Fatalf("外部头像应原样返回：%q %q", av, kind)
	}
	// ③ 本地 .actors/ 文件 → 本地头像代理（用真实库结构以外的路径也能映射）
	actorDir := filepath.Join(dir, ".actors")
	if err := os.MkdirAll(actorDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(actorDir, "汤姆.jpg"), []byte("jpg"), 0o644); err != nil {
		t.Fatal(err)
	}
	libMulti := Library{ID: "lib1", Path: dir}
	av, kind, _ = localCastAvatar(libMulti, dir, ".actors/汤姆.jpg")
	if kind != "local" || !strings.HasPrefix(av, "/api/media/cast/avatar?id=lib1&path=") {
		t.Fatalf("本地头像应走本地代理：%q %q", av, kind)
	}
	// ④ 不存在的文件 → 不编造地址
	av, kind, _ = localCastAvatar(libMulti, dir, ".actors/缺.jpg")
	if av != "" || kind != "" {
		t.Fatalf("缺文件时不应给出地址：%q %q", av, kind)
	}
	if av, kind, _ := localCastAvatar(lib, dir, ""); av != "" || kind != "" {
		t.Fatalf("空 thumb 应返回空：%q %q", av, kind)
	}
}

func TestV0998NFOCastDocumentRoundTrip(t *testing.T) {
	xmlDoc := `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>本地标题</title>
  <actor><name>汤姆·汉克斯</name><role>米勒上尉</role><thumb>https://image.tmdb.org/t/p/w500/9gbnm4.jpg</thumb></actor>
  <actor><name>马特·达蒙</name><role>瑞恩</role><thumb>.actors/马特.jpg</thumb></actor>
</movie>`
	dir := t.TempDir()
	p := filepath.Join(dir, "movie.nfo")
	if err := os.WriteFile(p, []byte(xmlDoc), 0o644); err != nil {
		t.Fatal(err)
	}
	lib := Library{ID: "l", Path: dir}
	m, err := readLocalMediaMetadata(lib, "movie.nfo")
	if err != nil {
		t.Fatalf("读取本地 NFO 失败：%v", err)
	}
	if len(m.Cast) != 2 {
		t.Fatalf("应读到 2 位演职人员，实际 %d", len(m.Cast))
	}
	if m.Cast[0].AvatarKind != "tmdb" || !strings.HasPrefix(m.Cast[0].Avatar, "/api/media/cast/avatar?person=") {
		t.Fatalf("第一位应走 TMDB 头像代理：%+v", m.Cast[0])
	}
	if m.Cast[1].Avatar != "" || m.Cast[1].AvatarThumb != ".actors/马特.jpg" {
		t.Fatalf("本地头像文件不存在时不应编造地址，但原始 thumb 要保留：%+v", m.Cast[1])
	}
	// 写回 NFO 时演员要带 <thumb>（原样 thumb 优先）
	thumb := nfoActorThumb(m.Cast[0], "")
	if thumb != "https://image.tmdb.org/t/p/w500/9gbnm4.jpg" {
		t.Fatalf("写回 thumb 应为原始地址：%q", thumb)
	}
	proxyOnly := localMetadataCast{Name: "x", Avatar: "/api/media/cast/avatar?person=%2Fabc.jpg"}
	if got := nfoActorThumb(proxyOnly, "https://image.tmdb.org/t/p"); got != "https://image.tmdb.org/t/p/w500/abc.jpg" {
		t.Fatalf("只有代理地址时应还原成 w500 原图：%q", got)
	}
	if got := nfoActorThumb(localMetadataCast{Name: "y"}, ""); got != "" {
		t.Fatalf("没有头像信息时 thumb 应为空：%q", got)
	}
}

func TestV0998LocalAvatarContentType(t *testing.T) {
	cases := map[string]string{
		"a.jpg": "image/jpeg", "a.JPEG": "image/jpeg", "a.png": "image/png",
		"a.webp": "image/webp", "a.mkv": "", "a.nfo": "",
	}
	for in, want := range cases {
		if got := localAvatarContentType(in); got != want {
			t.Fatalf("%s → %q，期望 %q", in, got, want)
		}
	}
}
