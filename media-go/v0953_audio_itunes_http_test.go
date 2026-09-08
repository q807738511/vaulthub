package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestV0953ScrapeAudioPrefersItunesOverMusicBrainz(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == "" {
			t.Fatal("missing user agent")
		}
		if r.URL.Path == "/search" {
			_ = json.NewEncoder(w).Encode(itunesSearchResponse{
				ResultCount: 1,
				Results: []itunesTrack{{
					TrackName:      "青花瓷",
					ArtistName:     "周杰倫",
					CollectionName: "我很忙",
					ArtworkURL100:  "https://x/source/100x100bb.jpg",
				}},
			})
			return
		}
		// MusicBrainz 分支不应到达：iTunes 已命中。若到达返回低分录音确保测试失败可辨。
		_ = json.NewEncoder(w).Encode(map[string]any{"recordings": []any{}})
	}))
	defer s.Close()
	oldItunes := itunesSearchBase
	itunesSearchBase = s.URL
	defer func() { itunesSearchBase = oldItunes }()
	oldClient := outboundHTTPClient
	outboundHTTPClient = func(string) (*http.Client, error) { return s.Client(), nil }
	defer func() { outboundHTTPClient = oldClient }()

	got, err := (&App{}).scrapeAudio(context.Background(), "青花瓷", "周杰伦")
	if err != nil {
		t.Fatalf("scrapeAudio: %v", err)
	}
	if got.Provider != "iTunes" || got.Album != "我很忙" {
		t.Fatalf("expected iTunes result, got %+v", got)
	}
}
