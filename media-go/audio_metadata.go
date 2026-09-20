package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type audioScrapeResult struct {
	Title     string `json:"title"`
	Artist    string `json:"artist"`
	Album     string `json:"album"`
	Cover     string `json:"cover,omitempty"`
	Provider  string `json:"provider"`
	Recording string `json:"recording_id,omitempty"`
	Release   string `json:"release_id,omitempty"`
}

/*
v0.9.56：音乐刮削主源换成 iTunes Search API —— 无需注册/密钥、返回极简 JSON、

	中文曲库完整（按 TW/US store 依次查询），专辑与高清封面一次到位；
	刮削与音频容器格式无关（mp3/flac/m4a/ogg/wav/aac/ape/opus 等媒体库已支持格式
	全部按 文件名→标签 解析出的 标题/歌手 查询）。MusicBrainz 保留为兜底源，
	处理 iTunes 检索不到的英文/小众曲目。
*/
type itunesTrack struct {
	TrackName      string `json:"trackName"`
	ArtistName     string `json:"artistName"`
	CollectionName string `json:"collectionName"`
	ArtworkURL100  string `json:"artworkUrl100"`
}

type itunesSearchResponse struct {
	ResultCount int           `json:"resultCount"`
	Results     []itunesTrack `json:"results"`
}

/*
v0.9.56：itunesSearchBase 是 API 根（不含路径），search/lookup 各自拼自己的端点。

	旧值曾是 ".../search" 又在调用处再拼 "/search"，实际请求 /search/search（Apple 容错才 200），
	而 lookup 拼成 /search/lookup 一律返回空结果集 —— 歌手封面因此永远刮不到。

	v0.9.71：店铺顺序不再是固定表，改由 audioCountryOrder 按标题/歌手的脚本动态选择
	（假名 → JP 优先，汉字 → TW 优先，拉丁 → US 优先）。
*/
var itunesSearchBase = "https://itunes.apple.com"

// audioHiResArtwork 把 iTunes 100x100 缩略图 URL 提升到 600x600。
func audioHiResArtwork(u string) string {
	if strings.Contains(u, "100x100bb") {
		return strings.Replace(u, "100x100bb", "600x600bb", 1)
	}
	return u
}

/* v0.9.71：歌手名匹配统一到 audio_query.go 的 audioArtistNameMatches
   （汉字共享 ≥2 字 / 拉丁编辑距离相似度 ≥0.7）；旧的
   「共享 ≥3 个 ASCII 字符」判定实测会把 RADWIMPS 与 Piano Echoes 误判为同一歌手。 */

/* itunesPick 从一批 iTunes 结果中择优（v0.9.56 引入择优，v0.9.71 起改为打分制）。
 *
 * 硬门槛：标题必须命中（audioTitleMatches：归一化全等/包含 → 去修饰后全等 → 拉丁相似度
 * ≥0.8 → 非拉丁共享 ≥2 字且长度比 ≥0.7；简繁差异标题靠最后一条命中）。
 * 打分：歌手整串命中 4 分 > 未知歌手 3 分 > 仅合作参与者命中 2 分；标题去修饰后完全相等 +1。
 * 取分最高者，同分取 iTunes 相关度靠前（下标小）者。
 *
 * 该结构同时保留旧梯级的语义：
 *   - 「周杰伦 feat. 费玉清 - 千里之外」不再被标题恰好相等的翻唱版（雨天 & 楊蔓）抢走；
 *   - 带 "(Album Version)" 后缀的自家版本优先于标题完全相等的翻唱版；
 *   - 歌手完全不匹配（本地标签写错）时才回落到「标题完全相等」的首条，未知歌手可放宽为包含命中。
 * v0.9.56 的旧实现用「共享 ≥3 个 ASCII 字符」判拉丁歌手，实测会把
 * RADWIMPS 与 Piano Echoes 判成同一人；v0.9.71 改用编辑距离相似度（≥0.7）。
 */
