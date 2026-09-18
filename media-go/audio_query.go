package main

import (
	"strings"
)

/* v0.9.71：刮削识别策略（特殊字符 / 日语 / 全角）。
 *
 * 真机实测（2026-09，从本机直连 iTunes / LRCLIB）：
 *   1) iTunes 对日语曲目在 TW/US 常返回罗马音标题
 *      （残酷な天使のテーゼ → "Zankokuna Tenshino These"/"A Cruel Angel's Thesis"），
 *      归一化后与本地标题无法命中；JP 店铺返回原名。旧国家表只有 TW/US → 整条刮削失败。
 *   2) 带发布修饰的标题（残酷な天使のテーゼ【MV】、前前前世 (movie ver.)）在 LRCLIB
 *      结构化检索（track_name + artist_name）返回 0 条，而自由文本 q= 有 16~20 条；
 *      去掉【MV】后再用 /api/get 精确命中 → 检索词必须先做「去修饰」变体。
 *   3) 全角标题（ＮＵＭＢＥＲ / Ｋｅｎｇｏ）不折叠宽度时与半角记录永不相等。
 *   4) 歌手侧：iTunes 对日语歌手一律返回罗马音规范名
 *      （高橋洋子 → Yoko Takahashi、米津玄師 → Kenshi Yonezu、ヨルシカ → Yorushika），
 *      旧的「共享 ≥2 个非拉丁字符」判定必然落空 → 歌手封面永远刮不到；
 *      而旧的拉丁名宽松判定（共享 ≥3 个 ASCII 字符）又会把
 *      RADWIMPS 与 Piano Echoes（实测共享 a/i/p/s 共 4 个字符）判成同一歌手 → 误配。
 *      现在拉丁名改用编辑距离相似度，罗马音则用 MusicBrainz 别名表确认。
 *
 * 本文件只放纯函数（无网络、无状态），便于单测与突变验证。
 */

// audioMaxQueryVariants 限制单次刮削的检索词数量（每个变体最多再乘国家数）。
const audioMaxQueryVariants = 4

// audioQuery 是一次检索的（标题，歌手）组合。
type audioQuery struct {
	Title  string
	Artist string
}

// halfWidthKanaTable 是半角片假名（U+FF61 起连续 63 个）到全角片假名的映射表，
// 顺序与 Unicode 码位一一对应；浊音/半浊音由后随的 ﾞ/ﾟ 组合（见 audioWidthFold）。
const halfWidthKanaTable = "。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン"

// audioWidthFold 折叠全角/半角差异：全角 ASCII → 半角、表意空格 → 普通空格、
// 半角片假名 → 全角（含浊音组合）。只做等价映射，不改语义。
func audioWidthFold(s string) string {
	runes := []rune(s)
	table := []rune(halfWidthKanaTable)
	out := make([]rune, 0, len(runes))
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == '\u3000':
			out = append(out, ' ')
		case r >= 0xFF01 && r <= 0xFF5E: // 全角 ASCII
			out = append(out, r-0xFEE0)
		case r >= 0xFF61 && r <= 0xFF9F: // 半角片假名
			idx := int(r - 0xFF61)
			if idx < 0 || idx >= len(table) {
				out = append(out, r)
				continue
			}
			base := table[idx]
			if i+1 < len(runes) && (runes[i+1] == 0xFF9E || runes[i+1] == 0xFF9F) {
				if folded, ok := audioVoicedKana(base, runes[i+1] == 0xFF9F); ok {
					out = append(out, folded)
					i++
					continue
				}
			}
			out = append(out, base)
		default:
			out = append(out, r)
		}
	}
	return string(out)
}

