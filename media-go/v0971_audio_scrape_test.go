package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

/* v0.9.71 刮削识别策略守卫（特殊字符 / 日语 / 全角）。
 *
 * 下面的 iTunes 结果是 **真机抓取** 的响应片段（2026-09，直连 iTunes Search API，
 * 每国取前 3 条，字段裁剪到本仓库解码用到的 4 个），因此断言的是真实世界行为：
 *   - 残酷な天使のテーゼ：TW/US 只返回罗马音翻奏（标题归一化后不命中），JP 首条才是原版；
 *   - 前前前世：JP 首条是 Piano Echoes 的翻奏（歌手名与 RADWIMPS 无公共字，
 *     旧的「共享 ≥3 个 ASCII 字符」判定把它误判成 RADWIMPS —— 本文件用
 *     TestV0971OldLooseLatinRuleWouldMisMatch 记录该误配，确保新规则不复现）；
 *   - 打上花火：US 返回罗马音标题，JP 才同时给出原名与原名歌手。
 */

var fixtureZankokuTW = `{"resultCount":3,"results":[
 {"trackName":"Zankokuna Tenshino These (feat. Yoko Takahashi) [Buraban! Koushien Version]","artistName":"東京佼成管樂團","collectionName":"Brass Band! Koushien Greatest Hits","artworkUrl100":"https://art.example/tw1/100x100bb.jpg"},
 {"trackName":"殘酷な天使のテーゼ(Live)","artistName":"陳樂一","collectionName":"2020最美的夜 bilibili晚會(Live)","artworkUrl100":"https://art.example/tw2/100x100bb.jpg"},
 {"trackName":"A Cruel Angel's Thesis (Originally Performed by Yoko Takahashi from Neon Genesis EVANGELION)","artistName":"MIDORI ORGEL","collectionName":"ORGEL Anime Songs Vol.13","artworkUrl100":"https://art.example/tw3/100x100bb.jpg"}]}`

var fixtureZankokuJP = `{"resultCount":3,"results":[
 {"trackName":"残酷な天使のテーゼ","artistName":"高橋洋子","collectionName":"残酷な天使のテーゼ - EP","artworkUrl100":"https://art.example/jp1/100x100bb.jpg"},
 {"trackName":"残酷な天使のテーゼ (off vocal version)","artistName":"高橋洋子","collectionName":"残酷な天使のテーゼ/魂のルフラン - EP","artworkUrl100":"https://art.example/jp2/100x100bb.jpg"},
 {"trackName":"残酷な天使のテーゼ (Directors Edit. Version)","artistName":"高橋洋子","collectionName":"残酷な天使のテーゼ/FLY ME TO THE MOON - EP","artworkUrl100":"https://art.example/jp3/100x100bb.jpg"}]}`

var fixtureZenzenJP = `{"resultCount":3,"results":[
 {"trackName":"前前前世(『君の名は。』より) [Piano Echoes Ver.]","artistName":"Piano Echoes","collectionName":"RADWIMPS ✕ 新海 誠","artworkUrl100":"https://art.example/jz1/100x100bb.jpg"},
 {"trackName":"前前前世 (映画『君の名は。』より) (Originally performed by RADWIMPS) [オルゴール]","artistName":"α波オルゴール","collectionName":"アニソン・ラブ・ヒッツ","artworkUrl100":"https://art.example/jz2/100x100bb.jpg"},
 {"trackName":"前前前世","artistName":"Aruvn","collectionName":"前前前世 - Single","artworkUrl100":"https://art.example/jz3/100x100bb.jpg"}]}`

var fixtureZenzenTW = `{"resultCount":3,"results":[
 {"trackName":"前前前世 (original ver.)","artistName":"RADWIMPS","collectionName":"人間開花","artworkUrl100":"https://art.example/tz1/100x100bb.jpg"},
 {"trackName":"前前前世 (movie ver.)","artistName":"RADWIMPS","collectionName":"君の名は。","artworkUrl100":"https://art.example/tz2/100x100bb.jpg"},
 {"trackName":"前前前世","artistName":"Aruvn","collectionName":"前前前世 - Single","artworkUrl100":"https://art.example/tz3/100x100bb.jpg"}]}`

var fixtureUchiageJP = `{"resultCount":3,"results":[
 {"trackName":"打上花火","artistName":"米津玄師","collectionName":"BOOTLEG","artworkUrl100":"https://art.example/uj1/100x100bb.jpg"},
 {"trackName":"打上花火","artistName":"DAOKO×米津玄師","collectionName":"打上花火 - Single","artworkUrl100":"https://art.example/uj2/100x100bb.jpg"},
 {"trackName":"打上花火","artistName":"DAOKO×米津玄師","collectionName":"THANK YOU BLUE","artworkUrl100":"https://art.example/uj3/100x100bb.jpg"}]}`

var fixtureUchiageUS = `{"resultCount":3,"results":[
 {"trackName":"Uchiagehanabi","artistName":"DAOKO×米津玄師","collectionName":"Uchiagehanabi - Single","artworkUrl100":"https://art.example/uu1/100x100bb.jpg"},
 {"trackName":"Uchiagehanabi","artistName":"Kenshi Yonezu","collectionName":"bootleg","artworkUrl100":"https://art.example/uu2/100x100bb.jpg"},
 {"trackName":"Uchiagehanabi","artistName":"DAOKO×米津玄師","collectionName":"Thank You Blue","artworkUrl100":"https://art.example/uu3/100x100bb.jpg"}]}`

func decodeItunes(t *testing.T, raw string) []itunesTrack {
	t.Helper()
	var data itunesSearchResponse
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		t.Fatalf("fixture 解析失败: %v", err)
	}
	return data.Results
}

