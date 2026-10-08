package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

/* v0.9.97：Plex 口径的剧集目录结构与命名引擎（多季剧集精准刮削）。
 *
 * 客户要求「参考 PLEX 剧集刮削策略对多季剧集进行刮削」，本文件把 Plex 的识别规则
 * 落到可执行、可测试的代码上，作为「多季诊断 / 命名体检 / 缺失集比对」的唯一判定来源：
 *
 *   1. 目录结构
 *      - 剧集库根目录只放剧集文件夹，不设「美剧/国产剧」这类分类层（分类层会让
 *        剧根判定落到分类目录上，同一部剧的季被拆到不同剧根）；
 *      - 剧根目录命名 `剧集名 (首播年份)`，例如 `The Flash (2014)`；
 *      - 每季一个 `Season XX` 子目录（也接受 `S03` / `第 3 季`）；
 *      - 特别篇 / 花絮放 `Season 00`（等价 `Specials` / `特别篇`），统一映射为第 0 季。
 *
 *   2. 文件命名
 *      - 通用格式 `剧集名 - sXXeYY - 可选信息.ext`；
 *      - 多集合并 `sXXeYY-eZZ`（一个文件含连续多集，元数据同时关联两集）；
 *      - **方括号内容会被 Plex 完全忽略** —— 季集信息写进 `[...]`/`【...】` 里
 *        必然识别失败，因此解析前先整体剥离方括号内容，并把「方括号里才有季集号」
 *        单独判为高危命名问题；
 *      - 兼容 `1x02`（X 形式）、`第 X 季第 Y 集`、季目录内的 `E05` 简写；
 *      - 纯数字命名（`01.mkv`）Plex 不认 —— 判为歧义命名并给出建议名；
 *      - 完全解析不出季集的文件，展示时直接以**文件名**为准（不吞条目不丢内容）。
 *
 *   3. 缺失集比对
 *      - 本地集号集合 vs 官方集数（TMDB 该季最大集号）→ 缺失集清单 + `E07-E09` 压缩标签，
 *        对应指南里的 PlexMissingEpisodes 批量校验思路。
 *
 * 纯函数实现，无 IO：解析规则全部可被 media-go/plex_naming_test.go 直接覆盖。
 */

// plexMediaExt 参与剧集聚合的视频扩展名。
var plexMediaExt = map[string]bool{
	".mp4": true, ".mkv": true, ".avi": true, ".mov": true, ".m4v": true,
	".webm": true, ".ts": true, ".m2ts": true, ".mpg": true, ".mpeg": true, ".wmv": true, ".flv": true, ".rmvb": true,
}

// plexIsMediaExt 报告扩展名（含点，大小写不敏感）是否为可播放视频。
func plexIsMediaExt(ext string) bool { return plexMediaExt[strings.ToLower(ext)] }