func itunesPick(title, artist string, tracks []itunesTrack) (audioScrapeResult, bool) {
	wantTitle := normalizedAudioText(title)
	if wantTitle == "" || len(tracks) == 0 {
		return audioScrapeResult{}, false
	}
	wantArtist := normalizedAudioText(artist)
	unknownArtist := wantArtist == "" || wantArtist == normalizedAudioText("未知歌手")
	// 歌手候选：整串 + 合作串拆出的每个参与者（主歌手在前）
	var artistCandidates []string
	if !unknownArtist {
		artistCandidates = append(artistCandidates, wantArtist)
		for _, part := range splitAudioCollaborators(artist) {
			if p := normalizedAudioText(part); p != "" && p != wantArtist {
				artistCandidates = append(artistCandidates, p)
			}
		}
	}
	build := func(tr itunesTrack) audioScrapeResult {
		out := audioScrapeResult{Title: tr.TrackName, Artist: tr.ArtistName, Provider: "iTunes"}
		if out.Artist == "" {
			out.Artist = artist
		}
		if tr.CollectionName != "" {
			out.Album = tr.CollectionName
		} else {
			out.Album = "未知专辑"
		}
		if tr.ArtworkURL100 != "" {
			out.Cover = audioHiResArtwork(tr.ArtworkURL100)
		}
		return out
	}
	wantStripped := normalizedAudioText(audioStripDecorations(title))
	bestScore, bestIndex := 0, -1
	for i, tr := range tracks {
		if !audioTitleMatches(title, tr.TrackName) {
			continue
		}
		gotArtist := normalizedAudioText(tr.ArtistName)
		score := 0
		switch {
		case unknownArtist:
			score = 3
		case audioArtistFullMatch(wantArtist, gotArtist):
			score = 4
		default:
			for _, cand := range artistCandidates {
				if cand != wantArtist && audioArtistNameMatches(cand, gotArtist) {
					score = 2
					break
				}
			}
		}
		if score == 0 {
			continue
		}
		/* 去修饰标题完全相等再 +1，但只对歌手已命中的候选（评分口径与 audioCandidateScore 一致）。 */
		if score >= 2 && wantStripped != "" && normalizedAudioText(audioStripDecorations(tr.TrackName)) == wantStripped {
			score++
		}
		if score > bestScore {
			bestScore, bestIndex = score, i
		}
	}
	if bestIndex >= 0 {
		return build(tracks[bestIndex]), true
	}
	// 兜底：歌手全部落空（或未知歌手）→ 标题完全相等的首条；未知歌手可再放宽为包含命中。
	for _, tr := range tracks {
		gotTitle := normalizedAudioText(tr.TrackName)
		if gotTitle == wantTitle || (unknownArtist && audioTitleMatches(title, tr.TrackName)) {
			return build(tr), true
		}
	}
	return audioScrapeResult{}, false
}

type musicBrainzSearch struct {
	Recordings []struct {
		ID           string `json:"id"`
		Score        int    `json:"score"`
		Title        string `json:"title"`
		ArtistCredit []struct {
			Name string `json:"name"`
		} `json:"artist-credit"`
		Releases []struct{ ID, Title string } `json:"releases"`
	} `json:"recordings"`
}

var audioScrapeBase = "https://musicbrainz.org/ws/2"

/*
normalizedAudioText 是刮削匹配的统一归一化：折叠全角/半角（含半角片假名）→ 小写 →

	去标点与括号。v0.9.71 起把中文书名/曲名括号（【】「」『』〈〉《》〔〕）、中点与
	全角运算符一并去掉 —— 实测带【MV】/「」的标题在未归一化时与数据源记录永不相等。
*/
func normalizedAudioText(v string) string {
	folded := strings.ToLower(audioWidthFold(strings.TrimSpace(v)))
	return strings.Map(func(r rune) rune {
		if strings.ContainsRune(" ._-–—'\"`·、,，:：!！?？()（）[]【】「」『』〈〉《》〔〕・〜～~*＊#＃/／\\＼|｜+＋=＝&＆%％$＄@＠^＾	", r) {
			return -1
		}
		return r
	}, folded)
}

func audioCandidateMatches(title, artist string, score int, gotTitle string, credits []struct {
	Name string `json:"name"`
}) bool {
	if score < 88 {
		return false
	}
	wantTitle, haveTitle := normalizedAudioText(title), normalizedAudioText(gotTitle)
	if wantTitle == "" || haveTitle == "" || !(wantTitle == haveTitle || strings.Contains(wantTitle, haveTitle) || strings.Contains(haveTitle, wantTitle)) {
		return false
	}
	wantArtist := normalizedAudioText(artist)
	if wantArtist == "" || wantArtist == normalizedAudioText("未知歌手") {
		return true
	}
	for _, credit := range credits {
		have := normalizedAudioText(credit.Name)
		if have == wantArtist || strings.Contains(have, wantArtist) || strings.Contains(wantArtist, have) {
			return true
		}
	}
	return false
}

/*
v0.9.56 入口：iTunes 主源，失败回落 MusicBrainz（英文/小众曲目）。

	合作演唱串（「A feat. B」「A & B」）整串检索命中率极低 —— 再用主歌手重试一次，
	全部落空时返回错误，前端保持文件名解析出的标题/歌手展示。
*/
func (a *App) scrapeAudio(ctx context.Context, title, artist string) (audioScrapeResult, error) {
	if out, ok := a.scrapeAudioItunes(ctx, title, artist); ok {
		return out, nil
	}
	if parts := splitAudioCollaborators(artist); len(parts) > 1 && parts[0] != "" && parts[0] != artist {
		if out, ok := a.scrapeAudioItunes(ctx, title, parts[0]); ok {
			return out, nil
		}
	}
	out, err := a.scrapeAudioMusicBrainz(ctx, title, artist)
	if err == nil {
		/* v0.9.67：MusicBrainz 不带封面，但有 release MBID 时可按 Cover Art Archive 取图。 */
		if out.Cover == "" {
			if caa := coverArtArchiveURL(out.Release); caa != "" {
				out.Cover = caa
			}
		}
		return out, nil
	}
	/* v0.9.67：新增源（默认关闭）——华语/冷门曲目命中率更高。 */
	if nc, ok := a.scrapeAudioNetease(ctx, title, artist); ok {
		return nc, nil
	}
	return out, err
}