/* 全角/半角折叠：全角 ASCII、表意空格、半角片假名（含浊音组合）。 */
func TestV0971WidthFold(t *testing.T) {
	cases := map[string]string{
		"ＮＵＭＢＥＲ":  "NUMBER",
		"Ｋｅｎｇｏ":   "Kengo",
		"ABC１２３":   "ABC123",
		"表意　空格":    "表意 空格",
		"ﾊﾟﾋﾟﾌﾟ":    "パピプ",
		"ﾊﾞﾗｰﾄﾞ":    "バラード",
		"ヨルシカ":      "ヨルシカ", // 已是全角：必须原样保留，不能被“折叠”坏
	}
	for in, want := range cases {
		if got := audioWidthFold(in); got != want {
			t.Fatalf("audioWidthFold(%q) = %q, want %q", in, got, want)
		}
	}
}

/* 去修饰：括号整段（含混用嵌套）、孤立括号、音轨号、独立修饰词、紧贴尾部的修饰词。 */
func TestV0971StripDecorations(t *testing.T) {
	cases := map[string]string{
		"残酷な天使のテーゼ【MV】":                    "残酷な天使のテーゼ",
		"残酷な天使のテーゼ【MV":                     "残酷な天使のテーゼ", // 未闭合括号：MV 粘在尾部也要去掉
		"【東方】Bad Apple!!":                  "Bad Apple!!",
		"打上花火 (MOVIE ver.)":                "打上花火",
		"前前前世(『君の名は。』より) [Piano Echoes Ver.]": "前前前世", // 混用嵌套必须整段删掉，旧实现漏出「より」
		"01 米津玄師 - Lemon":                 "米津玄師 Lemon",
		"01. 千里之外":                         "千里之外",
		"1-800-273-8255":                   "1-800-273-8255", // 数字标题不能被当音轨号删掉
		"Lemon - Topic":                    "Lemon",
		"残酷な天使のテーゼ 高音質":                   "残酷な天使のテーゼ",
		"Wired":                            "Wired", // 尾部 "ed" 不是标记，必须保留
		"With Ed":                          "With Ed",
		"残酷な天使のテーゼ OP2":                   "残酷な天使のテーゼ", // 全大写 OP2 仍算标记
	}
	for in, want := range cases {
		if got := audioStripDecorations(in); got != want {
			t.Fatalf("audioStripDecorations(%q) = %q, want %q", in, got, want)
		}
	}
}

/* 检索词阶梯：原样在前、去修饰随后、主歌手、最后「仅标题」；去重且有上限。 */
func TestV0971QueryVariants(t *testing.T) {
	variantList := audioQueryVariants("残酷な天使のテーゼ【MV】", "高橋洋子")
	if len(variantList) < 2 {
		t.Fatalf("expected at least 2 variants, got %+v", variantList)
	}
	if variantList[0].Title != "残酷な天使のテーゼ【MV】" || variantList[0].Artist != "高橋洋子" {
		t.Fatalf("first variant must keep the raw title: %+v", variantList[0])
	}
	if variantList[1].Title != "残酷な天使のテーゼ" || variantList[1].Artist != "高橋洋子" {
		t.Fatalf("second variant must be the stripped title: %+v", variantList[1])
	}
	last := variantList[len(variantList)-1]
	if last.Artist != "" || last.Title == "" {
		t.Fatalf("last variant must be title-only: %+v", last)
	}
	// 去重 + 上限
	full := audioQueryVariants("千里之外", "周杰伦 feat. 费玉清")
	if len(full) > audioMaxQueryVariants {
		t.Fatalf("variant count %d exceeds cap %d", len(full), audioMaxQueryVariants)
	}
	seen := map[string]bool{}
	for _, q := range full {
		key := q.Title + "\x00" + q.Artist
		if seen[key] {
			t.Fatalf("duplicate variant %+v (%v)", q, full)
		}
		seen[key] = true
	}
	// 未知歌手：不产生「歌手」维度的变体
	unknown := audioQueryVariants("Song", "未知歌手")
	if len(unknown) == 0 || unknown[0].Artist != "" {
		t.Fatalf("unknown artist must drop the artist term: %+v", unknown)
	}
}

/* iTunes 店铺顺序：假名 → JP 优先；汉字 → TW 优先；拉丁 → US 优先。 */
func TestV0971CountryOrder(t *testing.T) {
	if got := audioCountryOrder("夜に駆ける YOASOBI"); got[0] != "JP" {
		t.Fatalf("kana query must try JP first, got %v", got)
	}
	if got := audioCountryOrder("千里之外 周杰伦"); got[0] != "TW" {
		t.Fatalf("han query must try TW first, got %v", got)
	}
	if got := audioCountryOrder("Seven Nation Army"); got[0] != "US" {
		t.Fatalf("latin query must try US first, got %v", got)
	}
	if got := audioCountryOrder("残酷な天使のテーゼ"); got[0] != "JP" {
		t.Fatalf("mixed kana+han must prefer JP, got %v", got)
	}
}

/* 歌手名匹配：拉丁名用编辑距离（旧规则会把 RADWIMPS 与 Piano Echoes 误配），
   非拉丁名用共享字数（简繁差异命中、只共享 1 字的不同歌手不命中）。 */
func TestV0971ArtistNameMatching(t *testing.T) {
	cases := []struct {
		want, got string
		ok        bool
		why       string
	}{
		{"RADWIMPS", "Piano Echoes", false, "实测共享 a/i/p/s 共 4 个 ASCII 字符，旧规则误判为同一歌手"},
		{"LiSA", "Lisa", true, "大小写差异：相似度 0.75"},
		{"Aimer", "Aimer", true, "完全相同"},
		{"周杰伦", "周杰倫", true, "简繁差异：共享 周杰"},
		{"邓丽君", "邓紫棋", false, "只共享 邓 一个字"},
		{"高橋洋子", "高橋洋子", true, "完全相同（罗马音走别名表，见别名桥接用例）"},
		{"Adele", "Jay-Z", false, "拉丁名无公共词干"},
		{"abcd", "abcf", true, "相似度 0.75（旧契约要求命中的宽匹配下限）"},
	}
	for _, c := range cases {
		if got := audioArtistNameMatches(c.want, c.got); got != c.ok {
			t.Fatalf("audioArtistNameMatches(%q,%q) = %v, want %v (%s)", c.want, c.got, got, c.ok, c.why)
		}
	}
	if audioLatinSimilarity("radwimps", "pianoechoes") >= 0.7 {
		t.Fatal("RADWIMPS 与 Piano Echoes 的相似度必须低于阈值 0.7")
	}
}

