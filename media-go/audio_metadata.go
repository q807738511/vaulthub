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

func (a *App) scrapeAudio(ctx context.Context, title, artist string) (audioScrapeResult, error) {
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