/* scrapeAudioItunes 按「检索词阶梯 × 店铺顺序」检索（v0.9.71）。
 *
 * 旧实现只用一个检索词（"歌手 标题"）扫 TW/US 两个店铺，遇到
 *   - 日语曲目（TW/US 返回罗马音标题，标题归一化后不命中）
 *   - 带【MV】/「」/全角修饰的标题（数据源没有同名字段）
 * 就会整轮落空。现在：
 *   1) 检索词用 audioQueryVariants 给出的阶梯（原样 → 去修饰 → 主歌手 → 仅标题）；
 *   2) 店铺顺序按脚本选择（假名 → JP 优先，汉字 → TW 优先，拉丁 → US 优先）；
 *   3) 命中即打分（itunesPick），只要拿到「标题+歌手双命中且标题去修饰后完全相等」
 *      的最高分（5）就立刻停止，避免把所有组合都请求一遍。
 */
func (a *App) scrapeAudioItunes(ctx context.Context, title, artist string) (audioScrapeResult, bool) {
	queries := audioQueryVariants(title, artist)
	if len(queries) == 0 {
		return audioScrapeResult{}, false
	}
	countries := audioCountryOrder(title + " " + artist)
	var best audioScrapeResult
	bestScore := 0
	for _, q := range queries {
		term := strings.TrimSpace(q.Title)
		if q.Artist != "" && q.Artist != "未知歌手" {
			term = strings.TrimSpace(q.Artist) + " " + term
		}
		if term == "" {
			continue
		}
		for _, country := range countries {
			u := strings.TrimRight(itunesSearchBase, "/") + "/search?entity=song&limit=5&country=" + country + "&term=" + url.QueryEscape(term)
			result, score, ok := a.itunesSongSearch(ctx, u, title, artist, q)
			if !ok {
				continue
			}
			if score > bestScore {
				best, bestScore = result, score
			}
			if bestScore >= 5 {
				return best, true
			}
		}
	}
	if bestScore > 0 {
		return best, true
	}
	return audioScrapeResult{}, false
}

// scrapeAudioItunesCountry 使用用户明确指定的商店地区；仍走同一候选硬门槛，绝不采纳首条无关结果。
func (a *App) scrapeAudioItunesCountry(ctx context.Context, title, artist, country string) (audioScrapeResult, bool) {
	if !validAudioCountry(country) || country == "AUTO" {
		return audioScrapeResult{}, false
	}
	best, bestScore := audioScrapeResult{}, 0
	for _, q := range audioQueryVariants(title, artist) {
		term := strings.TrimSpace(q.Title)
		if q.Artist != "" && q.Artist != "未知歌手" {
			term = strings.TrimSpace(q.Artist) + " " + term
		}
		if term == "" {
			continue
		}
		u := strings.TrimRight(itunesSearchBase, "/") + "/search?entity=song&limit=10&country=" + country + "&term=" + url.QueryEscape(term)
		if out, score, ok := a.itunesSongSearch(ctx, u, title, artist, q); ok && score > bestScore {
			best, bestScore = out, score
		}
		if bestScore >= 5 {
			return best, true
		}
	}
	return best, bestScore > 0
}

/*
itunesSongSearch 发一次 entity=song 检索并给候选打分；score 0 表示这一枪没命中。

	打分口径与 itunesPick 一致，这里额外返回分数以便调用侧决定是否提前收手。
*/
func (a *App) itunesSongSearch(ctx context.Context, u, title, artist string, q audioQuery) (audioScrapeResult, int, bool) {
	// 公共 API 节流：单实例 ~200ms/请求（与 MusicBrainz 的 1rps 锁互不影响）。
	a.itunesScrapeMu.Lock()
	if wait := 200*time.Millisecond - time.Since(a.itunesScrapeLast); wait > 0 && !a.itunesScrapeLast.IsZero() {
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			a.itunesScrapeMu.Unlock()
			return audioScrapeResult{}, 0, false
		case <-timer.C:
		}
	}
	client, err := outboundHTTPClient(a.scraperProxy)
	if err != nil {
		a.itunesScrapeMu.Unlock()
		return audioScrapeResult{}, 0, false
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		cancel()
		a.itunesScrapeMu.Unlock()
		return audioScrapeResult{}, 0, false
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "VaultHub/0.9.72 (https://github.com/q807738511/vaulthub)")
	res, err := client.Do(req)
	a.itunesScrapeLast = time.Now()
	a.itunesScrapeMu.Unlock()
	cancel()
	if err != nil {
		return audioScrapeResult{}, 0, false
	}
	var data itunesSearchResponse
	okBody := res.StatusCode == http.StatusOK
	if okBody {
		err = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&data)
	}
	_ = res.Body.Close()
	if !okBody || err != nil {
		return audioScrapeResult{}, 0, false
	}
	out, ok := itunesPick(q.Title, q.Artist, data.Results)
	if !ok {
		// 检索词本身带歌手时，结果里可能有该曲目的其它版本：仍以原始标题/歌手再判一次，
		// 但只有在结果确实以「原始标题 + 原始歌手」出现时才采纳。
		if q.Title == title && q.Artist == artist {
			return audioScrapeResult{}, 0, false
		}
		out, ok = itunesPick(title, artist, data.Results)
		if !ok {
			return audioScrapeResult{}, 0, false
		}
	}
	score := audioCandidateScore(title, artist, out.Title, out.Artist)
	return out, score, score > 0
}

