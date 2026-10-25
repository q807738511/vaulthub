package main

import (
	"strings"
	"testing"
)

// v1.0.9：大库分页/聚合与 NFO 补全的纯函数契约。

func TestV1009ParseAudioPath(t *testing.T) {
	cases := []struct {
		path          string
		artist, album string
		title         string
		track         int
	}{
		{
			path:   "2009 fripSide - only my railgun/01 only my railgun.flac",
			artist: "fripSide", album: "only my railgun", title: "only my railgun", track: 1,
		},
		{
			path:   "Capcom - MEGAMAN ZERO (ORIGINAL SOUNDTRACK) (2020) - ALAC 24bit 44.1khz - Panda/05 Title.flac",
			artist: "Capcom", album: "MEGAMAN ZERO (ORIGINAL SOUNDTRACK) (2020)", title: "Title", track: 5,
		},
		{
			path:   "周杰倫/范特西/02 雙截棍.mp3",
			artist: "周杰倫", album: "范特西", title: "雙截棍", track: 2,
		},
		{
			path:   "4-binarydigit/Booklet/001 曲目.flac",
			artist: "未知歌手", album: "4-binarydigit", title: "曲目", track: 1,
		},
		{
			// 目录里没有歌手信息，退回文件名「歌手 - 曲名」。
			path:   "Single/Artist X - Song Y.mp3",
			artist: "Artist X", album: "Single", title: "Song Y", track: 0,
		},
	}
	for _, c := range cases {
		artist, album, title, track := parseAudioPath(c.path)
		if artist != c.artist || album != c.album || title != c.title || track != c.track {
			t.Fatalf("parseAudioPath(%q) = (%q,%q,%q,%d)，期望 (%q,%q,%q,%d)",
				c.path, artist, album, title, track, c.artist, c.album, c.title, c.track)
		}
	}
}

func TestV1009SplitArtistAlbum(t *testing.T) {
	cases := []struct{ in, artist, album string }{
		{"2009 fripSide - only my railgun", "fripSide", "only my railgun"},
		{"周杰倫 - 范特西", "周杰倫", "范特西"},
		{"OST - FLAC 24bit", "", "OST"},
		{"NoSeparator", "", "NoSeparator"},
	}
	for _, c := range cases {
		a, al := splitArtistAlbum(c.in)
		if a != c.artist || al != c.album {
			t.Fatalf("splitArtistAlbum(%q) = (%q,%q)，期望 (%q,%q)", c.in, a, al, c.artist, c.album)
		}
	}
}

func TestV1009ParseMovieStem(t *testing.T) {
	cases := []struct{ in, title, year string }{
		{"Test.Movie.2024.1080p.BluRay.x264-GROUP", "Test Movie", "2024"},
		{"流浪地球2.2023.2160p.WEB-DL", "流浪地球2", "2023"},
		{"NoYearFile", "NoYearFile", ""},
	}
	for _, c := range cases {
		title, year, kind := parseMovieStem(c.in)
		if title != c.title || year != c.year || kind != "movie" {
			t.Fatalf("parseMovieStem(%q) = (%q,%q,%q)，期望 (%q,%q,movie)", c.in, title, year, kind, c.title, c.year)
		}
	}
}

func TestV1009ShelfOrderAndWhere(t *testing.T) {
	if got := shelfOrder("", ""); got != "lower(path) ASC" {
		t.Fatalf("默认排序 = %q", got)
	}
	if got := shelfOrder("date", ""); !strings.Contains(got, "mtime DESC") {
		t.Fatalf("按日期排序 = %q", got)
	}
	if got := shelfOrder("size", "desc"); !strings.Contains(got, "size DESC") {
		t.Fatalf("按大小排序 = %q", got)
	}
	where, args := shelfWhere("lib-x", "abc", browseExts["audio"])
	if !strings.Contains(where, "lower(path) LIKE") || !strings.Contains(where, "NOT LIKE '%-poster.%'") {
		t.Fatalf("WHERE 缺少搜索或 sidecar 排除：%s", where)
	}
	if len(args) == 0 || args[0] != "lib-x" {
		t.Fatalf("WHERE 参数起点错误：%v", args)
	}
	// 每个音频扩展名一个占位符 + 1 个 lib + 1 个搜索词。
	if n := strings.Count(where, "?"); n != 2+len(browseExts["audio"]) {
		t.Fatalf("占位符数量 = %d，期望 %d", n, 2+len(browseExts["audio"]))
	}
}

func TestV1009NFODocFromMeta(t *testing.T) {
	doc := nfoDocFromMeta(nfoWriteMeta{
		Title:    "测试影片",
		Year:     "2024",
		Overview: "简介",
		Rating:   8.5,
		Runtime:  120,
		Genres:   []string{"科幻", ""},
		Cast:     []localMetadataCast{{Name: "演员甲", Character: "角色甲"}},
		TMDBID:   "12345",
		Poster:   "https://example.invalid/p.jpg",
	})
	if doc.Title != "测试影片" || doc.Rating != "8.5" || doc.Runtime != "120" {
		t.Fatalf("基础字段错误：%+v", doc)
	}
	if len(doc.Genres) != 1 || doc.Genres[0] != "科幻" {
		t.Fatalf("类型应过滤空值：%v", doc.Genres)
	}
	if len(doc.Actors) != 1 || doc.Actors[0].Role != "角色甲" {
		t.Fatalf("演员字段错误：%+v", doc.Actors)
	}
	if len(doc.UniqueIDs) != 1 || doc.UniqueIDs[0].Type != "tmdb" {
		t.Fatalf("uniqueid 错误：%+v", doc.UniqueIDs)
	}
	if len(doc.Thumbs) != 1 || doc.Thumbs[0].Aspect != "poster" {
		t.Fatalf("thumb 错误：%+v", doc.Thumbs)
	}
	if doc.WrittenBy != "VaultHub" {
		t.Fatalf("写入标记错误：%q", doc.WrittenBy)
	}
}

