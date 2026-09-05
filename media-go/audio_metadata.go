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

/* v0.9.56：音乐刮削主源换成 iTunes Search API —— 无需注册/密钥、返回极简 JSON、
   中文曲库完整（按 TW/US store 依次查询），专辑与高清封面一次到位；
   刮削与音频容器格式无关（mp3/flac/m4a/ogg/wav/aac/ape/opus 等媒体库已支持格式
   全部按 文件名→标签 解析出的 标题/歌手 查询）。MusicBrainz 保留为兜底源，
   处理 iTunes 检索不到的英文/小众曲目。 */
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

/* v0.9.56：itunesSearchBase 是 API 根（不含路径），search/lookup 各自拼自己的端点。
   旧值曾是 ".../search" 又在调用处再拼 "/search"，实际请求 /search/search（Apple 容错才 200），
   而 lookup 拼成 /search/lookup 一律返回空结果集 —— 歌手封面因此永远刮不到。 */
var itunesSearchBase = "https://itunes.apple.com"
var itunesCountryOrder = []string{"TW", "US"}

// audioHiResArtwork 把 iTunes 100x100 缩略图 URL 提升到 600x600。
func audioHiResArtwork(u string) string {
	if strings.Contains(u, "100x100bb") {
		return strings.Replace(u, "100x100bb", "600x600bb", 1)
	}
	return u
}

// audioArtistNameMatches 判断本地歌手标签与 iTunes 规范歌手名是否指同一演唱者。
// iTunes 对简体查询常返回繁体名（周杰伦→周杰倫），归一化不折叠简繁，只能靠共享
// 字符判断：共享 ≥2 个非拉丁字符即视为同一人；纯拉丁名要求共享 ≥3 个 ASCII 字符。
func audioArtistNameMatches(want, got string) bool {
	if want == "" || got == "" {
		return false
	}
	if want == got || strings.Contains(got, want) || strings.Contains(want, got) {
		return true
	}
	shared := 0
	for _, r := range want {
		if r >= 128 && strings.ContainsRune(got, r) {
			shared++
		}
	}
	if shared >= 2 {
		return true
	}
	return len(want) >= 4 && len(got) >= 4 && sharedCommonAscii(want, got) >= 3
}