/*
audioCandidateScore：标题+歌手双命中 4 分（标题去修饰后完全相等 5 分），

	仅合作参与者命中 2 分，未知歌手 3 分；**标题完全相等但歌手不匹配 1 分** ——
	1 分是「本地歌手标签写错」时的最后回退（保持旧实现 tier-3 的语义：不会因为
	歌手串不对就完全放弃元数据），任何更高分的候选都会压过它。
	打分口径与 itunesPick 一致，用于跨国家/跨检索词比较候选质量。
*/
func audioCandidateScore(title, artist, gotTitle, gotArtist string) int {
	if !audioTitleMatches(title, gotTitle) {
		return 0
	}
	wantArtist := normalizedAudioText(artist)
	unknownArtist := wantArtist == "" || wantArtist == normalizedAudioText("未知歌手")
	base := 0
	switch {
	case unknownArtist:
		base = 3
	case audioArtistFullMatch(wantArtist, gotArtist):
		base = 4
	default:
		for _, part := range splitAudioCollaborators(artist) {
			if p := normalizedAudioText(part); p != "" && p != wantArtist && audioArtistNameMatches(p, normalizedAudioText(gotArtist)) {
				base = 2
				break
			}
		}
	}
	if base == 0 {
		// 歌手不匹配：只有标题完全相等时才给最低分兜底（旧 tier-3 语义）
		if normalizedAudioText(gotTitle) != normalizedAudioText(title) {
			return 0
		}
		base = 1
	}
	// 去修饰标题完全相等的加分只给「歌手已命中」的候选（base ≥ 2）：
	// 否则低分兜底会升到 2 分，与「仅合作参与者命中」同档，排序失真。
	if base >= 2 {
		if wantStripped := normalizedAudioText(audioStripDecorations(title)); wantStripped != "" &&
			normalizedAudioText(audioStripDecorations(gotTitle)) == wantStripped {
			base++
		}
	}
	return base
}