// audioVoicedKana 把假名 + 浊点/半浊点折叠为单字符（ｶﾞ → ガ、ﾊﾟ → パ）。
func audioVoicedKana(r rune, handaku bool) (rune, bool) {
	if handaku {
		switch r {
		case 'ハ':
			return 'パ', true
		case 'ヒ':
			return 'ピ', true
		case 'フ':
			return 'プ', true
		case 'ヘ':
			return 'ペ', true
		case 'ホ':
			return 'ポ', true
		}
		return 0, false
	}
	switch r {
	case 'ウ':
		return 'ヴ', true
	case 'ワ':
		return 'ヷ', true
	case 'カ':
		return 'ガ', true
	case 'キ':
		return 'ギ', true
	case 'ク':
		return 'グ', true
	case 'ケ':
		return 'ゲ', true
	case 'コ':
		return 'ゴ', true
	case 'サ':
		return 'ザ', true
	case 'シ':
		return 'ジ', true
	case 'ス':
		return 'ズ', true
	case 'セ':
		return 'ゼ', true
	case 'ソ':
		return 'ゾ', true
	case 'タ':
		return 'ダ', true
	case 'チ':
		return 'ヂ', true
	case 'ツ':
		return 'ヅ', true
	case 'テ':
		return 'デ', true
	case 'ト':
		return 'ド', true
	case 'ハ':
		return 'バ', true
	case 'ヒ':
		return 'ビ', true
	case 'フ':
		return 'ブ', true
	case 'ヘ':
		return 'ベ', true
	case 'ホ':
		return 'ボ', true
	}
	return 0, false
}

// audioBracketPair 给出左括号对应的右括号（支持中日文与代码常见括号）。
func audioBracketPair(r rune) (rune, bool) {
	switch r {
	case '【':
		return '】', true
	case '「':
		return '」', true
	case '『':
		return '』', true
	case '〈':
		return '〉', true
	case '《':
		return '》', true
	case '〔':
		return '〕', true
	case '［':
		return '］', true
	case '｛':
		return '｝', true
	case '(':
		return ')', true
	case '[':
		return ']', true
	case '{':
		return '}', true
	}
	return 0, false
}

// audioIsCloseBracket 判断是否任意一种右括号。
func audioIsCloseBracket(r rune) bool {
	switch r {
	case '】', '」', '』', '〉', '》', '〕', '］', '｝', ')', ']', '}':
		return true
	}
	return false
}

// audioMatchingClose 返回左括号 runes[open] 的配对右括号下标；无配对返回 -1。
// v0.9.71：用括号栈处理嵌套与混用类型 —— 旧实现只按「同一种右括号」计深度，
// 遇到 「(『…』より)」这种混用嵌套时配对失败，括号内容会漏进检索词
// （实测「前前前世(『君の名は。』より) [Piano Echoes Ver.]」漏出「より」）。
func audioMatchingClose(runes []rune, open int) int {
	first, ok := audioBracketPair(runes[open])
	if !ok {
		return -1
	}
	stack := []rune{first}
	for i := open + 1; i < len(runes); i++ {
		if closer, isOpen := audioBracketPair(runes[i]); isOpen {
			stack = append(stack, closer)
			continue
		}
		if runes[i] == stack[len(stack)-1] {
			stack = stack[:len(stack)-1]
			if len(stack) == 0 {
				return i
			}
		}
	}
	return -1
}

// audioDecorationTokens 是发布修饰词（小写比较）：命中即从检索词里去掉。
// 只在「独立片段」位置生效（整段、或空格/分隔符分隔出的片段），不做子串替换，
// 避免删掉标题里的真实词（如 "Audio" 只是 "Audio Slave" 的一部分时不受影响）。
var audioDecorationTokens = map[string]bool{
	"mv": true, "pv": true, "op": true, "ed": true, "opening": true, "ending": true,
	"official": true, "officialvideo": true, "officialaudio": true, "lyrics": true,
	"lyricvideo": true, "lyric": true, "topic": true, "audio": true,
	"hd": true, "4k": true, "8k": true, "hires": true, "hi-res": true,
	"remaster": true, "remastered": true, "full": true, "完整版": true,
	"歌詞": true, "歌词": true, "歌詞付き": true, "高音質": true, "公式": true,
	"フル": true, "作業用": true, "本家": true,
}