/* 标题匹配：简繁/后缀/去修饰；不同曲目不能被共享两字带偏。 */
func TestV0971TitleMatching(t *testing.T) {
	if !audioTitleMatches("残酷な天使のテーゼ", "残酷な天使のテーゼ (off vocal version)") {
		t.Fatal("带后缀的同一曲目必须命中")
	}
	if !audioTitleMatches("说好不哭", "說好不哭") {
		t.Fatal("简繁差异标题必须命中（共享 3 字、长度相等）")
	}
	if audioTitleMatches("紅蓮華", "紅蓮の弓矢") {
		t.Fatal("共享 2 字但长度比 0.6 的不同曲目不能命中")
	}
	if !audioLyricsTitleMatches("【東方】Bad Apple!!", "【東方】Bad Apple!! ＰＶ【影絵】") {
		t.Fatal("去修饰后同名的 q= 结果必须命中")
	}
	if audioLyricsTitleMatches("NUMBER", "back number - 水平線") {
		t.Fatal("q= 里被包含的无关曲目（back number）不能命中")
	}
	if !audioLyricsTitleMatches("残酷な天使のテーゼ", "残酷な天使のテーゼ (off vocal version)") {
		t.Fatal("同一曲目的版本变体（包含关系、同脚本）应命中")
	}
	if !audioLyricsTitleMatches("说好不哭", "說好不哭") {
		t.Fatal("等长的简繁差异标题必须命中")
	}
	if audioLyricsTitleMatches("紅蓮華", "紅蓮の弓矢") {
		t.Fatal("共享 2 字、长度比 0.6 的不同曲目不能命中")
	}
	if audioLyricsTitleMatches("夜に駆ける", "夜に駆ける") == false {
		t.Fatal("完全相同必须命中")
	}
}

/* 真实 iTunes 数据：日语曲目必须取 JP 店铺的原版条目。 */
func TestV0971ItunesPickJapaneseFixtures(t *testing.T) {
	// TW 只有罗马音翻奏 → 旧实现（只查 TW/US）整轮落空
	if out, ok := itunesPick("残酷な天使のテーゼ", "高橋洋子", decodeItunes(t, fixtureZankokuTW)); ok {
		t.Fatalf("罗马音/翻奏结果不得被采纳：%+v", out)
	}
	out, ok := itunesPick("残酷な天使のテーゼ", "高橋洋子", decodeItunes(t, fixtureZankokuJP))
	if !ok {
		t.Fatal("JP 店铺的原版条目必须命中")
	}
	if out.Title != "残酷な天使のテーゼ" || out.Artist != "高橋洋子" || out.Album != "残酷な天使のテーゼ - EP" {
		t.Fatalf("unexpected pick: %+v", out)
	}
	if !strings.Contains(out.Cover, "600x600bb") {
		t.Fatalf("封面必须提升到 600x600：%q", out.Cover)
	}
	// 前前前世：JP 首条是 Piano Echoes 翻奏（旧拉丁规则会误配成 RADWIMPS），
	// 第三条是同名但不同歌手的 Aruvn —— 两者都只能拿最低分（标题相等、歌手不符），
	// 而 TW 店铺的「前前前世 (original ver.) / RADWIMPS」必须是满分候选。
	jp := decodeItunes(t, fixtureZenzenJP)
	if audioCandidateScore("前前前世", "RADWIMPS", jp[0].TrackName, jp[0].ArtistName) > 1 {
		t.Fatalf("Piano Echoes 的翻奏不得拿到高分：%+v", jp[0])
	}
	if audioCandidateScore("前前前世", "RADWIMPS", jp[2].TrackName, jp[2].ArtistName) > 1 {
		t.Fatalf("同名不同歌手的条目不得拿到高分：%+v", jp[2])
	}
	// 旧规则（共享 ≥3 个 ASCII 字符）会把 Piano Echoes 判成 RADWIMPS；新规则必须拒绝
	if audioArtistNameMatches("RADWIMPS", jp[0].ArtistName) {
		t.Fatalf("Piano Echoes 不得被认作 RADWIMPS：%+v", jp[0])
	}
	tw := decodeItunes(t, fixtureZenzenTW)
	if score := audioCandidateScore("前前前世", "RADWIMPS", tw[0].TrackName, tw[0].ArtistName); score < 5 {
		t.Fatalf("TW 的原版条目应得满分，实际 %d（%+v）", score, tw[0])
	}
	out2, ok2 := itunesPick("前前前世", "RADWIMPS", tw)
	if !ok2 || out2.Artist != "RADWIMPS" || out2.Album != "人間開花" {
		t.Fatalf("TW 的原版条目应被采纳：%+v", out2)
	}
	// 打上花火：JP 应取「DAOKO×米津玄師 - 打上花火 - Single」（整串歌手命中优于仅参与者命中）
	out3, ok3 := itunesPick("打上花火", "DAOKO×米津玄師", decodeItunes(t, fixtureUchiageJP))
	if !ok3 {
		t.Fatal("打上花火 必须命中")
	}
	if out3.Artist != "DAOKO×米津玄師" || out3.Album != "打上花火 - Single" {
		t.Fatalf("应优先整串歌手命中的单曲：%+v", out3)
	}
	if out4, ok4 := itunesPick("打上花火", "DAOKO×米津玄師", decodeItunes(t, fixtureUchiageUS)); ok4 {
		t.Fatalf("纯罗马音标题（Uchiagehanabi）不得被采纳：%+v", out4)
	}
}