func (a *App) scrapeAudioMusicBrainz(ctx context.Context, title, artist string) (audioScrapeResult, error) {
	a.audioScrapeMu.Lock()
	defer a.audioScrapeMu.Unlock()
	if wait := time.Second - time.Since(a.audioScrapeLast); wait > 0 && !a.audioScrapeLast.IsZero() {
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return audioScrapeResult{}, ctx.Err()
		case <-timer.C:
		}
	}
	query := `recording:"` + strings.ReplaceAll(title, `"`, "") + `"`
	if artist != "" && artist != "未知歌手" {
		query += ` AND artist:"` + strings.ReplaceAll(artist, `"`, "") + `"`
	}
	u := strings.TrimRight(audioScrapeBase, "/") + "/recording/?query=" + url.QueryEscape(query) + "&fmt=json&limit=3"
	client, err := outboundHTTPClient(a.scraperProxy)
	if err != nil {
		return audioScrapeResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return audioScrapeResult{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "VaultHub/0.9.13 (https://github.com/q807738511/vaulthub)")
	res, err := client.Do(req)
	a.audioScrapeLast = time.Now()
	if err != nil {
		return audioScrapeResult{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return audioScrapeResult{}, fmt.Errorf("musicbrainz http %d", res.StatusCode)
	}
	var data musicBrainzSearch
	limited := io.LimitReader(res.Body, 1<<20)
	if err := json.NewDecoder(limited).Decode(&data); err != nil {
		return audioScrapeResult{}, err
	}
	for _, item := range data.Recordings {
		if !audioCandidateMatches(title, artist, item.Score, item.Title, item.ArtistCredit) {
			continue
		}
		out := audioScrapeResult{Title: item.Title, Artist: artist, Album: "未知专辑", Provider: "MusicBrainz", Recording: item.ID}
		if len(item.ArtistCredit) > 0 {
			out.Artist = item.ArtistCredit[0].Name
		}
		if len(item.Releases) > 0 {
			out.Album, out.Release = item.Releases[0].Title, item.Releases[0].ID
			out.Cover = "https://coverartarchive.org/release/" + url.PathEscape(out.Release) + "/front-500"
		}
		return out, nil
	}
	return audioScrapeResult{}, errors.New("no reliable match")
}

func (a *App) audioMetadata(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	title := strings.TrimSpace(r.URL.Query().Get("title"))
	artist := strings.TrimSpace(r.URL.Query().Get("artist"))
	if title == "" || len(title) > 200 || len(artist) > 200 {
		errJSON(w, 400, "invalid audio query")
		return
	}
	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	source := strings.TrimSpace(r.URL.Query().Get("source"))
	if country == "" {
		country = "AUTO"
	}
	if !validAudioCountry(country) || (source != "" && source != "auto" && source != "iTunes" && source != "MusicBrainz") {
		errJSON(w, 400, "invalid audio scrape hint")
		return
	}
	var out audioScrapeResult
	var err error
	switch source {
	case "MusicBrainz":
		out, err = a.scrapeAudioMusicBrainz(r.Context(), title, artist)
	case "iTunes":
		if country == "AUTO" {
			out, _ = a.scrapeAudioItunes(r.Context(), title, artist)
		} else {
			out, _ = a.scrapeAudioItunesCountry(r.Context(), title, artist, country)
		}
		if out.Provider == "" {
			err = errors.New("no reliable match")
		}
	default:
		if country == "AUTO" {
			out, err = a.scrapeAudio(r.Context(), title, artist)
		} else {
			out, _ = a.scrapeAudioItunesCountry(r.Context(), title, artist, country)
			if out.Provider == "" {
				out, err = a.scrapeAudioMusicBrainz(r.Context(), title, artist)
			}
		}
	}
	if err != nil || out.Provider == "" {
		errJSON(w, 404, "audio metadata not found")
		return
	}
	writeJSON(w, 200, out)
}

/* ================= v0.9.56 歌手刮削 =================
   音乐媒体库「歌手」维度刮削：输入一个演唱者名字（可能带合作标记，如
   「周杰伦 feat. 杨瑞代」），拆出主歌手后查询 iTunes musicArtist（免密钥）。
   注意：iTunes musicArtist 实体不带头像图（实测无 artwork 字段），
   Cover Art Archive 也不收录歌手头像 —— 因此歌手封面取该歌手的
   **代表专辑封面**（lookup artistId entity=album 首条 100x100 → 600x600），
   这是无密钥源里最接近「演唱者形象」的稳定图片；歌手名仍以 musicArtist
   返回的规范 artistName 为准。查不到图时回落 MusicBrainz artist
   （校验规范化名、返回 Person/Group 类型）。组合（五月天/乐队）与单人歌手
   都按 artistName 原样返回，合作关系额外给出全部参与者。 */

type artistScrapeResult struct {
	Name          string   `json:"name"`                    // 规范歌手名（主歌手）
	Cover         string   `json:"cover,omitempty"`         // 歌手封面（600x600，代表专辑图）
	Provider      string   `json:"provider"`                // iTunes | MusicBrainz
	Type          string   `json:"type,omitempty"`          // Person | Group（MusicBrainz 兜底时）
	Collaborators []string `json:"collaborators,omitempty"` // 合作参与者（含主歌手）
}

type itunesArtistResult struct {
	ArtistName    string `json:"artistName"`
	ArtworkURL100 string `json:"artworkUrl100"`
	ArtistID      int64  `json:"artistId"`
}

type itunesArtistSearchResponse struct {
	ResultCount int                  `json:"resultCount"`
	Results     []itunesArtistResult `json:"results"`
}

type itunesAlbumItem struct {
	WrapperType   string `json:"wrapperType"`
	CollectionID  int64  `json:"collectionId"`
	ArtistID      int64  `json:"artistId"`
	ArtistName    string `json:"artistName"`
	ArtworkURL100 string `json:"artworkUrl100"`
}

type itunesLookupResponse struct {
	ResultCount int               `json:"resultCount"`
	Results     []itunesAlbumItem `json:"results"`
}

type musicBrainzArtistHit struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Score   int    `json:"score"`
	Type    string `json:"type,omitempty"` // Person | Group
	Aliases []struct {
		Name   string `json:"name"`
		Locale string `json:"locale,omitempty"`
	} `json:"aliases,omitempty"`
}

// AliasNames 展开别名列表（MusicBrainz 会带出 locale=ja/en 等多语言别名，
// 罗马音规范名通常挂在别名里，例如 米津玄師 → "Kenshi Yonezu"）。
func (h musicBrainzArtistHit) AliasNames() []string {
	out := make([]string, 0, len(h.Aliases))
	for _, a := range h.Aliases {
		if strings.TrimSpace(a.Name) != "" {
			out = append(out, a.Name)
		}
	}
	return out
}

