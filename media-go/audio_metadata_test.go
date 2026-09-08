package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestV0913AudioScrapeAcceptsReliableMusicBrainzMatch(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == "" {
			t.Fatal("missing user agent")
		}
		io := map[string]any{
			"recordings": []any{map[string]any{
				"id": "rec1", "score": 100, "title": "Seven Nation Army",
				"artist-credit": []any{map[string]any{"name": "The White Stripes"}},
				"releases":      []any{map[string]any{"id": "rel1", "title": "Elephant"}},
			}},
		}
		_ = json.NewEncoder(w).Encode(io)
	}))
	defer s.Close()
	oldBase := audioScrapeBase
	audioScrapeBase = s.URL
	defer func() { audioScrapeBase = oldBase }()
	oldItunes := itunesSearchBase
	itunesSearchBase = s.URL // 同一测试服务器返回非 iTunes JSON → 0 结果,确保回落 MusicBrainz
	defer func() { itunesSearchBase = oldItunes }()
	oldClient := outboundHTTPClient
	outboundHTTPClient = func(string) (*http.Client, error) { return s.Client(), nil }
	defer func() { outboundHTTPClient = oldClient }()

	got, err := (&App{}).scrapeAudio(context.Background(), "Seven Nation Army", "The White Stripes")
	if err != nil || got.Title != "Seven Nation Army" || got.Album != "Elephant" || got.Provider != "MusicBrainz" || got.Cover == "" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}

func TestV0913AudioScrapeRejectsLowScore(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"recordings": []any{map[string]any{
				"id": "bad", "score": 70, "title": "Seven Nation Army",
				"artist-credit": []any{map[string]any{"name": "The White Stripes"}},
			}},
		})
	}))
	defer s.Close()
	oldBase := audioScrapeBase
	audioScrapeBase = s.URL
	defer func() { audioScrapeBase = oldBase }()
	oldItunes := itunesSearchBase
	itunesSearchBase = s.URL
	defer func() { itunesSearchBase = oldItunes }()
	oldClient := outboundHTTPClient
	outboundHTTPClient = func(string) (*http.Client, error) { return s.Client(), nil }
	defer func() { outboundHTTPClient = oldClient }()

	if _, err := (&App{}).scrapeAudio(context.Background(), "Seven Nation Army", "The White Stripes"); err == nil {
		t.Fatal("low score accepted")
	}
}