// audioTrimSeparators 去掉首尾的分隔符与空白。
func audioTrimSeparators(s string) string {
	return strings.Trim(s, " \t-–—_~〜～・、,，.:：;；/\\|'\"")
}

// audioCollapseSpaces 把连续空白折叠为单个空格。
func audioCollapseSpaces(s string) string {
	var b strings.Builder
	lastSpace := false
	for _, r := range s {
		if r == ' ' || r == '\t' {
			if !lastSpace {
				b.WriteRune(' ')
			}
			lastSpace = true
			continue
		}
		lastSpace = false
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// audioStripTrackNumber 去掉开头的音轨序号（"01 "、"01. "、"1-02 "），
// 只在前缀是纯序号且剩余部分不是纯数字时生效（"1-800-273-8255" 不会被误删）。
func audioStripTrackNumber(s string) string {
	runes := []rune(s)
	i := 0
	for i < len(runes) && (runes[i] >= '0' && runes[i] <= '9' || runes[i] == '-' || runes[i] == '.') {
		i++
	}
	if i == 0 || i == len(runes) {
		return s
	}
	sep := false
	if runes[i] == ' ' || runes[i] == '_' || runes[i] == '．' {
		sep = true
	}
	// "01 - 标题" / "01. 标题" / "01 标题" 三种形态
	prefix := string(runes[:i])
	if !sep && !strings.HasSuffix(prefix, "-") && !strings.HasSuffix(prefix, ".") {
		return s
	}
	digits := 0
	for _, r := range prefix {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	if digits < 1 || digits > 3 {
		return s
	}
	rest := strings.TrimLeft(string(runes[i:]), " \t-–—_.")
	// 剩余部分是纯数字（如 "1-800"）时不当作音轨号
	numeric := rest != ""
	for _, r := range rest {
		if !(r >= '0' && r <= '9' || r == '-' || r == ' ') {
			numeric = false
			break
		}
	}
	if numeric {
		return s
	}
	if len([]rune(rest)) < 2 {
		return s
	}
	return rest
}

/* audioGluedDecorationSuffixes 是可能紧贴在标题尾部（无分隔符）的发布修饰词。
   只收多字符、辨识度高的词：两字母缩写（op/ed/hd）紧贴时误删风险太高，
   会在「Wired」这类正常标题上造成损伤。 */
var audioGluedDecorationSuffixes = []string{
	"officialvideo", "officialaudio", "lyricvideo", "official", "lyrics",
	"remastered", "remaster", "hires", "topic", "audio", "mv", "pv",
	"高音質", "歌詞付き", "歌詞", "歌词", "公式", "フル",
}

// audioDropGluedDecorationSuffix 去掉紧贴标题尾部的发布修饰词
// （实测「残酷な天使のテーゼ【MV」这种未闭合括号会让 MV 粘在标题后）。
// 只在剩余前缀仍有 ≥2 个字符时生效，避免把标题削空。
func audioDropGluedDecorationSuffix(s string) string {
	lower := strings.ToLower(s)
	for _, suffix := range audioGluedDecorationSuffixes {
		if !strings.HasSuffix(lower, suffix) {
			continue
		}
		head := audioTrimSeparators(s[:len(s)-len(suffix)])
		if len([]rune(head)) >= 2 {
			return head
		}
	}
	return s
}

// audioDropDecorationTokens 按片段丢弃发布修饰词，保留其余原文片段。
func audioDropDecorationTokens(s string) string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return s
	}
	out := make([]string, 0, len(fields))
	for _, raw := range fields {
		trimmed := audioTrimSeparators(raw)
		core := strings.ToLower(trimmed)
		core = strings.Trim(core, "-–—_~〜～・、,，.:：;；/\\|'\"")
		marker := audioStrictCaseMarkerKey(core) // "op2" → "op"；其余原样
		if core != "" && (audioDecorationTokens[core] || audioDecorationTokens[marker]) {
			/* op/ed 也是常见英文词（"With Ed" 实测会被误删），只承认 OP / OP2 / ED1
			   这类全大写标记；其余情况保留原词，交给下一级变体继续尝试。 */
			if audioStrictCaseDecorationTokens[marker] && !audioLooksLikeUppercaseMarker(trimmed, marker) {
				out = append(out, trimmed)
				continue
			}
			continue
		}
		out = append(out, trimmed)
	}
	return audioCollapseSpaces(strings.Join(out, " "))
}

// audioStrictCaseMarkerKey 把 OP2 / ED10 这类「缩写+序号」归一到缩写本身（op / ed）。
func audioStrictCaseMarkerKey(core string) string {
	i := len(core)
	for i > 0 && core[i-1] >= '0' && core[i-1] <= '9' {
		i--
	}
	if i > 0 && i < len(core) {
		return core[:i]
	}
	return core
}

// audioStrictCaseDecorationTokens 是需要「全大写标记」形态才认作修饰词的片段。
var audioStrictCaseDecorationTokens = map[string]bool{"op": true, "ed": true}

// audioLooksLikeUppercaseMarker：OP / ED / OP2 / ED1 这类全大写标记才当作发布修饰词。
func audioLooksLikeUppercaseMarker(raw, core string) bool {
	upper := strings.ToUpper(core)
	if !strings.HasPrefix(raw, upper) {
		return false
	}
	for _, r := range strings.TrimPrefix(raw, upper) {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// audioStripDecorations 生成「去修饰检索词」：折叠宽度 → 去掉成对括号整段 →
// 折叠空白 → 去掉独立发布修饰词 → 去首尾分隔符。未配对括号只丢弃括号字符本身。
func audioStripDecorations(s string) string {
	s = audioWidthFold(strings.TrimSpace(s))
	runes := []rune(s)
	var b strings.Builder
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if _, isOpen := audioBracketPair(r); isOpen {
			if end := audioMatchingClose(runes, i); end > i {
				i = end // 跳过整段括号内容（含右括号）
				continue
			}
			continue // 无配对右括号：丢弃这个左括号本身
		}
		if audioIsCloseBracket(r) {
			continue // 孤立右括号一并丢弃
		}
		b.WriteRune(r)
	}
	out := audioCollapseSpaces(b.String())
	out = audioDropDecorationTokens(out)
	out = audioTrimSeparators(out)
	out = audioStripTrackNumber(out)
	return strings.TrimSpace(audioDropGluedDecorationSuffix(out))
}

// audioQueryVariants 给出有序检索词阶梯（已去重、去空、截断到 audioMaxQueryVariants）：
// 原样 → 去修饰 → 主歌手（合作串）→ 仅去修饰标题。
func audioQueryVariants(title, artist string) []audioQuery {
	title = strings.TrimSpace(audioWidthFold(title))
	artist = strings.TrimSpace(audioWidthFold(artist))
	if artist == "未知歌手" {
		artist = ""
	}
	if title == "" {
		return nil
	}
	strippedTitle := audioStripDecorations(title)
	strippedArtist := audioStripDecorations(artist)
	primary := ""
	if parts := splitAudioCollaborators(artist); len(parts) > 0 {
		primary = strings.TrimSpace(parts[0])
	}
	var out []audioQuery
	add := func(t, a string) {
		t, a = strings.TrimSpace(t), strings.TrimSpace(a)
		if t == "" || len(out) >= audioMaxQueryVariants {
			return
		}
		for _, q := range out {
			if q.Title == t && q.Artist == a {
				return
			}
		}
		out = append(out, audioQuery{Title: t, Artist: a})
	}
	add(title, artist)
	if strippedTitle != title || strippedArtist != artist {
		add(strippedTitle, strippedArtist)
	}
	if primary != "" && primary != artist {
		add(title, primary)
		add(strippedTitle, primary)
	}
	add(strippedTitle, "")
	if len(out) == 0 {
		add(title, artist)
	}
	return out
}

// audioHasKana / audioHasHan / audioHasCJK 用于选择 iTunes 店铺顺序。
func audioHasKana(s string) bool {
	for _, r := range audioWidthFold(s) {
		if r >= 0x3040 && r <= 0x30FF {
			return true
		}
	}
	return false
}

func audioHasHan(s string) bool {
	for _, r := range audioWidthFold(s) {
		if (r >= 0x3400 && r <= 0x9FFF) || (r >= 0xF900 && r <= 0xFAFF) || (r >= 0x20000 && r <= 0x2FA1F) {
			return true
		}
	}
	return false
}

func audioHasCJK(s string) bool { return audioHasKana(s) || audioHasHan(s) }

// audioCountryOrder 按脚本给出 iTunes 店铺优先顺序：
//   含假名 → JP 优先（日语曲目在 JP 店铺才是原版标题/专辑）；
//   仅汉字 → TW 优先（实测 TW 店铺对有汉字的华语/日语曲目命中率与原名都最好）；
//   纯拉丁 → US 优先。
// 最多三个店铺，配合调用侧的「高分即停」把请求数控制在 1~3 次。
func audioCountryOrder(sample string) []string {
	switch {
	case audioHasKana(sample):
		return []string{"JP", "TW", "US"}
	case audioHasHan(sample):
		return []string{"TW", "JP", "US"}
	default:
		// 纯拉丁：US 最先
		return []string{"US", "TW", "JP"}
	}
}

// audioLatinSimilarity 返回 1 - 编辑距离/max(len)（0..1）。长度超过 64 时截断，
// 保证代价有界（名字匹配不需要更长的上下文）。
func audioLatinSimilarity(a, b string) float64 {
	ra, rb := []rune(a), []rune(b)
	if len(ra) > 64 {
		ra = ra[:64]
	}
	if len(rb) > 64 {
		rb = rb[:64]
	}
	if len(ra) == 0 || len(rb) == 0 {
		return 0
	}
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := 0; j <= len(rb); j++ {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			best := prev[j-1] + cost
			if v := prev[j] + 1; v < best {
				best = v
			}
			if v := cur[j-1] + 1; v < best {
				best = v
			}
			cur[j] = best
		}
		prev, cur = cur, prev
	}
	dist := prev[len(rb)]
	max := len(ra)
	if len(rb) > max {
		max = len(rb)
	}
	if dist >= max {
		return 0
	}
	return 1 - float64(dist)/float64(max)
}

func audioIsASCII(s string) bool {
	for _, r := range s {
		if r >= 128 {
			return false
		}
	}
	return true
}

// audioSharedCJK 统计两个字符串共享的不同非拉丁字符数。
func audioSharedCJK(a, b string) int {
	seen := map[rune]bool{}
	shared := map[rune]bool{}
	for _, r := range a {
		if r >= 128 {
			seen[r] = true
		}
	}
	for _, r := range b {
		if r >= 128 && seen[r] {
			shared[r] = true
		}
	}
	return len(shared)
}

// audioArtistNameMatches 判断本地歌手标签与数据源返回的歌手名是否指同一演唱者。
//   - 相等/包含：直接命中（含中日文简繁差异以外的常见写法）；
//   - 都是拉丁名：编辑距离相似度 ≥ 0.7（实测 RADWIMPS 与 Piano Echoes 相似度 ≈ 0.18，
//     旧「共享 3 个 ASCII 字符」会把它们判成同一人）；
//   - 含非拉丁字符：共享 ≥2 个不同非拉丁字符（简繁差异如 周杰伦/周杰倫 命中，
//     邓丽君/邓紫棋 只共享 1 个字，判为不同歌手）；
//   - 跨脚本（高橋洋子 vs Yoko Takahashi）交给 audioArtistAliasMatch（MusicBrainz 别名表）。
func audioArtistNameMatches(want, got string) bool {
	w, g := normalizedAudioText(want), normalizedAudioText(got)
	if w == "" || g == "" {
		return false
	}
	if w == g || strings.Contains(g, w) || strings.Contains(w, g) {
		return true
	}
	if audioIsASCII(w) && audioIsASCII(g) {
		if len([]rune(w)) < 3 || len([]rune(g)) < 3 {
			return false
		}
		return audioLatinSimilarity(w, g) >= 0.7
	}
	if audioSharedCJK(w, g) >= 2 {
		return true
	}
	return false
}

/* audioArtistFullMatch 判断数据源歌手串是否「完整列出」了本地歌手：
   相等，或数据源串包含本地串（源里可能还带别的合作者，如「費玉清 & 周杰倫」对「周杰伦」）。
   反向包含 **不算** 完整命中 —— 本地写「DAOKO×米津玄師」而源里只有「米津玄師」时，
   只应算「合作者之一命中」（打分低一档），这样「DAOKO×米津玄師 - 打上花火 - Single」
   才会优先于「米津玄師 - BOOTLEG」。简繁/别名差异按共享汉字或相似度认定。 */
func audioArtistFullMatch(want, got string) bool {
	w, g := normalizedAudioText(want), normalizedAudioText(got)
	if w == "" || g == "" {
		return false
	}
	if w == g || strings.Contains(g, w) {
		return true
	}
	if strings.Contains(w, g) {
		return false // 本地串更长：只算部分命中
	}
	if audioIsASCII(w) && audioIsASCII(g) {
		return audioLatinSimilarity(w, g) >= 0.7
	}
	return audioSharedCJK(w, g) >= 2
}

// audioTitleMatches 判断数据源标题与本地标题是否同一曲目。
// 归一化全等/包含优先；其次比「去修饰」后的结果（残酷な天使のテーゼ【MV】↔ 残酷な天使のテーゼ）；
// 拉丁标题用相似度 ≥0.8 兜后缀差异；非拉丁标题用共享 ≥2 个不同非拉丁字符 + 长度比 ≥0.5。
func audioTitleMatches(want, got string) bool {
	w, g := normalizedAudioText(want), normalizedAudioText(got)
	if w == "" || g == "" {
		return false
	}
	if w == g || strings.Contains(g, w) || strings.Contains(w, g) {
		return true
	}
	ws, gs := normalizedAudioText(audioStripDecorations(want)), normalizedAudioText(audioStripDecorations(got))
	if ws != "" && gs != "" && (ws == gs || strings.Contains(gs, ws) || strings.Contains(ws, gs)) {
		return true
	}
	if audioIsASCII(w) && audioIsASCII(g) {
		if len([]rune(w)) < 4 || len([]rune(g)) < 4 {
			return false
		}
		return audioLatinSimilarity(w, g) >= 0.8
	}
	if audioSharedCJK(w, g) >= 2 {
		wl, gl := len([]rune(w)), len([]rune(g))
		short, long := wl, gl
		if gl < wl {
			short, long = gl, wl
		}
		/* 阈值 0.7：简繁差异标题（说好不哭/說好不哭，长度相等）命中，
		   而「紅蓮華」vs「紅蓮の弓矢」（共享 2 字、长度比 0.6）这类不同曲目不命中。 */
		return float64(short)/float64(long) >= 0.7
	}
	return false
}

// audioArtistAliasMatch 判断数据源返回的歌手名是否命中给定别名集合（大小写/宽度不敏感）。
func audioArtistAliasMatch(got string, aliases []string) bool {
	g := normalizedAudioText(got)
	if g == "" {
		return false
	}
	for _, alias := range aliases {
		a := normalizedAudioText(alias)
		if a == "" {
			continue
		}
		if a == g || a == normalizedAudioText(got) {
			return true
		}
		if audioArtistNameMatches(alias, got) {
			return true
		}
	}
	return false
}