// musicBrainzArtistAliasSearch 是别名查询的响应包装（与 musicBrainzArtistSearch 同形，
// 单独命名以便测试与调用点显式表达「这次调用是为了别名」）。
type musicBrainzArtistAliasSearch struct {
	Artists []musicBrainzArtistHit `json:"artists"`
}

// artistAliasEntry 是歌手别名表的内存缓存项（24 小时有效）。
type artistAliasEntry struct {
	names []string
	at    time.Time
}

type musicBrainzArtistSearch struct {
	Artists []musicBrainzArtistHit `json:"artists"`
}

/*
把「A feat. B」「A & B」「A、B」等合作演唱串拆成参与者。

	优先级：feat./ft./featuring/with > & / 与 > 、/, > ×/x/duet。
	找不到分隔符时整串就是一个歌手（单人/组合）。返回去空白去括号的参与者列表。
*/
func splitAudioCollaborators(name string) []string {
	s := strings.TrimSpace(name)
	if s == "" {
		return nil
	}
	seps := []string{" feat. ", " feat ", " ft. ", " ft ", " featuring ", " with ", " & ", " 与 ", "、", " / ", " × ", " x ", " duet "}
	best := -1
	sepLen := 0
	for _, sep := range seps {
		idx := strings.Index(s, sep)
		if idx >= 0 && (best < 0 || idx < best) {
			best = idx
			sepLen = len(sep)
		}
	}
	var parts []string
	if best < 0 {
		parts = []string{s}
	} else {
		left := strings.TrimSpace(s[:best])
		right := strings.TrimSpace(s[best+sepLen:])
		parts = []string{left, right}
	}
	out := make([]string, 0, len(parts))
	seen := map[string]bool{}
	for _, p := range parts {
		p = strings.TrimSpace(strings.Trim(p, "()（）[]【】"))
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}

/*
itunesPickArtist 从 iTunes musicArtist 结果中挑选命中者。

	注意：iTunes 对简体查询常返回繁体规范名（周杰伦→周杰倫），对日语歌手
	则一律返回罗马音规范名（高橋洋子→Yoko Takahashi、米津玄師→Kenshi Yonezu）。
	简繁交给共享汉字判定；罗马音走 audioArtistAliasMatch（MusicBrainz 别名表）。
	musicArtist 检索词本身就是歌手名、iTunes 已按相关度排序，因此「与查询共享
	任意有效字符」的首条即足够可靠（零公共字才拒绝）。
*/
func itunesPickArtist(want string, hits []itunesArtistResult) (itunesArtistResult, bool) {
	if want == "" {
		return itunesArtistResult{}, false
	}
	wantNorm := normalizedAudioText(want)
	if wantNorm == "" {
		return itunesArtistResult{}, false
	}
	for _, h := range hits {
		if h.ArtistName == "" {
			continue
		}
		if audioArtistNameMatches(want, h.ArtistName) {
			return h, true
		}
	}
	return itunesArtistResult{}, false
}

/*
itunesPickArtistByAlias 用 MusicBrainz 别名表确认「罗马音规范名」就是同一歌手。

	只用于 audioHasCJK 的查询（拉丁查询本来就能直接命中）。
*/
func itunesPickArtistByAlias(want string, aliases []string, hits []itunesArtistResult) (itunesArtistResult, bool) {
	if want == "" || len(aliases) == 0 {
		return itunesArtistResult{}, false
	}
	for _, h := range hits {
		if h.ArtistName == "" {
			continue
		}
		if audioArtistAliasMatch(h.ArtistName, aliases) {
			return h, true
		}
	}
	return itunesArtistResult{}, false
}

// sharedCommonAscii 统计两个字符串共享的 ASCII 字符数（用于英文/拼音名宽松匹配）。
func sharedCommonAscii(a, b string) int {
	set := map[rune]bool{}
	for _, r := range a {
		if r < 128 {
			set[r] = true
		}
	}
	n := 0
	for _, r := range b {
		if r < 128 && set[r] {
			n++
			delete(set, r) // 只计一次：重复字符（如 "aaa"）不重复加分
		}
	}
	return n
}

// itunesGet 带 iTunes 200ms 节流锁的 GET + JSON 解码。
func (a *App) itunesGet(ctx context.Context, u string, dst any) bool {
	a.itunesScrapeMu.Lock()
	if wait := 200*time.Millisecond - time.Since(a.itunesScrapeLast); wait > 0 && !a.itunesScrapeLast.IsZero() {
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			a.itunesScrapeMu.Unlock()
			return false
		case <-timer.C:
		}
	}
	client, err := outboundHTTPClient(a.scraperProxy)
	if err != nil {
		a.itunesScrapeMu.Unlock()
		return false
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		cancel()
		a.itunesScrapeMu.Unlock()
		return false
	}
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	a.itunesScrapeLast = time.Now()
	a.itunesScrapeMu.Unlock()
	cancel()
	if err != nil || res.StatusCode != http.StatusOK {
		if res != nil {
			_ = res.Body.Close()
		}
		return false
	}
	defer res.Body.Close()
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(dst) == nil
}