// itunesPick 从 iTunes 结果中挑选可靠候选。
// v0.9.56：按 iTunes 相关度顺序取「标题命中 且 歌手命中」的第一条（歌手候选含合作串
// 拆出的每个参与者，简繁差异用共享字符兜底）；只有整轮都没有歌手命中时，才退回
// 「标题完全相等」的首条。旧实现先看「标题完全相等」，合作演唱曲目（如
// 「周杰伦 feat. 费玉清 - 千里之外」，正确条目标题带 (feat. 費玉清)）会被
// 标题恰好相等的翻唱版本（雨天 & 楊蔓《世間情歌》）抢走元数据。
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
	titleOK := func(got string) bool {
		if got == "" {
			return false
		}
		return got == wantTitle || strings.Contains(got, wantTitle) || strings.Contains(wantTitle, got)
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
	// 第一趟：标题 + 歌手双命中，按 iTunes 相关度顺序取首条
	for _, tr := range tracks {
		if !titleOK(normalizedAudioText(tr.TrackName)) {
			continue
		}
		gotArtist := normalizedAudioText(tr.ArtistName)
		for _, cand := range artistCandidates {
			if audioArtistNameMatches(cand, gotArtist) {
				return build(tr), true
			}
		}
	}
	// 第二趟：歌手无从校验（未知歌手）或全部落空 → 只接受标题完全相等的首条
	for _, tr := range tracks {
		gotTitle := normalizedAudioText(tr.TrackName)
		if gotTitle == wantTitle || (unknownArtist && titleOK(gotTitle)) {
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

func normalizedAudioText(v string) string {
	return strings.Map(func(r rune) rune {
		if strings.ContainsRune(" ._-–—'\"`·、,，:：!！?？()（）[]", r) {
			return -1
		}
		return r
	}, strings.ToLower(strings.TrimSpace(v)))
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

/* v0.9.56 入口：iTunes 主源，失败回落 MusicBrainz（英文/小众曲目）。
   合作演唱串（「A feat. B」「A & B」）整串检索命中率极低 —— 再用主歌手重试一次，
   全部落空时返回错误，前端保持文件名解析出的标题/歌手展示。 */
func (a *App) scrapeAudio(ctx context.Context, title, artist string) (audioScrapeResult, error) {
	if out, ok := a.scrapeAudioItunes(ctx, title, artist); ok {
		return out, nil
	}
	if parts := splitAudioCollaborators(artist); len(parts) > 1 && parts[0] != "" && parts[0] != artist {
		if out, ok := a.scrapeAudioItunes(ctx, title, parts[0]); ok {
			return out, nil
		}
	}
	return a.scrapeAudioMusicBrainz(ctx, title, artist)
}

func (a *App) scrapeAudioItunes(ctx context.Context, title, artist string) (audioScrapeResult, bool) {
	term := strings.TrimSpace(title)
	if artist != "" && artist != "未知歌手" {
		term = strings.TrimSpace(artist) + " " + term
	}
	for _, country := range itunesCountryOrder {
		u := strings.TrimRight(itunesSearchBase, "/") + "/search?entity=song&limit=5&country=" + country + "&term=" + url.QueryEscape(term)
		// 公共 API 节流：单实例 ~200ms/请求（与 MusicBrainz 的 1rps 锁互不影响）。
		a.itunesScrapeMu.Lock()
		if wait := 200*time.Millisecond - time.Since(a.itunesScrapeLast); wait > 0 && !a.itunesScrapeLast.IsZero() {
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				a.itunesScrapeMu.Unlock()
				return audioScrapeResult{}, false
			case <-timer.C:
			}
		}
		client, err := outboundHTTPClient(a.scraperProxy)
		if err != nil {
			a.itunesScrapeMu.Unlock()
			return audioScrapeResult{}, false
		}
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
		if err != nil {
			cancel()
			a.itunesScrapeMu.Unlock()
			return audioScrapeResult{}, false
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "VaultHub/0.9.56 (https://github.com/q807738511/vaulthub)")
		res, err := client.Do(req)
		a.itunesScrapeLast = time.Now()
		a.itunesScrapeMu.Unlock()
		cancel()
		if err != nil {
			continue
		}
		var data itunesSearchResponse
		okBody := res.StatusCode == http.StatusOK
		if okBody {
			err = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&data)
		}
		_ = res.Body.Close()
		if okBody && err == nil {
			if out, ok := itunesPick(title, artist, data.Results); ok {
				return out, true
			}
		}
	}
	return audioScrapeResult{}, false
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
	out, err := a.scrapeAudio(r.Context(), title, artist)
	if err != nil {
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
	ID     string `json:"id"`
	Name   string `json:"name"`
	Score  int    `json:"score"`
	Type   string `json:"type,omitempty"` // Person | Group
}

type musicBrainzArtistSearch struct {
	Artists []musicBrainzArtistHit `json:"artists"`
}

/* 把「A feat. B」「A & B」「A、B」等合作演唱串拆成参与者。
   优先级：feat./ft./featuring/with > & / 与 > 、/, > ×/x/duet。
   找不到分隔符时整串就是一个歌手（单人/组合）。返回去空白去括号的参与者列表。 */
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

// itunesPickArtist 从 iTunes musicArtist 结果中挑选命中者。
// 注意：iTunes 对简体查询常返回繁体规范名（周杰伦→周杰倫），归一化去标点后
// 简繁不折叠，全等/包含匹配会全部落空；而 entity=musicArtist&term=<歌手名>
// 的检索词本身就是歌手名，iTunes 已按相关度排序 —— 取「与查询共享任意字符」
// 的首条即足够可靠（完全无关的名字才拒绝，例如查询词为空或零公共字）。
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
		got := normalizedAudioText(h.ArtistName)
		if got == wantNorm || strings.Contains(got, wantNorm) || strings.Contains(wantNorm, got) {
			return h, true
		}
		// 简繁/别名差异：共享至少一个非拉丁字符（汉字/假名）即视为同一歌手；
		// 纯拉丁名要求共享 3 个以上字符，避免「Jay」误配到「Jay-Z」以外的对象。
		shared := 0
		for _, r := range wantNorm {
			if r < 128 {
				continue
			}
			if strings.ContainsRune(got, r) {
				shared++
			}
		}
		if shared >= 1 {
			return h, true
		}
		if len(wantNorm) >= 4 && len(got) >= 4 && sharedCommonAscii(wantNorm, got) >= 3 {
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

func (a *App) scrapeAudioArtistItunes(ctx context.Context, name string) (artistScrapeResult, bool) {
	for _, country := range itunesCountryOrder {
		u := strings.TrimRight(itunesSearchBase, "/") + "/search?entity=musicArtist&limit=5&country=" + country + "&term=" + url.QueryEscape(name)
		var data itunesArtistSearchResponse
		if !a.itunesGet(ctx, u, &data) {
			continue
		}
		hit, ok := itunesPickArtist(name, data.Results)
		if !ok || hit.ArtistName == "" || hit.ArtistID == 0 {
			continue
		}
		out := artistScrapeResult{Name: hit.ArtistName, Provider: "iTunes"}
		if hit.ArtworkURL100 != "" {
			out.Cover = audioHiResArtwork(hit.ArtworkURL100)
			return out, true
		}
		// musicArtist 实体不带 artwork：lookup 该歌手的代表专辑取封面
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
	}
	return artistScrapeResult{}, false
}

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

/* v0.9.56 歌手刮削入口：iTunes 头像主源 → MusicBrainz 兜底（仅规范名，无头像）。
   合作串（feat./&/、等）拆出全部参与者；主歌手决定封面，collaborators 供前端展示。 */
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