/* 旧拉丁规则（共享 ≥3 个 ASCII 字符）在真实数据上会误配 —— 记录该反例，
   防止后续有人把阈值改回去。 */
func TestV0971OldLooseLatinRuleWouldMisMatch(t *testing.T) {
	if sharedCommonAscii("radwimps", "pianoechoes") < 3 {
		t.Fatal("反例前提失效：RADWIMPS 与 Piano Echoes 曾共享 ≥3 个 ASCII 字符")
	}
	if audioArtistNameMatches("RADWIMPS", "Piano Echoes") {
		t.Fatal("新规则必须拒绝该误配")
	}
}

/* 店铺顺序真的被用上：TW 命中不了（罗马音）时必须继续请求 JP 并采纳结果。 */
func TestV0971ScrapeAudioItunesUsesJapaneseStore(t *testing.T) {
	var countries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		country := r.URL.Query().Get("country")
		countries = append(countries, country)
		if strings.Contains(r.URL.Query().Get("term"), "高橋洋子") && country == "JP" {
			w.Write([]byte(fixtureZankokuJP))
			return
		}
		if country == "TW" {
			w.Write([]byte(fixtureZankokuTW))
			return
		}
		w.Write([]byte(`{"resultCount":0,"results":[]}`))
	}))
	defer server.Close()
	oldBase, oldClient := itunesSearchBase, outboundHTTPClient
	itunesSearchBase = server.URL
	defer func() { itunesSearchBase, outboundHTTPClient = oldBase, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	out, ok := a.scrapeAudioItunes(context.Background(), "残酷な天使のテーゼ", "高橋洋子")
	if !ok {
		t.Fatalf("日语曲目必须命中（请求过的店铺：%v）", countries)
	}
	if out.Album != "残酷な天使のテーゼ - EP" || out.Artist != "高橋洋子" {
		t.Fatalf("unexpected result %+v", out)
	}
	foundJP := false
	for _, c := range countries {
		if c == "JP" {
			foundJP = true
		}
	}
	if !foundJP {
		t.Fatalf("含假名的查询必须请求 JP 店铺，实际：%v", countries)
	}
	if len(countries) > 3 {
		t.Fatalf("单次刮削的店铺请求数应 ≤3，实际 %v", countries)
	}
}

/* 跨店铺择优：JP 店铺里的「同名不同歌手」条目（低分兜底）不得压过 TW 店铺的满分条目。 */
func TestV0971ScrapeAudioItunesPrefersFullMatchAcrossStores(t *testing.T) {
	var countries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		country := r.URL.Query().Get("country")
		countries = append(countries, country)
		switch country {
		case "JP":
			w.Write([]byte(fixtureZenzenJP))
		case "TW":
			w.Write([]byte(fixtureZenzenTW))
		default:
			w.Write([]byte(`{"resultCount":0,"results":[]}`))
		}
	}))
	defer server.Close()
	oldBase, oldClient := itunesSearchBase, outboundHTTPClient
	itunesSearchBase = server.URL
	defer func() { itunesSearchBase, outboundHTTPClient = oldBase, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	out, ok := a.scrapeAudioItunes(context.Background(), "前前前世", "RADWIMPS")
	if !ok {
		t.Fatalf("应命中 TW 店铺的满分条目（请求过的店铺：%v）", countries)
	}
	if out.Artist != "RADWIMPS" || out.Album != "人間開花" {
		t.Fatalf("低分兜底条目不得压过满分条目：%+v（店铺 %v）", out, countries)
	}
}

/* 罗马音桥接：iTunes 对日语歌手一律返回罗马音规范名，
   必须靠 MusicBrainz 别名表确认（旧实现因此永远刮不到日语歌手封面）。 */
func TestV0971ArtistAliasBridge(t *testing.T) {
	var lookedUp bool
	itunes := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "/search"):
			// 任何店铺都只给罗马音规范名（真实行为）
			w.Write([]byte(`{"resultCount":1,"results":[{"artistName":"Yoko Takahashi","artistId":4242}]}`))
		case strings.Contains(r.URL.Path, "/lookup"):
			lookedUp = true
			w.Write([]byte(`{"resultCount":2,"results":[{"wrapperType":"artist","artistName":"Yoko Takahashi","artistId":4242},{"wrapperType":"collection","collectionType":"Album","artistId":4242,"collectionName":"残酷な天使のテーゼ","artworkUrl100":"https://art.example/100x100bb.jpg"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer itunes.Close()
	mb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"artists":[{"id":"mbid-1","name":"高橋洋子","score":100,"type":"Person","aliases":[{"name":"Yoko Takahashi","locale":"en"},{"name":"たかはし ようこ","locale":"ja"}]}]}`))
	}))
	defer mb.Close()
	oldBase, oldMB, oldClient := itunesSearchBase, audioScrapeBase, outboundHTTPClient
	itunesSearchBase, audioScrapeBase = itunes.URL, mb.URL
	defer func() { itunesSearchBase, audioScrapeBase, outboundHTTPClient = oldBase, oldMB, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return itunes.Client(), nil }

	a := &App{}
	out, ok := a.scrapeAudioArtistItunes(context.Background(), "高橋洋子")
	if !ok {
		t.Fatal("罗马音桥接应让日语歌手封面命中")
	}
	if out.Name != "Yoko Takahashi" || !strings.Contains(out.Cover, "600x600bb") {
		t.Fatalf("unexpected artist result %+v", out)
	}
	if !lookedUp {
		t.Fatal("musicArtist 无头像时必须 lookup 代表专辑")
	}

	// 反例：MusicBrainz 查不到（别名表为空）→ 不得凭「罗马音未知」硬认
	emptyMB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"artists":[]}`))
	}))
	defer emptyMB.Close()
	audioScrapeBase = emptyMB.URL
	a2 := &App{}
	if out, ok := a2.scrapeAudioArtistItunes(context.Background(), "高橋洋子"); ok {
		t.Fatalf("无别名佐证时不得采纳罗马音结果：%+v", out)
	}
}

/* 别名表命中要求 MB score ≥ 88 且规范名与查询匹配（防同名歧义歌手污染）。 */
func TestV0971ArtistAliasGuards(t *testing.T) {
	mb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"artists":[{"id":"x","name":"Someone Else","score":100,"aliases":[{"name":"Yoko Takahashi"}]},{"id":"y","name":"高橋洋子","score":50,"aliases":[{"name":"Yoko Takahashi"}]}]}`))
	}))
	defer mb.Close()
	oldMB, oldClient := audioScrapeBase, outboundHTTPClient
	audioScrapeBase = mb.URL
	defer func() { audioScrapeBase, outboundHTTPClient = oldMB, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return mb.Client(), nil }

	a := &App{}
	if names := a.audioArtistAliasNames(context.Background(), "高橋洋子"); len(names) != 0 {
		t.Fatalf("低分/名字不匹配的 MB 记录不得被采信：%v", names)
	}
}