var (
	/* 方括号（含全角）整体剥离：Plex 完全忽略方括号内容。 */
	plexBracketRe = regexp.MustCompile(`\[[^\]]*\]|【[^】]*】`)

	/* 剧根目录的年份后缀：`剧集名 (2014)` / `剧集名（2014）` / `剧集名.2014` / `剧集名 2014`。 */
	plexYearSuffixRe = regexp.MustCompile(`(?i)^(.*?)[\s._\-]*[（(\[【]?\s*(19\d{2}|20\d{2})\s*[)）\]】]?$`)

	/* 季目录：`Season 03` / `season3` / `S03`。 */
	plexSeasonDirRe = regexp.MustCompile(`(?i)^(?:season|s)\s*0*(\d{1,2})$`)
	/* 中文季目录：`第 3 季` / `第三季` / `第4部`。 */
	plexSeasonCnDirRe = regexp.MustCompile(`^第\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*[季部]$`)
	/* 特别篇目录：`Season 00` 之外的所有写法都归到第 0 季。 */
	plexSpecialDirRe = regexp.MustCompile(`(?i)^(?:specials?|sp|s00|extras?|特别篇|特別篇|特别集|特典|花絮|番外)$`)

	/* 剧根目录里带的季标签（沿用 v0.9.94 的「幽游白书S04」约定）：`剧名S04` / `剧名 第4季`。 */
	plexShowSeasonTagRe = regexp.MustCompile(`(?i)^(.*?)[\s._\-·、，,]*s\s*0*(\d{1,2})(?:[\s._\-]*e\s*\d{1,3})?$`)
	plexShowSeasonCnRe  = regexp.MustCompile(`^(.*?)[\s._\-·、，,]*第\s*([0-9]{1,2})\s*季$`)

	/* 季集标记，按可信度从高到低匹配。 */
	plexEpSERe  = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])s\s*(\d{1,2})\s*e\s*(\d{1,3})(?:\s*[-–—~_]\s*(?:e|ep)?\s*(\d{1,3}))?`)
	plexEpXRe   = regexp.MustCompile(`(?i)(?:^|[^0-9a-z])(\d{1,2})\s*x\s*(\d{1,3})(?:\s*[-–—~]\s*(\d{1,3}))?`)
	plexEpCnRe  = regexp.MustCompile(`第\s*(\d{1,2})\s*季\s*第\s*(\d{1,3})\s*[集话話]`)
	plexEpCnRe2 = regexp.MustCompile(`第\s*(\d{1,3})\s*[集话話]`)
	plexEpERe   = regexp.MustCompile(`(?i)(?:^|[\s._\-])e(?:p)?\s*(\d{1,3})(?:\s*[-–—~]\s*(?:e|ep)?\s*(\d{1,3}))?(?:[\s._\-]|$)`)
	/* 纯数字命名（仅在有季目录时才有意义，Plex 不认这种写法）。 */
	plexBareNumRe = regexp.MustCompile(`(?i)^(?:^|[\s._\-])(\d{1,3})(?:[\s._\-]|$)`)

	/* 分集标题里的发布组/规格噪声，展示前剔除。 */
	plexNoiseRe = regexp.MustCompile(`(?i)\b(2160p|1080p|1080i|720p|480p|4k|8k|uhd|hdr10\+?|hdr|dv|dolby[ .]?vision|remux|blu-?ray|bdrip|brrip|web-?rip|web-?dl|hdtv|dvdrip|x26[45]|h ?26[45]|hevc|avc|aac|ac3|eac3|dts(?:-hd)?|truehd|atmos|flac|10bit|8bit|repack|proper|imax|chs|cht|eng|中字|国语|粤语|双语)\b`)
	plexSepRe   = regexp.MustCompile(`[\s._\-–—]+`)
)

// plexEpisodeTag 是从一个文件名里提取出的季集信息。
type plexEpisodeTag struct {
	Season     int    // 季号；<0 表示文件名里没有季号
	Episode    int    // 集号；0 表示没识别出集号
	EpisodeEnd int    // 多集合并文件（sXXeYY-eZZ）的结束集号；非多集时为 0
	Multi      bool   // 是否多集合并
	Title      string // 标记之后的分集标题（已经去掉噪声与方括号）
	By         string // 命中来源：sxxexx / x / cn / e / number
}

// plexSeasonLabel 把季号翻译成界面标签。第 0 季是 Plex 的特别篇季。
func plexSeasonLabel(season int) string {
	if season <= 0 {
		return "特别篇"
	}
	return fmt.Sprintf("第 %d 季", season)
}

// plexSeasonTag 返回 `S00` / `S03` 形式的季标签。
func plexSeasonTag(season int) string {
	if season < 0 {
		season = 0
	}
	return fmt.Sprintf("S%02d", season)
}

// plexSeasonDirName 返回该季在 Plex 口径下的标准目录名。
func plexSeasonDirName(season int) string { return fmt.Sprintf("Season %02d", season) }

/* plexStripBrackets 剥离方括号（含全角）及其内容 —— Plex 完全忽略方括号内容，
   解析前剥离既符合其行为，也避免把发布组名误当剧名。 */
func plexStripBrackets(s string) string {
	if s == "" {
		return ""
	}
	out := plexBracketRe.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(out), " ")
}

/* plexBracketSeasonEpisode 报告「季集信息只写在方括号里」的情况并返回该片段。
   这是指南里点名的致命命名：方括号内会被 Plex 完全忽略，季集信息等于不存在。 */
func plexBracketSeasonEpisode(s string) string {
	for _, m := range plexBracketRe.FindAllString(s, -1) {
		inner := strings.Trim(m, "[]【】")
		if tag := plexParseEpisodeTag(inner, -1); tag.Episode > 0 {
			return m
		}
	}
	return ""
}

/* plexStripBracketsKeepInner 与 plexStripBrackets 的区别：把方括号内容替换成空格但保留
   内容本身已剥离；这里用于需要检测「方括号里才有季集号」的场景（先无损检测再剥离）。 */
func plexCleanStem(stem string) string {
	return strings.Join(strings.Fields(plexStripBrackets(stem)), " ")
}

/* plexParseShowDir 解析剧根目录名 → 剧名 + 首播年份 + 目录里带的季标签。
   兼容 `The Flash (2014)`、`The Flash（2014）`、`The Flash 2014` 以及
   v0.9.94 引入的 `幽游白书S04` / `幽游白书 第4季` 季标签写法。 */
func plexParseShowDir(dir string) (title string, year string, tagSeason int) {
	title = strings.TrimSpace(plexCleanStem(dir))
	tagSeason = -1
	/* 先摘掉年份后缀，再摘季标签 —— `幽游白书S01 (1992)` 这种「季标签 + 年份」的顺序
	   只有先去掉年份才能把 S01 认成季标签（季标签正则要求落在目录名末尾）。 */
	if m := plexYearSuffixRe.FindStringSubmatch(title); m != nil {
		base := strings.TrimRight(strings.TrimSpace(m[1]), " ._-·、，,")
		if base != "" {
			title = base
			year = m[2]
		}
	}
	/* 季标签（沿用 v0.9.94 的「幽游白书S04」约定）不能当剧名的一部分。 */
	if m := plexShowSeasonTagRe.FindStringSubmatch(title); m != nil {
		base := strings.TrimRight(strings.TrimSpace(m[1]), " ._-·、，,")
		if base != "" {
			title = base
			if n, err := strconv.Atoi(m[2]); err == nil && n >= 0 && n <= 99 {
				tagSeason = n
			}
		}
	} else if m := plexShowSeasonCnRe.FindStringSubmatch(title); m != nil {
		base := strings.TrimRight(strings.TrimSpace(m[1]), " ._-·、，,")
		if base != "" {
			title = base
			if n, err := strconv.Atoi(m[2]); err == nil && n >= 0 && n <= 99 {
				tagSeason = n
			}
		}
	}
	title = strings.Join(strings.Fields(title), " ")
	return title, year, tagSeason
}

/* plexParseSeasonDir 解析季目录名 → 季号。
   `Season 03` / `S03` / `第 3 季` → 3；`Season 00` / `Specials` / `特别篇` → 0。 */
func plexParseSeasonDir(dir string) (int, bool) {
	d := strings.TrimSpace(dir)
	if d == "" {
		return 0, false
	}
	if plexSpecialDirRe.MatchString(d) {
		return 0, true
	}
	if m := plexSeasonDirRe.FindStringSubmatch(d); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil && n >= 0 && n <= 99 {
			return n, true
		}
		return 0, false
	}
	if m := plexSeasonCnDirRe.FindStringSubmatch(d); m != nil {
		if n, ok := plexCnNumber(m[1]); ok && n >= 0 && n <= 99 {
			return n, true
		}
		return 0, false
	}
	return 0, false
}

/* plexCnNumber 解析阿拉伯数字或中文数字（一到九十九）。
   中文季目录在国产剧里很常见（`第十二季`），只认简单形式。 */
func plexCnNumber(raw string) (int, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n, true
	}
	digits := map[rune]int{'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
	total, seen := 0, false
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if r == '十' {
			seen = true
			if total == 0 {
				total = 1
			}
			total *= 10
			continue
		}
		v, ok := digits[r]
		if !ok {
			return 0, false
		}
		seen = true
		if i+1 < len(runes) && runes[i+1] == '十' {
			total += v * 10
			i++
			continue
		}
		total += v
	}
	if !seen {
		return 0, false
	}
	return total, true
}

/* plexParseEpisodeTag 从（去掉扩展名与方括号的）文件主干里提取季集信息。
   dirSeason 是季目录给出的季号（<0 表示没有季目录），用于补齐 `E05` / 纯数字这类缺季写法。
   匹配顺序即可信度顺序：sXXeYY > XXxYY > 第X季第Y集 > 第Y集 > E05 > 纯数字。 */
func plexParseEpisodeTag(stem string, dirSeason int) plexEpisodeTag {
	tag := plexEpisodeTag{Season: -1}
	if stem == "" {
		return tag
	}
	assign := func(m []string, by string, hasSeason bool) {
		var season, ep, end int
		if hasSeason {
			season, _ = strconv.Atoi(m[1])
			ep, _ = strconv.Atoi(m[2])
			if len(m) > 3 && m[3] != "" {
				end, _ = strconv.Atoi(m[3])
			}
		} else {
			season = dirSeason
			ep, _ = strconv.Atoi(m[1])
			if len(m) > 2 && m[2] != "" {
				end, _ = strconv.Atoi(m[2])
			}
		}
		tag.Season, tag.Episode, tag.By = season, ep, by
		if end > 0 && end != ep {
			if end < ep {
				ep, end = end, ep
				tag.Episode = ep
			}
			tag.EpisodeEnd, tag.Multi = end, true
		}
	}
	if m := plexEpSERe.FindStringSubmatch(stem); m != nil {
		assign(m, "sxxexx", true)
		tag.Title = plexEpisodeTitleAfter(stem, m[0])
		return tag
	}
	if m := plexEpXRe.FindStringSubmatch(stem); m != nil {
		assign(m, "x", true)
		tag.Title = plexEpisodeTitleAfter(stem, m[0])
		return tag
	}
	if m := plexEpCnRe.FindStringSubmatch(stem); m != nil {
		assign(m, "cn", true)
		tag.Title = plexEpisodeTitleAfter(stem, m[0])
		return tag
	}
	if m := plexEpCnRe2.FindStringSubmatch(stem); m != nil {
		assign(m, "cn_ep", false)
		tag.Title = plexEpisodeTitleAfter(stem, m[0])
		return tag
	}
	/* E05 简写：Plex 只在能确定季（季目录或剧根季标签）时才认这种写法。 */
	if m := plexEpERe.FindStringSubmatch(stem); m != nil && dirSeason >= 0 {
		assign(m, "e", false)
		tag.Title = plexEpisodeTitleAfter(stem, m[0])
		return tag
	}
	/* 纯数字命名：Plex 不认，只在有季目录时按序数兜底，并单独判为歧义命名。 */
	if dirSeason >= 0 {
		if m := plexBareNumRe.FindStringSubmatch(stem); m != nil {
			assign(m, "number", false)
			return tag
		}
	}
	return tag
}

/* plexEpisodeTitleAfter 取标记之后的部分当分集标题（`剧集名 - s03e05 - 标题.ext` 里的标题）。
   标记后面没有内容时返回空串，由调用方决定用文件名兜底。 */
func plexEpisodeTitleAfter(stem, token string) string {
	idx := strings.Index(stem, token)
	if idx < 0 {
		return ""
	}
	rest := stem[idx+len(token):]
	rest = strings.TrimLeft(rest, " \t._-–—~[]【】")
	return plexCleanEpisodeTitle(rest)
}

/* plexCleanEpisodeTitle 去掉噪声标记与分隔符，并限长（Plex/界面都不需要超长标题）。 */
func plexCleanEpisodeTitle(raw string) string {
	s := plexNoiseRe.ReplaceAllString(raw, " ")
	s = plexSepRe.ReplaceAllString(s, " ")
	s = strings.Trim(s, " \t-_.")
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > 120 {
		s = string([]rune(s)[:120])
	}
	return s
}

// plexEpisodeEntry 是一条剧集文件的解析结果（含合规判定与建议名）。
type plexEpisodeEntry struct {
	Path         string   `json:"path"`         // 库内相对路径
	ShowDir      string   `json:"show_dir"`     // 剧根目录（库内相对）
	ShowTitle    string   `json:"show_title"`   // 剧名（已去季标签与年份）
	ShowYear     string   `json:"show_year"`    // 首播年份（目录没写时为空）
	Season       int      `json:"season"`       // 季号（0 = 特别篇）
	SeasonDir    string   `json:"season_dir"`   // 季目录名（没有季目录时为空）
	Episode      int      `json:"episode"`      // 集号（0 = 未识别）
	EpisodeEnd   int      `json:"episode_end"`  // 多集合并的结束集号
	Multi        bool     `json:"multi"`        // sXXeYY-eZZ 多集合并
	EpisodeTitle string   `json:"episode_title"`
	Display      string   `json:"display"`      // 界面展示名：分集名优先，失败以文件名展示
	EpisodeLabel string   `json:"episode_label"`// S03E05 / S02E18-E19 / 文件名兜底
	Compliant    bool     `json:"compliant"`    // 是否符合 Plex 命名规范
	Issues       []string `json:"issues"`       // 中文问题清单（空 = 无问题）
	Suggested    string   `json:"suggested"`    // 不合规时的建议相对路径
}

// plexSeasonGroup / plexShowGroup 是聚合后的多季结构。
type plexSeasonGroup struct {
	Season     int                `json:"season"`
	Label      string             `json:"label"`
	Tag        string             `json:"tag"`
	Dir        string             `json:"dir"`
	Special    bool               `json:"special"`
	Count      int                `json:"count"`
	Numbers    []int              `json:"numbers"`     // 本地已有集号（升序去重）
	NumbersTag string             `json:"numbers_tag"` // E01-E03、E05 压缩标签
	Episodes   []*plexEpisodeEntry `json:"episodes"`
}

type plexShowGroup struct {
	Key         string            `json:"key"`
	Title       string            `json:"title"`
	Year        string            `json:"year"`
	Dirs        []string          `json:"dirs"`
	SeasonCount int               `json:"season_count"`
	MultiSeason bool              `json:"multi_season"`
	HasSpecials bool              `json:"has_specials"`
	EpisodeNum  int               `json:"episode_num"`
	IssueNum    int               `json:"issue_num"`
	Seasons     []*plexSeasonGroup `json:"seasons"`
	/* 该剧自己的不合规条目（前端「命名体检」直接渲染这一段；
	   全库汇总在 plexPlan.Issues，避免前端再去过滤一遍）。 */
	Issues []*plexEpisodeEntry `json:"issues"`
}

// plexPlan 是整库的多季刮削方案。
type plexPlan struct {
	ShowNum       int               `json:"show_num"`
	MultiSeasonNum int              `json:"multi_season_num"`
	SeasonNum     int               `json:"season_num"`
	EpisodeNum    int               `json:"episode_num"`
	IssueNum      int               `json:"issue_num"`
	Shows         []*plexShowGroup  `json:"shows"`
	Issues        []*plexEpisodeEntry `json:"issues"`
}

/* plexParseRel 解析一条库内相对路径 → 剧集条目。
   规则与 Plex 一致：方括号内容忽略、季目录定季、文件名定集。 */
func plexParseRel(rel string) *plexEpisodeEntry {
	slash := filepath.ToSlash(strings.TrimSpace(rel))
	slash = strings.TrimPrefix(slash, "/")
	if slash == "" {
		return nil
	}
	parts := splitPathParts(slash)
	if len(parts) == 0 {
		return nil
	}
	file := parts[len(parts)-1]
	ext := filepath.Ext(file)
	dirs := parts[:len(parts)-1]
	stem := strings.TrimSuffix(file, ext)

	/* 方括号里的季集号先判定（这是最典型的识别失败原因），再剥离后正常解析。 */
	bracketTag := plexBracketSeasonEpisode(stem)
	cleanStem := plexCleanStem(stem)

	/* 从文件名所在目录逐级往上找季目录。 */
	dirSeason, seasonDir, seasonIdx := -1, "", -1
	for i := len(dirs) - 1; i >= 0; i-- {
		if n, ok := plexParseSeasonDir(dirs[i]); ok {
			dirSeason, seasonDir, seasonIdx = n, dirs[i], i
			break
		}
	}
	/* 剧根目录：季目录的上一层；没有季目录时取第一层目录。 */
	showIdx := 0
	if seasonIdx > 0 {
		showIdx = seasonIdx - 1
	} else if seasonIdx == 0 {
		showIdx = 0
	}
	showDir := ""
	if len(dirs) > 0 {
		showDir = dirs[showIdx]
	}
	showTitle, showYear, tagSeason := plexParseShowDir(showDir)
	if showTitle == "" {
		showTitle = strings.TrimSpace(cleanStem)
	}
	tag := plexParseEpisodeTag(cleanStem, dirSeason)
	if tag.Episode <= 0 && bracketTag != "" {
		/* 季集号只在方括号里 —— 按 Plex 口径等于没有，但仍把数字读出来供诊断展示。
		   注意要取方括号**内部**的内容（剥离方括号会把里面的季集号一起丢掉）。 */
		b := plexParseEpisodeTag(plexCleanStem(strings.Trim(bracketTag, "[]【】")), -1)
		if b.Episode > 0 {
			tag.Episode, tag.Season = b.Episode, b.Season
		}
	}
	season := tag.Season
	if season < 0 {
		season = dirSeason
	}
	if season < 0 && tagSeason >= 0 {
		season = tagSeason
	}
	if season < 0 {
		season = 1
	}
	if dirSeason >= 0 {
		/* 季目录是权威（Plex 优先信目录）：目录写 Season 03 时文件名里的 s02 不生效。 */
		season = dirSeason
	} else if tagSeason >= 0 && tag.Episode > 0 {
		season = tagSeason
	}

	entry := &plexEpisodeEntry{
		Path: slash, ShowDir: showDir, ShowTitle: showTitle, ShowYear: showYear,
		Season: season, SeasonDir: seasonDir, Episode: tag.Episode, EpisodeEnd: tag.EpisodeEnd,
		Multi: tag.Multi, EpisodeTitle: tag.Title,
	}
	entry.Display, entry.EpisodeLabel, entry.Issues = plexEpisodeDisplay(entry, cleanStem, tag, ext, bracketTag, seasonDir)
	entry.Compliant = len(entry.Issues) == 0
	if !entry.Compliant {
		entry.Suggested = plexSuggestedPath(entry, ext)
	}
	return entry
}

/* plexEpisodeDisplay 组装展示名 / 集标签 / 问题清单。 */
func plexEpisodeDisplay(e *plexEpisodeEntry, stem string, tag plexEpisodeTag, ext, bracketTag, seasonDir string) (string, string, []string) {
	issues := []string{}
	label := ""
	if e.Episode > 0 {
		if e.Multi {
			label = fmt.Sprintf("S%02dE%02d-E%02d", e.Season, e.Episode, e.EpisodeEnd)
		} else {
			label = fmt.Sprintf("S%02dE%02d", e.Season, e.Episode)
		}
	} else {
		label = stem
	}
	display := e.EpisodeTitle
	if display == "" {
		/* 解析不出分集名（或解析失败）时以文件名为准 —— 与音频刮削失败时的口径一致。 */
		display = strings.TrimSpace(stem)
	}
	if bracketTag != "" {
		issues = append(issues, "季集号写在方括号 "+bracketTag+" 里：Plex 会完全忽略方括号内容，必须移到文件名主干")
	} else if e.Episode <= 0 {
		issues = append(issues, "文件名里没有可识别的季集标记（sXXeYY / 1x02 / 第X季第Y集），无法刮削到分集元数据")
	}
	if e.Episode > 0 && tag.By == "number" {
		issues = append(issues, "只有纯数字集号：Plex 不认这种写法，建议改成 sXXeYY 形式")
	}
	if e.Episode <= 0 && tag.By == "" && strings.TrimSpace(seasonDir) == "" {
		/* 既无季目录又无季集标记：连季都靠默认值，判定为结构缺失。 */
		issues = append(issues, "缺少 Season XX 季目录，季号只能按文件名/默认第 1 季推断")
	}
	if e.Season == 0 && strings.TrimSpace(seasonDir) == "" {
		/* 第 0 季必须来自特别篇目录（Season 00 / Specials），否则是误判。 */
		issues = append(issues, "季号为 0（特别篇）但没有 Season 00 / Specials 目录")
	}
	if e.ShowYear == "" {
		issues = append(issues, "剧根目录没有首播年份：建议命名为「剧名 (年份)」避免同名不同版本错配")
	}
	if !plexIsMediaExt(ext) {
		issues = append(issues, "扩展名 "+ext+" 不是常见视频格式，刮削器可能不识别")
	}
	return display, label, issues
}

/* plexSuggestedPath 给出该条目的 Plex 规范目标路径（可直接复制去改名）。
   剧根目录名 + Season XX + `剧集名 (年份) - sXXeYY - 标题.ext`。 */
func plexSuggestedPath(e *plexEpisodeEntry, ext string) string {
	show := e.ShowTitle
	if show == "" {
		show = "剧集名"
	}
	showDir := show
	if e.ShowYear != "" {
		showDir = fmt.Sprintf("%s (%s)", show, e.ShowYear)
	} else {
		showDir = fmt.Sprintf("%s (年份)", show)
	}
	ep := e.Episode
	if ep <= 0 {
		ep = 1
	}
	var name string
	if e.Multi && e.EpisodeEnd > 0 {
		name = fmt.Sprintf("%s - s%02de%02d-e%02d", show, e.Season, ep, e.EpisodeEnd)
	} else {
		name = fmt.Sprintf("%s - s%02de%02d", show, e.Season, ep)
	}
	if t := strings.TrimSpace(e.EpisodeTitle); t != "" {
		name += " - " + t
	} else if e.Episode <= 0 {
		name += " - " + plexCleanEpisodeTitle(strings.TrimSuffix(filepath.Base(e.Path), ext))
	}
	if ext == "" {
		ext = ".mkv"
	}
	return showDir + "/" + plexSeasonDirName(e.Season) + "/" + name + ext
}

/* plexPlanFromPaths 把库里全部路径聚合成多季刮削方案。
   参与聚合的条目：位于季目录下的媒体文件，或文件名里带季集标记的媒体文件。 */
func plexPlanFromPaths(rels []string) *plexPlan {
	plan := &plexPlan{Shows: []*plexShowGroup{}, Issues: []*plexEpisodeEntry{}}
	index := map[string]*plexShowGroup{}
	for _, rel := range rels {
		slash := filepath.ToSlash(strings.TrimSpace(rel))
		ext := filepath.Ext(slash)
		if !plexIsMediaExt(ext) {
			continue
		}
		if inBluRayStructure(slash) {
			continue
		}
		e := plexParseRel(slash)
		if e == nil {
			continue
		}
		if e.Episode <= 0 {
			stem := strings.TrimSuffix(filepath.Base(slash), ext)
			if plexParseEpisodeTag(plexCleanStem(stem), -1).Episode <= 0 && e.SeasonDir == "" && e.ShowDir == "" {
				continue
			}
			if plexParseEpisodeTag(plexCleanStem(stem), -1).Episode <= 0 && e.SeasonDir == "" {
				/* 既没季目录又没季集标记：不属于剧集条目，跳过（避免整库电影混进剧集诊断）。 */
				continue
			}
		}
		key := plexShowKey(e.ShowTitle, e.ShowYear)
		show := index[key]
		if show == nil {
			show = &plexShowGroup{Key: key, Title: e.ShowTitle, Year: e.ShowYear, Dirs: []string{}, Seasons: []*plexSeasonGroup{}, Issues: []*plexEpisodeEntry{}}
			index[key] = show
			plan.Shows = append(plan.Shows, show)
		}
		if e.ShowDir != "" && !containsString(show.Dirs, e.ShowDir) {
			show.Dirs = append(show.Dirs, e.ShowDir)
		}
		var season *plexSeasonGroup
		for _, s := range show.Seasons {
			if s.Season == e.Season {
				season = s
				break
			}
		}
		if season == nil {
			season = &plexSeasonGroup{
				Season: e.Season, Label: plexSeasonLabel(e.Season), Tag: plexSeasonTag(e.Season),
				Dir: e.SeasonDir, Special: e.Season == 0, Episodes: []*plexEpisodeEntry{},
			}
			show.Seasons = append(show.Seasons, season)
		}
		if season.Dir == "" && e.SeasonDir != "" {
			season.Dir = e.SeasonDir
		}
		season.Episodes = append(season.Episodes, e)
		if !e.Compliant {
			show.IssueNum++
			show.Issues = append(show.Issues, e)
			plan.IssueNum++
			plan.Issues = append(plan.Issues, e)
		}
	}
	for _, show := range plan.Shows {
		sort.Slice(show.Dirs, func(i, j int) bool { return show.Dirs[i] < show.Dirs[j] })
		sort.Slice(show.Seasons, func(i, j int) bool { return show.Seasons[i].Season < show.Seasons[j].Season })
		for _, season := range show.Seasons {
			sort.SliceStable(season.Episodes, func(i, j int) bool {
				a, b := season.Episodes[i], season.Episodes[j]
				if a.Episode != b.Episode {
					if a.Episode <= 0 {
						return false
					}
					if b.Episode <= 0 {
						return true
					}
					return a.Episode < b.Episode
				}
				return a.Path < b.Path
			})
			nums := []int{}
			for _, ep := range season.Episodes {
				if ep.Episode > 0 {
					nums = append(nums, ep.Episode)
					if ep.Multi && ep.EpisodeEnd > 0 {
						for x := ep.Episode + 1; x <= ep.EpisodeEnd; x++ {
							nums = append(nums, x)
						}
					}
				}
			}
			season.Numbers = plexUniqueSorted(nums)
			season.NumbersTag = plexEpisodeRanges(season.Numbers)
			season.Count = len(season.Episodes)
			show.EpisodeNum += len(season.Episodes)
			plan.EpisodeNum += len(season.Episodes)
			if season.Special {
				show.HasSpecials = true
			}
		}
		show.SeasonCount = len(show.Seasons)
		show.MultiSeason = show.SeasonCount >= 2
		plan.SeasonNum += show.SeasonCount
		if show.MultiSeason {
			plan.MultiSeasonNum++
		}
	}
	sort.Slice(plan.Shows, func(i, j int) bool {
		a, b := plan.Shows[i], plan.Shows[j]
		if a.MultiSeason != b.MultiSeason {
			return a.MultiSeason
		}
		if a.Title != b.Title {
			return a.Title < b.Title
		}
		return a.Year < b.Year
	})
	sort.Slice(plan.Issues, func(i, j int) bool { return plan.Issues[i].Path < plan.Issues[j].Path })
	plan.ShowNum = len(plan.Shows)
	return plan
}

/* plexShowKey 是剧集聚合键：剧名 + 年份归一化后小写。
   归一化保证 `The Flash (2014)`、`The Flash 2014`、`the.flash` 归到同一部剧，
   从而「同一部剧的所有季」始终聚在一张卡片里（多季刮削的前提）。 */
func plexShowKey(title, year string) string {
	t := normalizeSeriesTitle(title)
	if t == "" {
		t = "unknown"
	}
	return t + "\x00" + strings.TrimSpace(year)
}

// normalizeSeriesTitle 剧名归一化：小写、去标点与空白（用于聚合键）。
func normalizeSeriesTitle(title string) string {
	s := strings.ToLower(strings.TrimSpace(plexCleanStem(title)))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r >= 0x4e00 && r <= 0x9fff: // CJK 统一表意文字
			b.WriteRune(r)
		}
	}
	return b.String()
}

/* plexUniqueSorted 升序去重。 */
func plexUniqueSorted(nums []int) []int {
	out := []int{}
	seen := map[int]bool{}
	for _, n := range nums {
		if n <= 0 || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

/* plexEpisodeRanges 把集号列表压成 Plex 风格标签：`E01-E03、E05`。 */
func plexEpisodeRanges(nums []int) string {
	list := plexUniqueSorted(nums)
	if len(list) == 0 {
		return ""
	}
	parts := []string{}
	for i := 0; i < len(list); {
		j := i
		for j+1 < len(list) && list[j+1] == list[j]+1 {
			j++
		}
		if j == i {
			parts = append(parts, fmt.Sprintf("E%02d", list[i]))
		} else if j == i+1 {
			parts = append(parts, fmt.Sprintf("E%02d", list[i]), fmt.Sprintf("E%02d", list[j]))
		} else {
			parts = append(parts, fmt.Sprintf("E%02d-E%02d", list[i], list[j]))
		}
		i = j + 1
	}
	return strings.Join(parts, "、")
}

/* plexMissingEpisodes 返回本地缺失的集号：官方 1..official 里本地没有的那些。
   official <= 0（未知）时返回空 —— 不猜。 */
func plexMissingEpisodes(have []int, official int) []int {
	if official <= 0 {
		return []int{}
	}
	own := map[int]bool{}
	for _, n := range have {
		own[n] = true
	}
	missing := []int{}
	for n := 1; n <= official; n++ {
		if !own[n] {
			missing = append(missing, n)
		}
	}
	return missing
}

/* plexMissingLabel 生成「缺 S03E07-E09、E12」这类可读标签（season 为季号）。 */
func plexMissingLabel(season int, missing []int) string {
	if len(missing) == 0 {
		return ""
	}
	return fmt.Sprintf("S%02d", season) + strings.ReplaceAll(plexEpisodeRanges(missing), "、", "、S"+fmt.Sprintf("%02d", season))
}

// plexSeasonMissing 是某一季的缺失集比对结果。
type plexSeasonMissing struct {
	Season        int    `json:"season"`
	Label         string `json:"label"`
	Tag           string `json:"tag"`
	LocalCount    int    `json:"local_count"`
	LocalNumbers  []int  `json:"local_numbers"`
	LocalTag      string `json:"local_tag"`
	OfficialCount int    `json:"official_count"`
	Missing       []int  `json:"missing"`
	MissingLabel  string `json:"missing_label"`
	Complete      bool   `json:"complete"`
}

/* plexSeasonMissingReport 汇总整部剧的缺失集情况。 */
func plexSeasonMissingReport(show *plexShowGroup, official map[int]int) []plexSeasonMissing {
	out := []plexSeasonMissing{}
	if show == nil {
		return out
	}
	for _, season := range show.Seasons {
		officialCount := official[season.Season]
		missing := plexMissingEpisodes(season.Numbers, officialCount)
		out = append(out, plexSeasonMissing{
			Season: season.Season, Label: season.Label, Tag: season.Tag,
			LocalCount: len(season.Numbers), LocalNumbers: season.Numbers, LocalTag: season.NumbersTag,
			OfficialCount: officialCount, Missing: missing,
			MissingLabel: plexMissingLabel(season.Season, missing),
			Complete:     officialCount > 0 && len(missing) == 0,
		})
	}
	return out
}

/* plexFindShow 在方案里按展示键或剧根目录找一部剧（缺失集比对接口用）。 */
func plexFindShow(plan *plexPlan, key, dir, title string) *plexShowGroup {
	if plan == nil {
		return nil
	}
	for _, show := range plan.Shows {
		if key != "" && show.Key == key {
			return show
		}
	}
	for _, show := range plan.Shows {
		for _, d := range show.Dirs {
			if dir != "" && d == dir {
				return show
			}
		}
	}
	if title != "" {
		for _, show := range plan.Shows {
			if show.Title == title {
				return show
			}
		}
	}
	return nil
}

/* splitPathParts 按 / 与 \ 切分路径并去掉空段（NAS 路径混用分隔符很常见）。 */
func splitPathParts(p string) []string {
	raw := strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' })
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		if s = strings.TrimSpace(s); s != "" && s != "." {
			out = append(out, s)
		}
	}
	return out
}

// containsString 小工具：切片里是否已含该字符串。
func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