/*
scrapeAudioArtistItunes 歌手封面主源（v0.9.71 重写）：
 1. 检索词阶梯来自 audioQueryVariants（歌手名通常只需原样/去修饰两份）；
 2. 店铺顺序按脚本选择，含 JP/HK —— 实测「DAOKO×米津玄師」在 TW/US/HK 三家
    店铺都返回 0 条，只有 JP 店铺返回结果；
 3. 直接匹配失败且查询含 CJK 时，用 MusicBrainz 别名表桥接罗马音规范名
    （高橋洋子 → Yoko Takahashi、米津玄師 → Kenshi Yonezu、ヨルシカ → Yorushika），
    这是旧实现里日语歌手封面「永远刮不到」的根因。
    命中后取 600x600 头像；musicArtist 实体不带图则 lookup 其代表专辑封面。
*/
func (a *App) scrapeAudioArtistItunes(ctx context.Context, name string) (artistScrapeResult, bool) {
	if strings.TrimSpace(name) == "" {
		return artistScrapeResult{}, false
	}
	queries := audioQueryVariants(name, "")
	if len(queries) == 0 {
		return artistScrapeResult{}, false
	}
	var pending []itunesArtistResult
	seen := map[int64]bool{}
	collect := func(hits []itunesArtistResult) {
		for _, h := range hits {
			if h.ArtistID == 0 || h.ArtistName == "" || seen[h.ArtistID] {
				continue
			}
			seen[h.ArtistID] = true
			pending = append(pending, h)
		}
	}
	for _, q := range queries {
		for _, country := range audioCountryOrder(q.Title) {
			u := strings.TrimRight(itunesSearchBase, "/") + "/search?entity=musicArtist&limit=5&country=" + country + "&term=" + url.QueryEscape(q.Title)
			var data itunesArtistSearchResponse
			if !a.itunesGet(ctx, u, &data) {
				continue
			}
			if hit, ok := itunesPickArtist(name, data.Results); ok {
				if res, ok := a.artistResultForHit(ctx, hit); ok {
					return res, true
				}
			}
			collect(data.Results)
		}
	}
	// 罗马音桥接：只在查询含中日文字符时才需要（拉丁查询能直接命中）。
	if len(pending) > 0 && audioHasCJK(name) {
		aliases := a.audioArtistAliasNames(ctx, name)
		if hit, ok := itunesPickArtistByAlias(name, aliases, pending); ok {
			if res, ok := a.artistResultForHit(ctx, hit); ok {
				return res, true
			}
		}
	}
	return artistScrapeResult{}, false
}

/*
artistResultForHit 把 iTunes 命中转成 artistScrapeResult：头像优先，

	没有头像时 lookup 该歌手的代表专辑封面（musicArtist 实体通常不带 artwork）。
*/
func (a *App) artistResultForHit(ctx context.Context, hit itunesArtistResult) (artistScrapeResult, bool) {
	if hit.ArtistName == "" || hit.ArtistID == 0 {
		return artistScrapeResult{}, false
	}
	out := artistScrapeResult{Name: hit.ArtistName, Provider: "iTunes"}
	if hit.ArtworkURL100 != "" {
		out.Cover = audioHiResArtwork(hit.ArtworkURL100)
		return out, true
	}
	lu := strings.TrimRight(itunesSearchBase, "/") + "/lookup?id=" + fmt.Sprintf("%d", hit.ArtistID) + "&entity=album&limit=1"
	var lr itunesLookupResponse
	if a.itunesGet(ctx, lu, &lr) {
		for _, item := range lr.Results {
			if item.WrapperType == "collection" && item.ArtworkURL100 != "" {
				out.Cover = audioHiResArtwork(item.ArtworkURL100)
				return out, true
			}
		}
	}
	return artistScrapeResult{}, false
}

