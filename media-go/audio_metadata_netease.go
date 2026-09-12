package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

/* v0.9.67：新增刮削源 —— 网易云搜索（默认关闭，VAULTHUB_LYRICS_NETEASE=1 开启）。
 *
 * 动机（用户反馈）：现有 iTunes(TW/US) + MusicBrainz 对华语老歌、翻唱、冷门曲目
 * 命中率有限，刮削经常落空只能退回文件名。网易云搜索返回 名称/歌手/专辑/高清封面，
 * 对中文曲库命中率明显更高（实测 200 / 0.14s）。
 *
 * 风险与边界：这是**未公开接口**，可能随时变更或封禁，且存在 ToS 争议 ——
 * 因此默认关闭，失败只降级不阻断整条刮削链；只调用只读搜索接口，不涉及账号。
 */

type neteaseArtist struct {
	Name string `json:"name"`
}

type neteaseAlbum struct {
	Name    string          `json:"name"`
	PicURL  string          `json:"picUrl"`
	Artist  *neteaseArtist  `json:"artist"`
	Artists []neteaseArtist `json:"artists"`
}

type neteaseSong struct {
	ID      int64           `json:"id"`
	Name    string          `json:"name"`
	Artists []neteaseArtist `json:"artists"`
	Album   neteaseAlbum    `json:"album"`
}

type neteaseSearchResponse struct {
	Result struct {
		Songs []neteaseSong `json:"songs"`
	} `json:"result"`
}

func (a *App) scrapeAudioNetease(ctx context.Context, title, artist string) (audioScrapeResult, bool) {
	if !a.neteaseLyricsEnabled() {
		return audioScrapeResult{}, false
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return audioScrapeResult{}, false
	}
	term := title
	if artist != "" && artist != "未知歌手" {
		term = artist + " " + title
	}
	client, err := a.lyricsClient()
	if err != nil {
		return audioScrapeResult{}, false
	}
	a.lyricsThrottle(ctx)
	u := fmt.Sprintf("%s/api/search/get?s=%s&type=1&limit=8", neteaseBase, url.QueryEscape(term))
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return audioScrapeResult{}, false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (VaultHub metadata scraper)")
	res, err := client.Do(req)
	if err != nil {
		return audioScrapeResult{}, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return audioScrapeResult{}, false
	}
	var body neteaseSearchResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&body); err != nil {
		return audioScrapeResult{}, false
	}
	if len(body.Result.Songs) == 0 {
		return audioScrapeResult{}, false
	}
	norm := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		return strings.NewReplacer(" ", "", "-", "", "_", "", "(", "", ")", "", "[", "", "]", "", "（", "", "）", "").Replace(s)
	}
	nt, na := norm(title), norm(artist)
	for _, song := range body.Result.Songs {
		if norm(song.Name) != nt {
			continue
		}
		name := ""
		if len(song.Artists) > 0 {
			name = song.Artists[0].Name
		}
		if name == "" {
			return audioScrapeResult{}, false
		}
		if na != "" && !audioArtistNameMatches(artist, name) && norm(name) != na {
			continue
		}
		out := audioScrapeResult{
			Title:    song.Name,
			Artist:   name,
			Album:    song.Album.Name,
			Cover:    strings.Replace(song.Album.PicURL, "http://", "https://", 1),
			Provider: "NetEase",
		}
		if out.Album == "" {
			out.Album = "未知专辑"
		}
		return out, true
	}
	return audioScrapeResult{}, false
}

/*
coverArtArchiveURL 在 MusicBrainz 命中但没有封面时补一个按 MBID 取封面的直链

	（实测 coverartarchive.org 可达；无图时返回 404，前端回落渐变占位）。
	不额外发请求：仅拼 URL，由浏览器按需加载。
*/
func coverArtArchiveURL(release string) string {
	release = strings.TrimSpace(release)
	if release == "" {
		return ""
	}
	return "https://coverartarchive.org/release/" + release + "/front-500"
}