/* 歌词阶梯：带【MV】的标题结构化检索查不到，去修饰后才命中 —— 这正是不去修饰时的失败场景。 */
func TestV0971LyricsStrippedVariantLadder(t *testing.T) {
	var gotTitles []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasPrefix(r.URL.Path, "/api/get") {
			http.NotFound(w, r)
			return
		}
		title := r.URL.Query().Get("track_name")
		gotTitles = append(gotTitles, title)
		if title != "残酷な天使のテーゼ" { // 带修饰的原样标题在真实 LRCLIB 上返回 404
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"code":404,"message":"Not Found"}`))
			return
		}
		w.Write([]byte(`{"trackName":"残酷な天使のテーゼ","artistName":"高橋洋子","syncedLyrics":"[00:00.00]残酷な天使のテーゼ\n[00:02.00]少年よ 神話になれ","plainLyrics":"残酷な天使のテーゼ"}`))
	}))
	defer server.Close()
	oldBase, oldOvh, oldClient, oldInterval := lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval
	lrclibBase, lyricsOvhBase = server.URL, server.URL
	lyricsMinInterval = 0
	defer func() {
		lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval = oldBase, oldOvh, oldClient, oldInterval
	}()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	res, ok := a.scrapeAudioLyrics(context.Background(), "残酷な天使のテーゼ【MV】", "高橋洋子")
	if !ok || !strings.Contains(res.Lyrics, "少年よ") {
		t.Fatalf("去修饰变体应命中歌词：%+v", res)
	}
	if len(gotTitles) < 2 || gotTitles[0] != "残酷な天使のテーゼ【MV】" || gotTitles[1] != "残酷な天使のテーゼ" {
		t.Fatalf("必须先试原样标题、再试去修饰标题，实际：%v", gotTitles)
	}
}

/* 自由文本兜底：结构化检索 0 条时用 q=，但只采纳标题匹配的记录
   （实测 q=ＮＵＭＢＥＲ 第一条是 back number 的无关曲目）。 */
func TestV0971LyricsFreeTextFallback(t *testing.T) {
	var freeCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		switch {
		case strings.HasPrefix(path, "/api/get"):
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"code":404,"message":"Not Found"}`))
		case strings.HasPrefix(path, "/api/search"):
			if r.URL.Query().Get("q") != "" {
				freeCalls++
				w.Write([]byte(`[{"trackName":"back number - 水平線","artistName":"back number","syncedLyrics":"[00:00.00]水平線"},
				                {"trackName":"【東方】Bad Apple!! ＰＶ【影絵】","artistName":"kasidid2","syncedLyrics":"[00:00.00]流れてく 時の中ででも"}]`))
				return
			}
			w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	oldBase, oldOvh, oldClient, oldInterval := lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval
	lrclibBase, lyricsOvhBase = server.URL, server.URL
	lyricsMinInterval = 0
	defer func() {
		lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval = oldBase, oldOvh, oldClient, oldInterval
	}()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	res, ok := a.scrapeAudioLyrics(context.Background(), "【東方】Bad Apple!!", "上海アリス幻樂団")
	if !ok {
		t.Fatalf("q= 兜底应命中（q= 调用次数 %d）", freeCalls)
	}
	if !strings.Contains(res.Lyrics, "流れてく") {
		t.Fatalf("必须挑中标题匹配的那条，而不是列表第一条：%+v", res)
	}
	if freeCalls == 0 {
		t.Fatal("结构化检索为空时必须走 q= 兜底")
	}

	// 全是无关结果时：不给歌词（旧实现会把第一条有歌词的记录照贴）
	unrelated := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/api/search") {
			w.Write([]byte(`[{"trackName":"back number - 水平線","artistName":"back number","syncedLyrics":"[00:00.00]水平線"}]`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"code":404,"message":"Not Found"}`))
	}))
	defer unrelated.Close()
	lrclibBase, lyricsOvhBase = unrelated.URL, unrelated.URL
	a2 := &App{}
	if res, ok := a2.scrapeAudioLyrics(context.Background(), "ＮＵＭＢＥＲ", "Ｋｅｎｇｏ"); ok {
		t.Fatalf("无关结果不得被当作歌词返回：%+v", res)
	}
}

/* 结构化检索的选择器：不匹配就返回 ok=false（旧实现退回「第一条有歌词的」）。 */
func TestV0971PickLrclibNoUnrelatedFallback(t *testing.T) {
	list := []lrclibRecord{
		{TrackName: "back number - 水平線", ArtistName: "back number", SyncedLyrics: "[00:00.00]水平線"},
		{TrackName: "別の曲", ArtistName: "別人", PlainLyrics: "歌詞"},
	}
	if rec, ok := pickLrclibRecord("ＮＵＭＢＥＲ", "Ｋｅｎｇｏ", list); ok {
		t.Fatalf("无关列表不得返回记录：%+v", rec)
	}
	match := []lrclibRecord{
		{TrackName: "NUMBER", ArtistName: "Kengo", SyncedLyrics: "[00:00.00]NUMBER"},
	}
	rec, ok := pickLrclibRecord("ＮＵＭＢＥＲ", "Ｋｅｎｇｏ", match)
	if !ok || rec.TrackName != "NUMBER" {
		t.Fatalf("全角折叠后应命中同一曲目：%+v ok=%v", rec, ok)
	}
	if _, ok := pickLrclibRecordFree("NUMBER", list); ok {
		t.Fatal("自由文本选择器同样不得采纳无关曲目")
	}
	if rec, ok := pickLrclibRecordFree("【東方】Bad Apple!!", []lrclibRecord{
		{TrackName: "back number - 水平線", ArtistName: "back number", SyncedLyrics: "[00:00.00]水平線"},
		{TrackName: "【東方】Bad Apple!!", ArtistName: "kasidid2", PlainLyrics: "流れてく"},
	}); !ok || rec.ArtistName != "kasidid2" {
		t.Fatalf("自由文本应按标题挑中对的那条：%+v ok=%v", rec, ok)
	}
}

/* 检索次数必须有界：失败链（全部 404）不得无限外呼。 */
func TestV0971LyricsAttemptBudget(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			calls++ // 只统计 LRCLIB 外呼；lyrics.ovh 走 /v1/ 路径
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/api/search") {
			w.Write([]byte(`[]`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"code":404,"message":"Not Found"}`))
	}))
	defer server.Close()
	oldBase, oldOvh, oldClient, oldInterval := lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval
	lrclibBase, lyricsOvhBase = server.URL, server.URL
	lyricsMinInterval = 0
	defer func() {
		lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval = oldBase, oldOvh, oldClient, oldInterval
	}()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	if _, ok := a.scrapeAudioLyrics(context.Background(), "残酷な天使のテーゼ【MV】", "高橋洋子"); ok {
		t.Fatal("全部落空时不得返回歌词")
	}
	if calls > lyricsMaxAttempts {
		t.Fatalf("外呼次数 %d 超过上限 %d", calls, lyricsMaxAttempts)
	}
	if calls < 2 {
		t.Fatalf("应当真的尝试过多个变体，实际只调用 %d 次", calls)
	}
}

