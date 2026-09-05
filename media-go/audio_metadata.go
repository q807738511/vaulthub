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

/* v0.9.55：音乐刮削主源换成 iTunes Search API —— 无需注册/密钥、返回极简 JSON、
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

var itunesSearchBase = "https://itunes.apple.com/search"
var itunesCountryOrder = []string{"TW", "US"}

// audioHiResArtwork 把 iTunes 100x100 缩略图 URL 提升到 600x600。
func audioHiResArtwork(u string) string {
	if strings.Contains(u, "100x100bb") {
		return strings.Replace(u, "100x100bb", "600x600bb", 1)
	}
	return u
}

// itunesPick 从 iTunes 结果中挑选可靠候选：先要求 标题+歌手 双重归一化命中，
// 退而求其次只接受 标题完全相等 的首条（iTunes 检索词已带歌手，翻唱误配概率低，
// 且中文繁简差异无法靠小写/去标点归一化消除）。
func itunesPick(title, artist string, tracks []itunesTrack) (audioScrapeResult, bool) {
	wantTitle := normalizedAudioText(title)
	if wantTitle == "" || len(tracks) == 0 {
		return audioScrapeResult{}, false
	}
	wantArtist := normalizedAudioText(artist)
	unknownArtist := wantArtist == "" || wantArtist == normalizedAudioText("未知歌手")
	titleOK := func(got string) bool {
		if got == "" {
			return false
		}
		return got == wantTitle || strings.Contains(got, wantTitle) || strings.Contains(wantTitle, got)
	}
	for _, tr := range tracks {
		gotTitle := normalizedAudioText(tr.TrackName)
		if !titleOK(gotTitle) {
			continue
		}
		artistOK := unknownArtist
		if !artistOK {
			gotArtist := normalizedAudioText(tr.ArtistName)
			artistOK = gotArtist == wantArtist || strings.Contains(gotArtist, wantArtist) || strings.Contains(wantArtist, gotArtist)
		}
		if artistOK || gotTitle == wantTitle {
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
			return out, true
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

/* v0.9.55 入口：iTunes 主源，失败回落 MusicBrainz（英文/小众曲目）。 */
func (a *App) scrapeAudio(ctx context.Context, title, artist string) (audioScrapeResult, error) {
	if out, ok := a.scrapeAudioItunes(ctx, title, artist); ok {
		return out, nil
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
		req.Header.Set("User-Agent", "VaultHub/0.9.55 (https://github.com/q807738511/vaulthub)")
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
