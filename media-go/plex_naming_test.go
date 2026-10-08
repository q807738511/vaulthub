package main

import (
	"strings"
	"testing"
)

/* v0.9.97：Plex 口径剧集命名引擎的单元测试。
   覆盖指南里的每一条规则，重点是「多季不错位、缺集能发现、命名问题能报出来」。 */

func TestPlexStripBrackets(t *testing.T) {
	cases := []struct{ in, want string }{
		{"[YYDS]The Flash - s01e01.mkv", "The Flash - s01e01.mkv"},
		{"Show - s01e01 [1080p].mkv", "Show - s01e01 .mkv"},
		{"【字幕组】Show - s01e01", "Show - s01e01"},
		{"Show - s01e01", "Show - s01e01"},
	}
	for _, c := range cases {
		if got := plexStripBrackets(c.in); got != c.want {
			t.Fatalf("plexStripBrackets(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPlexBracketSeasonEpisodeDetection(t *testing.T) {
	/* 方括号里才有季集号 —— Plex 直接忽略，属于高危命名。 */
	if got := plexBracketSeasonEpisode("Show [s01e05].mkv"); got != "[s01e05]" {
		t.Fatalf("方括号季集号应被检出，got %q", got)
	}
	if got := plexBracketSeasonEpisode("Show - s01e05 [1080p].mkv"); got != "" {
		t.Fatalf("方括号内只有规格信息不应误判，got %q", got)
	}
	if got := plexBracketSeasonEpisode("Show - s01e05.mkv"); got != "" {
		t.Fatalf("无方括号不应命中，got %q", got)
	}
}

func TestPlexParseShowDir(t *testing.T) {
	cases := []struct {
		dir       string
		title     string
		year      string
		tagSeason int
	}{
		{"The Flash (2014)", "The Flash", "2014", -1},
		{"The Flash（2014）", "The Flash", "2014", -1},
		{"The Big Bang Theory (2007)", "The Big Bang Theory", "2007", -1},
		{"老友记 (1994)", "老友记", "1994", -1},
		{"幽游白书S04", "幽游白书", "", 4},
		{"幽游白书 第3季", "幽游白书", "", 3},
		{"幽游白书S01 (1992)", "幽游白书", "1992", 1},
		{"名侦探柯南", "名侦探柯南", "", -1},
		{"", "", "", -1},
	}
	for _, c := range cases {
		title, year, tag := plexParseShowDir(c.dir)
		if title != c.title || year != c.year || tag != c.tagSeason {
			t.Fatalf("plexParseShowDir(%q) = (%q,%q,%d), want (%q,%q,%d)", c.dir, title, year, tag, c.title, c.year, c.tagSeason)
		}
	}
}

func TestPlexParseSeasonDir(t *testing.T) {
	ok := map[string]int{
		"Season 01": 1, "Season 1": 1, "season 12": 12, "S03": 3, "s3": 3,
		"第 3 季": 3, "第三季": 3, "第十二季": 12,
		"Season 00": 0, "Specials": 0, "Special": 0, "特别篇": 0, "花絮": 0,
	}
	for dir, want := range ok {
		got, good := plexParseSeasonDir(dir)
		if !good || got != want {
			t.Fatalf("plexParseSeasonDir(%q) = (%d,%v), want (%d,true)", dir, got, good, want)
		}
	}
	for _, bad := range []string{"", "Season", "第三", "Extras 2", "第一集", "SP2"} {
		if _, good := plexParseSeasonDir(bad); good {
			t.Fatalf("plexParseSeasonDir(%q) 不应识别为季目录", bad)
		}
	}
}

func TestPlexParseEpisodeTagForms(t *testing.T) {
	cases := []struct {
		stem      string
		dirSeason int
		season    int
		ep        int
		end       int
		multi     bool
		title     string
		by        string
	}{
		{"The Big Bang Theory - s03e05 - 浴室里的心理学", -1, 3, 5, 0, false, "浴室里的心理学", "sxxexx"},
		{"神盾局特工 - s02e18-e19", -1, 2, 18, 19, true, "", "sxxexx"},
		{"Show s02e18-19", -1, 2, 18, 19, true, "", "sxxexx"},
		{"老友记 - s05e12 - 瑞秋的妹妹", -1, 5, 12, 0, false, "瑞秋的妹妹", "sxxexx"},
		{"FRIENDS 5x12 The One", -1, 5, 12, 0, false, "The One", "x"},
		{"剧名 第 2 季 第 7 集 大结局", -1, 2, 7, 0, false, "大结局", "cn"},
		{"剧名.第7集", 2, 2, 7, 0, false, "", "cn_ep"},
		{"Show - E05", 3, 3, 5, 0, false, "", "e"},
		{"Show.E05.1080p", 1, 1, 5, 0, false, "", "e"},
		{"01", 2, 2, 1, 0, false, "", "number"},
		{"Show - s01e01 - Title - 1080p WEB-DL x265", -1, 1, 1, 0, false, "Title", "sxxexx"},
	}
	for _, c := range cases {
		tag := plexParseEpisodeTag(c.stem, c.dirSeason)
		if tag.Season != c.season || tag.Episode != c.ep || tag.EpisodeEnd != c.end || tag.Multi != c.multi || tag.Title != c.title || tag.By != c.by {
			t.Fatalf("plexParseEpisodeTag(%q, dir=%d) = %+v, want season=%d ep=%d end=%d multi=%v title=%q by=%s",
				c.stem, c.dirSeason, tag, c.season, c.ep, c.end, c.multi, c.title, c.by)
		}
	}
	/* E05 简写在没有季目录时 Plex 不认 —— 我们也不认（否则整库电影都会被当剧集）。 */
	if tag := plexParseEpisodeTag("Movie.Name.E05", -1); tag.Episode != 0 {
		t.Fatalf("无季目录时不应接受 E05 简写，got %+v", tag)
	}
}

func TestPlexParseRelSeasonFromDirectory(t *testing.T) {
	/* Plex 口径：季目录是权威 —— 目录写 Season 03 时文件名里的 s02 不生效。 */
	e := plexParseRel("The Flash (2014)/Season 03/The Flash - s02e05 - 标题.mkv")
	if e == nil {
		t.Fatal("解析结果不应为空")
	}
	if e.Season != 3 {
		t.Fatalf("季号应取季目录（3），got %d", e.Season)
	}
	if e.Episode != 5 || e.EpisodeTitle != "标题" {
		t.Fatalf("集号/分集名解析错误：%+v", e)
	}
	if e.ShowTitle != "The Flash" || e.ShowYear != "2014" {
		t.Fatalf("剧名/年份解析错误：%q / %q", e.ShowTitle, e.ShowYear)
	}
	if e.SeasonDir != "Season 03" {
		t.Fatalf("季目录应记录 Season 03，got %q", e.SeasonDir)
	}
	if !strings.Contains(e.EpisodeLabel, "S03E05") {
		t.Fatalf("集标签应为 S03E05，got %q", e.EpisodeLabel)
	}
}

func TestPlexParseRelSpecials(t *testing.T) {
	e := plexParseRel("The Flash (2014)/Specials/The Flash - s00e02 - 花絮.mkv")
	if e == nil || e.Season != 0 {
		t.Fatalf("Specials 必须映射到第 0 季，got %+v", e)
	}
	if e.SeasonDir != "Specials" || !strings.Contains(e.EpisodeLabel, "S00E02") {
		t.Fatalf("特别篇标签错误：%+v", e)
	}
	e2 := plexParseRel("The Flash (2014)/Season 00/The Flash - s00e02.mkv")
	if e2 == nil || e2.Season != 0 {
		t.Fatalf("Season 00 也必须映射到第 0 季，got %+v", e2)
	}
}

func TestPlexParseRelNoSeasonDirFallbackToFilename(t *testing.T) {
	/* 解析失败 → 以文件名展示（不吞条目）。 */
	e := plexParseRel("老剧合集/某某剧 第一集.mkv")
	if e == nil {
		t.Fatal("解析结果不应为空")
	}
	if e.Display != "某某剧 第一集" {
		t.Fatalf("解析失败时应以文件名展示，got %q", e.Display)
	}
	if e.Compliant {
		t.Fatal("无季集标记的文件不应判为合规")
	}
	if len(e.Issues) == 0 || !strings.Contains(strings.Join(e.Issues, "|"), "没有可识别的季集标记") {
		t.Fatalf("应给出「无季集标记」问题，got %v", e.Issues)
	}
}

func TestPlexPlanMultiSeasonGrouping(t *testing.T) {
	rels := []string{
		"The Flash (2014)/Season 01/The Flash - s01e01 - 试播集.mkv",
		"The Flash (2014)/Season 01/The Flash - s01e02 - 快如闪电.mkv",
		"The Flash (2014)/Season 02/The Flash - s02e01 - 新起点.mkv",
		"The Flash (2014)/Season 03/The Flash - s03e01 - 闪点.mkv",
		"The Flash (2014)/Specials/The Flash - s00e01 - 幕后.mkv",
		"老友记 (1994)/Season 01/老友记 - s01e01 - 瑞秋来了.mkv",
		"A Movie (2020)/A Movie (2020) 1080p.mkv", /* 电影条目不应混进剧集方案 */
	}
	plan := plexPlanFromPaths(rels)
	if plan.ShowNum != 2 {
		t.Fatalf("应聚合成 2 部剧，got %d（%v）", plan.ShowNum, func() []string {
			out := []string{}
			for _, s := range plan.Shows {
				out = append(out, s.Title)
			}
			return out
		}())
	}
	var flash *plexShowGroup
	for _, s := range plan.Shows {
		if s.Title == "The Flash" {
			flash = s
		}
	}
	if flash == nil {
		t.Fatal("未找到 The Flash")
	}
	if !flash.MultiSeason || flash.SeasonCount != 4 {
		t.Fatalf("The Flash 应有 4 个季（含特别篇），got %d 季 multi=%v", flash.SeasonCount, flash.MultiSeason)
	}
	if !flash.HasSpecials {
		t.Fatal("应识别出特别篇（第 0 季）")
	}
	if flash.Seasons[0].Season != 0 {
		t.Fatalf("季列表应按季号升序，特别篇在最前，got %d", flash.Seasons[0].Season)
	}
	if flash.Year != "2014" {
		t.Fatalf("年份应解析为 2014，got %q", flash.Year)
	}
	if plan.MultiSeasonNum != 1 {
		t.Fatalf("多季剧集数应为 1，got %d", plan.MultiSeasonNum)
	}
	if flash.EpisodeNum != 5 {
		t.Fatalf("The Flash 集数应为 5，got %d", flash.EpisodeNum)
	}
}

func TestPlexPlanMergesYearSuffixVariants(t *testing.T) {
	/* `The Flash (2014)` 与 `The Flash 2014` 必须归到同一部剧 —— 同名不同写法不能拆卡。 */
	rels := []string{
		"The Flash (2014)/Season 01/The Flash - s01e01.mkv",
		"The Flash 2014/Season 02/The Flash - s02e01.mkv",
	}
	plan := plexPlanFromPaths(rels)
	if plan.ShowNum != 1 {
		t.Fatalf("年份写法不同不应拆成两部剧，got %d", plan.ShowNum)
	}
	if plan.Shows[0].SeasonCount != 2 {
		t.Fatalf("应聚合出 2 季，got %d", plan.Shows[0].SeasonCount)
	}
	if len(plan.Shows[0].Dirs) != 2 {
		t.Fatalf("两个剧根目录都应记录，got %v", plan.Shows[0].Dirs)
	}
}

func TestPlexPlanMergesSeasonTagDirs(t *testing.T) {
	/* v0.9.94 的季标签写法（幽游白书S01 / 幽游白书S04）仍要归到同一部剧。 */
	rels := []string{
		"幽游白书S01/幽游白书 - s01e01.mkv",
		"幽游白书S04/幽游白书 - s04e01.mkv",
	}
	plan := plexPlanFromPaths(rels)
	if plan.ShowNum != 1 {
		t.Fatalf("季标签目录应归到同一部剧，got %d 部", plan.ShowNum)
	}
	show := plan.Shows[0]
	if show.Title != "幽游白书" {
		t.Fatalf("剧名应去掉季标签，got %q", show.Title)
	}
	if show.SeasonCount != 2 {
		t.Fatalf("应有 2 季，got %d", show.SeasonCount)
	}
	seasons := []int{}
	for _, s := range show.Seasons {
		seasons = append(seasons, s.Season)
	}
	if len(seasons) != 2 || seasons[0] != 1 || seasons[1] != 4 {
		t.Fatalf("季号应来自目录季标签（1 与 4），got %v", seasons)
	}
}

func TestPlexMultiEpisodeFileCoversBothNumbers(t *testing.T) {
	/* s02e18-e19：一个文件关联两集，本地集号要同时包含 18 与 19（缺失集比对才不会误报）。 */
	plan := plexPlanFromPaths([]string{"神盾局特工 (2013)/Season 02/神盾局特工 - s02e18-e19.mkv"})
	if plan.ShowNum != 1 {
		t.Fatalf("应聚合成 1 部剧，got %d", plan.ShowNum)
	}
	season := plan.Shows[0].Seasons[0]
	if len(season.Numbers) != 2 || season.Numbers[0] != 18 || season.Numbers[1] != 19 {
		t.Fatalf("多集合并文件应覆盖 18、19，got %v", season.Numbers)
	}
	if season.NumbersTag != "E18、E19" {
		t.Fatalf("集号标签应为 E18、E19，got %q", season.NumbersTag)
	}
	if !season.Episodes[0].Multi {
		t.Fatal("应标记为多集合并文件")
	}
}

func TestPlexEpisodeRanges(t *testing.T) {
	cases := []struct{ in []int; want string }{
		{[]int{1, 2, 3}, "E01-E03"},
		{[]int{1, 2, 4}, "E01、E02、E04"},
		{[]int{7, 8, 9, 12}, "E07-E09、E12"},
		{[]int{}, ""},
		{[]int{3, 3, 2}, "E02、E03"},
	}
	for _, c := range cases {
		if got := plexEpisodeRanges(c.in); got != c.want {
			t.Fatalf("plexEpisodeRanges(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPlexMissingEpisodes(t *testing.T) {
	got := plexMissingEpisodes([]int{1, 2, 3, 5, 6}, 9)
	want := []int{4, 7, 8, 9}
	if len(got) != len(want) {
		t.Fatalf("缺失集数量不符：got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("缺失集不符：got %v want %v", got, want)
		}
	}
	if len(plexMissingEpisodes([]int{1, 2}, 0)) != 0 {
		t.Fatal("官方集数未知时不应臆造缺失集")
	}
	if label := plexMissingLabel(3, []int{7, 8, 9, 12}); label != "S03E07-E09、S03E12" {
		t.Fatalf("缺失标签错误：%q", label)
	}
}

func TestPlexIssuesForBadNaming(t *testing.T) {
	/* 方括号内季集号 + 纯数字命名 + 剧根无年份，三类问题都要报出来并给建议路径。 */
	e := plexParseRel("[YYDS]某剧 (2019)/Season 02/[YYDS]某剧 [s02e05] 1080p.mkv")
	if e == nil {
		t.Fatal("解析结果不应为空")
	}
	if e.Compliant {
		t.Fatal("方括号内季集号必须判为不合规")
	}
	joined := strings.Join(e.Issues, "|")
	if !strings.Contains(joined, "方括号") {
		t.Fatalf("应报告方括号问题，got %v", e.Issues)
	}
	if e.Suggested == "" || !strings.Contains(e.Suggested, "Season 02") || !strings.Contains(e.Suggested, "s02e05") {
		t.Fatalf("建议路径应含规范季目录与 s02e05，got %q", e.Suggested)
	}
	if strings.Contains(e.Suggested, "[") {
		t.Fatalf("建议路径不应保留方括号，got %q", e.Suggested)
	}

	/* 每部剧自己的不合规清单必须落在 show.Issues 上（前端「命名体检」直接渲染这一段）。 */
	plan := plexPlanFromPaths([]string{"[YYDS]某剧 (2019)/Season 01/[YYDS]某剧 [s02e05] 1080p.mkv", "某剧 (2019)/Season 01/某剧 - s01e01.mkv"})
	if plan.ShowNum != 1 || len(plan.Shows[0].Issues) != 1 || plan.Shows[0].IssueNum != 1 {
		t.Fatalf("每剧问题清单落点错误：show=%d issues=%d issue_num=%d", plan.ShowNum, len(plan.Shows[0].Issues), plan.Shows[0].IssueNum)
	}
	if plan.Shows[0].Issues[0].Suggested == "" {
		t.Fatal("不合规条目应带建议路径")
	}

	num := plexParseRel("某剧 (2019)/Season 01/03.mkv")
	if num == nil || num.Episode != 3 {
		t.Fatalf("季目录内纯数字应兜底为第 3 集，got %+v", num)
	}
	if num.Compliant || !strings.Contains(strings.Join(num.Issues, "|"), "纯数字") {
		t.Fatalf("纯数字命名应判为需改名，got %v", num.Issues)
	}
}

func TestPlexPlanIgnoresNonMediaAndDiscStructure(t *testing.T) {
	rels := []string{
		"The Flash (2014)/Season 01/poster.jpg",
		"The Flash (2014)/Season 01/tvshow.nfo",
		"The Flash (2014)/Season 01/The Flash - s01e01.mkv",
		"The Flash (2014)/Season 01/BDMV/STREAM/00001.m2ts",
	}
	plan := plexPlanFromPaths(rels)
	if plan.EpisodeNum != 1 {
		t.Fatalf("只有 1 个真实视频条目应进方案，got %d", plan.EpisodeNum)
	}
}

func TestPlexShowKeyNormalization(t *testing.T) {
	a := plexShowKey("The Flash", "2014")
	b := plexShowKey("the.flash", "2014")
	c := plexShowKey("The Flash", "")
	if a != b {
		t.Fatalf("剧名归一化后应相同：%q vs %q", a, b)
	}
	if a == c {
		t.Fatalf("年份不同不应合成同一部剧：%q", a)
	}
}

func TestPlexSeasonMissingReport(t *testing.T) {
	plan := plexPlanFromPaths([]string{
		"某剧 (2019)/Season 01/某剧 - s01e01.mkv",
		"某剧 (2019)/Season 01/某剧 - s01e02.mkv",
		"某剧 (2019)/Season 02/某剧 - s02e01.mkv",
	})
	show := plan.Shows[0]
	report := plexSeasonMissingReport(show, map[int]int{1: 4, 2: 0})
	if len(report) != 2 {
		t.Fatalf("应返回 2 季的比对结果，got %d", len(report))
	}
	s1 := report[0]
	if s1.OfficialCount != 4 || len(s1.Missing) != 2 || s1.Missing[0] != 3 || s1.Missing[1] != 4 {
		t.Fatalf("第一季应缺 3、4 集，got %+v", s1)
	}
	if s1.Complete {
		t.Fatal("缺集时 complete 应为 false")
	}
	if s1.MissingLabel != "S01E03、S01E04" {
		t.Fatalf("缺失标签错误：%q", s1.MissingLabel)
	}
	if report[1].OfficialCount != 0 || report[1].Complete {
		t.Fatalf("官方集数未知时不应判为完整，got %+v", report[1])
	}
}