/*
audioArtistAliasNames 取 MusicBrainz 的歌手规范名与别名（含罗马音名）。

	结果带 24 小时内存缓存（批量刮削时同一歌手只查一次 MusicBrainz）；
	命中要求 MB score ≥ 88 且与查询名匹配，避免同名歧义歌手污染别名表。
*/
func (a *App) audioArtistAliasNames(ctx context.Context, name string) []string {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	a.artistAliasMu.Lock()
	if entry, ok := a.artistAliasCache[name]; ok && time.Since(entry.at) < 24*time.Hour {
		a.artistAliasMu.Unlock()
		return entry.names
	}
	a.artistAliasMu.Unlock()

	client, err := outboundHTTPClient(a.scraperProxy)
	if err != nil {
		return nil
	}
	query := `artist:"` + strings.ReplaceAll(name, `"`, "") + `"`
	u := strings.TrimRight(audioScrapeBase, "/") + "/artist/?query=" + url.QueryEscape(query) + "&fmt=json&limit=3"
	/* 与 scrapeAudioMusicBrainz 相同的持锁模式：整段请求都在 audioScrapeMu 下完成，
	   既满足 MusicBrainz 的 1 请求/秒约定，也不与歌曲侧请求并发打过去。 */
	a.audioScrapeMu.Lock()
	defer a.audioScrapeMu.Unlock()
	if wait := time.Second - time.Since(a.audioScrapeLast); wait > 0 && !a.audioScrapeLast.IsZero() {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
	}
	reqCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "VaultHub/0.9.72 (https://github.com/q807738511/vaulthub)")
	res, err := client.Do(req)
	a.audioScrapeLast = time.Now()
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	var data musicBrainzArtistAliasSearch
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&data); err != nil {
		return nil
	}
	var names []string
	seen := map[string]bool{}
	for _, hit := range data.Artists {
		if hit.Score < 88 || !audioArtistNameMatches(name, hit.Name) {
			continue
		}
		for _, candidate := range append([]string{hit.Name}, hit.AliasNames()...) {
			key := normalizedAudioText(candidate)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			names = append(names, candidate)
		}
		break // 只采信最相关的一条记录
	}
	if len(names) > 0 {
		a.artistAliasMu.Lock()
		if a.artistAliasCache == nil {
			a.artistAliasCache = map[string]artistAliasEntry{}
		}
		if len(a.artistAliasCache) >= 256 { // 有界：满了就整表丢弃重建
			a.artistAliasCache = map[string]artistAliasEntry{}
		}
		a.artistAliasCache[name] = artistAliasEntry{names: names, at: time.Now()}
		a.artistAliasMu.Unlock()
	}
	return names
}

/* musicBrainzWait 已并入 audioArtistAliasNames（与歌曲侧同样的持锁节流模式），
   不再单独暴露。 */

// scrapeAudioArtistMusicBrainz 兜底：校验歌手存在并返回规范名（无头像时 cover 留空）。
func (a *App) scrapeAudioArtistMusicBrainz(ctx context.Context, name string) (artistScrapeResult, error) {
	a.audioScrapeMu.Lock()
	defer a.audioScrapeMu.Unlock()
	if wait := time.Second - time.Since(a.audioScrapeLast); wait > 0 && !a.audioScrapeLast.IsZero() {
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return artistScrapeResult{}, ctx.Err()
		case <-timer.C:
		}
	}
	query := `artist:"` + strings.ReplaceAll(name, `"`, "") + `"`
	u := strings.TrimRight(audioScrapeBase, "/") + "/artist/?query=" + url.QueryEscape(query) + "&fmt=json&limit=5"
	client, err := outboundHTTPClient(a.scraperProxy)
	if err != nil {
		return artistScrapeResult{}, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return artistScrapeResult{}, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	a.audioScrapeLast = time.Now()
	if err != nil {
		return artistScrapeResult{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return artistScrapeResult{}, fmt.Errorf("musicbrainz artist http %d", res.StatusCode)
	}
	var data musicBrainzArtistSearch
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&data); err != nil {
		return artistScrapeResult{}, err
	}
	want := normalizedAudioText(name)
	for _, hit := range data.Artists {
		got := normalizedAudioText(hit.Name)
		if hit.Score < 88 || got != want && !strings.Contains(got, want) && !strings.Contains(want, got) {
			continue
		}
		typ := hit.Type
		if typ == "Person" {
			typ = "solo"
		} else if typ == "Group" {
			typ = "group"
		}
		return artistScrapeResult{Name: hit.Name, Provider: "MusicBrainz", Type: typ}, nil
	}
	return artistScrapeResult{}, errors.New("no reliable artist match")
}

/*
v0.9.56 歌手刮削入口：iTunes 头像主源 → MusicBrainz 兜底（仅规范名，无头像）。

	合作串（feat./&/、等）拆出全部参与者；主歌手决定封面，collaborators 供前端展示。
*/
func (a *App) scrapeAudioArtist(ctx context.Context, name string) artistScrapeResult {
	parts := splitAudioCollaborators(name)
	lead := parts[0]
	if lead == "" {
		lead = name
	}
	out := artistScrapeResult{Name: lead, Collaborators: parts}
	if res, ok := a.scrapeAudioArtistItunes(ctx, lead); ok {
		res.Collaborators = parts
		return res
	}
	if res, err := a.scrapeAudioArtistMusicBrainz(ctx, lead); err == nil {
		res.Collaborators = parts
		return res
	}
	out.Provider = "" // 无源命中：前端保持文字/首字母占位，不覆盖已有封面
	return out
}

func (a *App) audioArtist(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" || len(name) > 200 {
		errJSON(w, 400, "invalid artist name")
		return
	}
	out := a.scrapeAudioArtist(r.Context(), name)
	if out.Provider == "" {
		errJSON(w, 404, "artist cover not found")
		return
	}
	writeJSON(w, 200, out)
}