/* 歌手抓取：含假名时先请求 JP；纯汉字+拉丁的查询也要把 JP 纳入
   （实测 DAOKO×米津玄師 在 TW/US/HK 都返回 0 条，只有 JP 有结果）。 */
func TestV0971ArtistUsesJapaneseStore(t *testing.T) {
	var kanaCountries []string
	makeServer := func(record *[]string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if !strings.Contains(r.URL.Path, "/search") {
				http.NotFound(w, r)
				return
			}
			country := r.URL.Query().Get("country")
			*record = append(*record, country)
			if country == "JP" {
				// 回显查询词作为规范名：保证「直接命中」路径可用，从而证明 JP 被请求且结果被采纳
				term := r.URL.Query().Get("term")
				w.Write([]byte(`{"resultCount":1,"results":[{"artistName":` + strconv.Quote(term) + `,"artistId":777,"artworkUrl100":"https://art.example/100x100bb.jpg"}]}`))
				return
			}
			w.Write([]byte(`{"resultCount":0,"results":[]}`))
		}))
	}
	oldBase, oldClient := itunesSearchBase, outboundHTTPClient
	defer func() { itunesSearchBase, outboundHTTPClient = oldBase, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return http.DefaultClient, nil }

	itunes := makeServer(&kanaCountries)
	defer itunes.Close()
	itunesSearchBase = itunes.URL
	a := &App{}
	out, ok := a.scrapeAudioArtistItunes(context.Background(), "あいみょん")
	if !ok || out.Cover == "" {
		t.Fatalf("JP 命中必须采纳：%+v（请求过 %v）", out, kanaCountries)
	}
	if len(kanaCountries) == 0 || kanaCountries[0] != "JP" {
		t.Fatalf("含假名的歌手查询应先请求 JP：%v", kanaCountries)
	}

	var hanCountries []string
	itunes2 := makeServer(&hanCountries)
	defer itunes2.Close()
	itunesSearchBase = itunes2.URL
	a2 := &App{}
	if _, ok := a2.scrapeAudioArtistItunes(context.Background(), "DAOKO×米津玄師"); !ok {
		t.Fatalf("纯汉字+拉丁的查询也必须最终命中（请求过 %v）", hanCountries)
	}
	sawJP := false
	for _, c := range hanCountries {
		if c == "JP" {
			sawJP = true
		}
	}
	if !sawJP {
		t.Fatalf("店铺列表中必须包含 JP：%v", hanCountries)
	}
}