func TestV1009RepairTargetsNaming(t *testing.T) {
	// 与读取端候选名一致：<文件名>.nfo / <文件名>-poster.jpg。
	if got := indexRelJoin("Show/Season 01", "tvshow.nfo"); got != "Show/Season 01/tvshow.nfo" {
		t.Fatalf("indexRelJoin = %q", got)
	}
	if got := indexRelJoin("", "tvshow.nfo"); got != "tvshow.nfo" {
		t.Fatalf("空目录拼接 = %q", got)
	}
	if !strings.HasSuffix(nfoArtName("A.mkv", "poster", ".jpg"), "A-poster.jpg") {
		t.Fatalf("海报命名规则变化")
	}
}

// nfoArtName 仅测试用：与 nfoDownloadArt 内部的命名规则保持一致。
func nfoArtName(media, role, ext string) string {
	stem := media
	if i := strings.LastIndexByte(stem, '.'); i > 0 {
		stem = stem[:i]
	}
	return stem + "-" + role + ext
}

func TestV1009AudioExtMatch(t *testing.T) {
	// 扩展名表不带点、路径带点：v1.0.9 首版漏了 TrimPrefix，音乐聚合整库空列表。
	for _, p := range []string{"A/B/01 x.mp3", "A/B/02 y.FLAC", "A/B/03 z.M4a"} {
		if !isAudioBrowseExt(p) {
			t.Fatalf("%q 应识别为音频", p)
		}
	}
	for _, p := range []string{"A/B/cover.jpg", "A/B/x.vaulthub.json", "A/B/movie.mkv"} {
		if isAudioBrowseExt(p) {
			t.Fatalf("%q 不应识别为音频", p)
		}
	}
}

func TestV1009ArtworkShardRetry(t *testing.T) {
	// 豆瓣图床按分片反爬：img9 对 Go 客户端返回 JS 校验页，img1/img2 才是真图。
	urls := artworkCandidateURLs("https://img9.doubanio.com/view/photo/l/public/p1.jpg")
	if len(urls) < 3 {
		t.Fatalf("分片候选太少：%v", urls)
	}
	if urls[0] != "https://img9.doubanio.com/view/photo/l/public/p1.jpg" {
		t.Fatalf("原始地址必须排第一：%v", urls)
	}
	joined := strings.Join(urls, " ")
	for _, shard := range []string{"img1", "img2", "img3"} {
		if !strings.Contains(joined, "//"+shard+".doubanio.com/view/photo/l/public/p1.jpg") {
			t.Fatalf("缺少 %s 分片候选：%v", shard, urls)
		}
	}
	// 非豆瓣图床不做改写。
	other := artworkCandidateURLs("https://image.tmdb.org/t/p/w500/x.jpg")
	if len(other) != 1 {
		t.Fatalf("非豆瓣地址不应改写：%v", other)
	}
}

func TestV1009ArtworkSidecarName(t *testing.T) {
	// 曾经少了扩展名的点，落成「片名-posterjpg」—— 读取端认不出来，等于没下载。
	got := artworkSidecarName("A.mkv", "poster", "jpg")
	if got != "A-poster.jpg" {
		t.Fatalf("海报命名 = %q，期望 A-poster.jpg", got)
	}
	if got := artworkSidecarName("片名.2023.mkv", "fanart", "webp"); got != "片名.2023-fanart.webp" {
		t.Fatalf("背景图命名 = %q", got)
	}
}

func TestV1009BookComicExts(t *testing.T) {
	// 书刊视图必须是 book ∪ comic：生产电子书库是 .txt + .cover.jpg 混排，
	// 只按 comic 集合过滤会把 18.4 万条算成 2 条（实测事故）。
	lib := Library{ID: "b1", Type: "book"}
	exts := browseGroupFor(lib, "comic")
	for _, want := range []string{"txt", "epub", "cbz", "jpg"} {
		if !exts[want] {
			t.Fatalf("书刊扩展名并集缺少 %s", want)
		}
	}
	if got := browseGroupFor(Library{Type: "musicvideo"}, "audio"); !got["mkv"] {
		t.Fatalf("MV 库应按视频口径")
	}
	if got := browseGroupFor(Library{Type: "audio"}, ""); !got["mp3"] || got["txt"] {
		t.Fatalf("音频库扩展名错误")
	}
}

func TestV1009DiscSegmentsSkipped(t *testing.T) {
	// 原盘备份的分片不能当独立影片刮削（否则库里会多出成百上千个 00000.nfo）。
	for _, p := range []string{
		"12.Strong.2018/BDMV/STREAM/00000.m2ts",
		"Movie/BDMV/PLAYLIST/00001.mpls",
		"DVD/VIDEO_TS/VTS_01_1.VOB",
	} {
		if !isDiscSegmentPath(p) {
			t.Fatalf("%q 应判定为原盘分片", p)
		}
	}
	for _, p := range []string{"Movies/A.mkv", "Show/Season 01/S01E01.mkv"} {
		if isDiscSegmentPath(p) {
			t.Fatalf("%q 不应判定为原盘分片", p)
		}
	}
}