/* 别名表缓存：同名歌手 24h 内只查一次 MusicBrainz（批量刮削不打爆公共 API）。 */
func TestV0971ArtistAliasCache(t *testing.T) {
	var mbCalls int
	mb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mbCalls++
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"artists":[{"id":"x","name":"米津玄師","score":100,"aliases":[{"name":"Kenshi Yonezu"}]}]}`))
	}))
	defer mb.Close()
	oldMB, oldClient := audioScrapeBase, outboundHTTPClient
	audioScrapeBase = mb.URL
	defer func() { audioScrapeBase, outboundHTTPClient = oldMB, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return mb.Client(), nil }

	a := &App{}
	for i := 0; i < 3; i++ {
		names := a.audioArtistAliasNames(context.Background(), "米津玄師")
		if len(names) != 2 {
			t.Fatalf("别名应包含规范名与别名，got %v", names)
		}
	}
	if mbCalls != 1 {
		t.Fatalf("第二次起应命中内存缓存，实际请求 MusicBrainz %d 次", mbCalls)
	}
	if !audioArtistAliasMatch("Kenshi Yonezu", []string{"米津玄師", "Kenshi Yonezu"}) {
		t.Fatal("别名匹配应命中罗马音别名")
	}
	if audioArtistAliasMatch("Piano Echoes", []string{"米津玄師", "Kenshi Yonezu"}) {
		t.Fatal("不相关名字不得命中别名表")
	}
}

/* 时间上限：别名表缓存条目必须是「有时效」的，过期后重新查询。 */
func TestV0971ArtistAliasCacheExpiry(t *testing.T) {
	var mbCalls int
	mb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mbCalls++
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"artists":[{"id":"x","name":"米津玄師","score":100,"aliases":[{"name":"Kenshi Yonezu"}]}]}`))
	}))
	defer mb.Close()
	oldMB, oldClient := audioScrapeBase, outboundHTTPClient
	audioScrapeBase = mb.URL
	defer func() { audioScrapeBase, outboundHTTPClient = oldMB, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return mb.Client(), nil }

	a := &App{}
	_ = a.audioArtistAliasNames(context.Background(), "米津玄師")
	// 手工把缓存时间戳改到 25 小时前 → 必须重新查询
	a.artistAliasMu.Lock()
	a.artistAliasCache["米津玄師"] = artistAliasEntry{names: []string{"stale"}, at: time.Now().Add(-25 * time.Hour)}
	a.artistAliasMu.Unlock()
	names := a.audioArtistAliasNames(context.Background(), "米津玄師")
	if mbCalls != 2 {
		t.Fatalf("过期缓存必须重新查询，实际 %d 次", mbCalls)
	}
	if len(names) == 1 && names[0] == "stale" {
		t.Fatal("过期缓存内容不得继续返回")
	}
}

/* ================= 独立审查发现（v0.9.71 复审轮）的守卫 ================= */

/* REV-1：4 个检索词变体时，自由文本 q= 兜底必须仍然跑到。
   旧实现 lyricMaxAttempts=8 恰好被 get(4)+search(4) 吃光，q= 一次都执行不到。 */
func TestV0971LyricsFreeTextReachableWithFourVariants(t *testing.T) {
	var getCalls, searchCalls, qCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		switch {
		case strings.HasPrefix(path, "/api/get"):
			getCalls++
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"code":404,"message":"Not Found"}`))
		case strings.HasPrefix(path, "/api/search"):
			if r.URL.Query().Get("q") != "" {
				qCalls++
				w.Write([]byte(`[{"trackName":"打上花火","artistName":"uploader","syncedLyrics":"[00:00.00]あの日見た花火"}]`))
				return
			}
			searchCalls++
			w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	oldBase, oldOvh, oldClient, oldInterval := lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval
	lrclibBase, lyricsOvhBase = server.URL, server.URL
	lyricsMinInterval = 0
	defer func() {
		lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval = oldBase, oldOvh, oldClient, oldInterval
	}()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	// 带修饰的标题 + 合作演唱歌手串 → 原样/去修饰 × 整串/主歌手 共 4 个变体
	title, artist := "打上花火 (MOVIE ver.)", "DAOKO × 米津玄師"
	if got := len(audioQueryVariants(title, artist)); got != 4 {
		t.Fatalf("用例前提失效：期望 4 个检索变体，实际 %d", got)
	}
	res, ok := a.scrapeAudioLyrics(context.Background(), title, artist)
	if !ok || !strings.Contains(res.Lyrics, "あの日見た花火") {
		t.Fatalf("4 变体场景下 q= 兜底必须仍可命中：ok=%v res=%+v（get=%d search=%d q=%d）", ok, res, getCalls, searchCalls, qCalls)
	}
	if qCalls == 0 {
		t.Fatalf("q= 兜底一次都没调用（get=%d search=%d）", getCalls, searchCalls)
	}
	if getCalls > lyricsGetPhaseMax || searchCalls > lyricsSearchPhaseMax || qCalls > lyricsFreePhaseMax {
		t.Fatalf("分阶段预算被突破：get=%d search=%d q=%d", getCalls, searchCalls, qCalls)
	}
}

/* REV-7：外呼预算必须把 lyrics.ovh 也覆盖在内（旧实现的常量只管 LRCLIB 阶梯）。 */
func TestV0971LyricsBudgetCoversOvh(t *testing.T) {
	var total int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		total++
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/api/search") {
			w.Write([]byte(`[]`))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"No lyrics found"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"code":404,"message":"Not Found"}`))
	}))
	defer server.Close()
	oldBase, oldOvh, oldClient, oldInterval := lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval
	lrclibBase, lyricsOvhBase = server.URL, server.URL
	lyricsMinInterval = 0
	defer func() {
		lrclibBase, lyricsOvhBase, outboundHTTPClient, lyricsMinInterval = oldBase, oldOvh, oldClient, oldInterval
	}()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	if _, ok := a.scrapeAudioLyrics(context.Background(), "残酷な天使のテーゼ【MV】", "高橋洋子"); ok {
		t.Fatal("全部落空时不得返回歌词")
	}
	if total > lyricsMaxAttempts {
		t.Fatalf("总外呼 %d 超过预算 %d（发布说明承诺的上限必须真正生效）", total, lyricsMaxAttempts)
	}
	if total < lyricsMaxAttempts {
		t.Fatalf("只外呼了 %d 次（< %d）：说明某个阶段被提前掐断，预算没被用满", total, lyricsMaxAttempts)
	}
}

/* REV-2 / REV-9：短拉丁标题被更长的无关标题包含时不得判成同一首（会拿错歌歌词）。 */
func TestV0971LyricsTitleRejectsShortLatinContainment(t *testing.T) {
	cases := []struct {
		want, got string
		ok        bool
		why       string
	}{
		{"Rain", "Rain On Me", false, "独立审查实测：本地曲目 Rain 拿到了 Lady Gaga《Rain On Me》的歌词"},
		{"Lemon", "Lemonade", false, "短标题 ⊂ 长标题但覆盖度不足"},
		{"Rain", "Rainy Days", false, "相似度 0.44 < 0.8 阈值"},
		{"Rain", "Rain", true, "完全相同"},
		{"Lemon", "Lemon (Remastered)", true, "官方版本后缀（覆盖度 0.625→按去修饰后全等命中）"},
		{"残酷な天使のテーゼ", "残酷な天使のテーゼ (off vocal version)", true, "中日文标题允许长后缀"},
		{"说好不哭", "說好不哭", true, "等长简繁差异"},
	}
	for _, c := range cases {
		if got := audioLyricsTitleMatches(c.want, c.got); got != c.ok {
			t.Fatalf("audioLyricsTitleMatches(%q,%q) = %v, want %v（%s）", c.want, c.got, got, c.ok, c.why)
		}
	}
	// 端到端：本地没有歌手标签的短标题，不能把 q= 里第一首有歌词的无关曲目贴上去
	list := []lrclibRecord{
		{TrackName: "Rain On Me", ArtistName: "Lady Gaga", SyncedLyrics: "[00:00.00]I'd rather be dry"},
		{TrackName: "Rain", ArtistName: "The Beatles", SyncedLyrics: "[00:00.00]If the rain comes"},
	}
	rec, ok := pickLrclibRecordFree("Rain", list)
	if !ok || rec.ArtistName != "The Beatles" {
		t.Fatalf("自由文本选择器必须挑中同名记录：%+v ok=%v", rec, ok)
	}
	if rec, ok := pickLrclibRecordFree("Rain", list[:1]); ok {
		t.Fatalf("只有无关曲目时不得返回歌词：%+v", rec)
	}
	// 相似度阈值必须是 0.8 这一档（不是被悄悄放宽）
	if sim := audioLatinSimilarity("rain", "rainydays"); sim >= 0.8 || sim <= 0.3 {
		t.Fatalf("用例前提失效：rain/rainydays 相似度 %.3f 不在 (0.3, 0.8) 内", sim)
	}
}

/* REV-3：真实标题里的前导数字不能被当成音轨号裁掉（"21 Guns" → "Guns"）。 */
func TestV0971LeadingNumberKeptForRealTitles(t *testing.T) {
	keep := []string{"21 Guns", "24 Hours", "7 Years", "99 Problems", "1989", "1-800-273-8255"}
	for _, in := range keep {
		if got := audioStripDecorations(in); got != in {
			t.Fatalf("audioStripDecorations(%q) = %q，真实标题的前导数字被误裁", in, got)
		}
	}
	strip := map[string]string{"01 Song": "Song", "1. Song": "Song", "1 - Song": "Song", "01 千里之外": "千里之外"}
	for in, want := range strip {
		if got := audioStripDecorations(in); got != want {
			t.Fatalf("audioStripDecorations(%q) = %q, want %q", in, got, want)
		}
	}
	for _, v := range audioQueryVariants("21 Guns", "Green Day") {
		if v.Title == "Guns" {
			t.Fatal("不得生成「仅标题=Guns」这种被裁坏的检索变体")
		}
	}
}

/* REV-8：HEAD 请求在缓存未命中时不应真的跑 ffmpeg。 */
func TestV0971AudioStreamHeadDoesNotTranscode(t *testing.T) {
	a, _, cacheDir := newStreamTestApp(t)
	oldOK := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldOK }()

	rec := httptest.NewRecorder()
	a.audioStream(rec, httptest.NewRequest(http.MethodHead, "/api/media/audio/stream?id=l1&path=song.mp3&bitrate=128k", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD 应 200，实际 %d", rec.Code)
	}
	if rec.Header().Get("X-Vaulthub-Audio-Cache") != "would-transcode" {
		t.Fatalf("HEAD 未命中缓存应标记 would-transcode，实际 %q", rec.Header().Get("X-Vaulthub-Audio-Cache"))
	}
	entries, _ := os.ReadDir(filepath.Join(cacheDir, audioStreamCacheDirName))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".mp3") {
			t.Fatalf("HEAD 不得产出缓存文件：%s", e.Name())
		}
	}
}

/* REV-5：同键转码合并（singleflight）—— 第二个请求必须等待并复用，而不是再跑一次 ffmpeg。 */
func TestV0971AudioJobSingleflight(t *testing.T) {
	a := &App{}
	first, leader := a.beginAudioJob("/tmp/x.mp3")
	if !leader {
		t.Fatal("第一个请求必须是 leader")
	}
	second, leader2 := a.beginAudioJob("/tmp/x.mp3")
	if leader2 {
		t.Fatal("同键第二个请求不得是 leader（否则会重复转码）")
	}
	if first != second {
		t.Fatal("同键必须拿到同一个 job")
	}
	select {
	case <-second.done:
		t.Fatal("leader 未完成时 done 不应关闭")
	default:
	}
	a.finishAudioJob("/tmp/x.mp3", first)
	select {
	case <-second.done:
	default:
		t.Fatal("leader 完成后等待者必须被唤醒")
	}
	if _, leader3 := a.beginAudioJob("/tmp/x.mp3"); !leader3 {
		t.Fatal("job 完成后同键应可重新成为 leader")
	}
}

/* G7：转码队列拥塞时 503 必须带 Retry-After: 3（发布说明写的是 3 秒）。 */
func TestV0971AudioStreamBusy503RetryAfter(t *testing.T) {
	a, _, _ := newStreamTestApp(t)
	oldOK := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldOK }()

	// 直接占满全局转码闸门（容量 1），再用已取消的上下文发请求 → acquireTranscode 立即失败
	a.transcodeSemOnce.Do(func() {})
	a.transcodeSem = make(chan struct{}, 1)
	a.transcodeSem <- struct{}{}
	defer func() { <-a.transcodeSem }()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/media/audio/stream?id=l1&path=song.mp3&bitrate=128k", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	a.audioStream(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("拥塞时应 503，实际 %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "3" {
		t.Fatalf("Retry-After 应为 3，实际 %q", got)
	}
}
