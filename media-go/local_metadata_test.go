package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalMetadataReadsNFOImagesAndSubtitles(t *testing.T) {
	d := t.TempDir()
	files := map[string]string{
		"Show.S01E01.mkv":        "video",
		"Show.S01E01.nfo":        `<?xml version="1.0" encoding="UTF-8"?><episodedetails><title>第一集</title><showtitle>示例剧</showtitle><year>2024</year><plot>本地简介</plot><runtime>46</runtime><rating>8.7</rating><genre>剧情</genre><genre>科幻</genre><actor><name>演员甲</name><role>角色甲</role></actor><uniqueid type="tvdb" default="true">12345</uniqueid></episodedetails>`,
		"Show.S01E01-poster.png": "png",
		"fanart.jpg":             "jpg",
		"Show.S01E01.zh-CN.srt":  "subtitle",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(d, name), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	a := &App{libs: []Library{{ID: "tv", Name: "TV", Type: "series", Path: d}}}
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	r := httptest.NewRequest(http.MethodGet, "/api/media/metadata?id=tv&path=Show.S01E01.mkv", nil)
	w := httptest.NewRecorder()
	a.localMetadata(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var got localMediaMetadata
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Title != "第一集" || got.ShowTitle != "示例剧" || got.Provider != "本地 NFO" || got.TVDBID != "12345" {
		t.Fatalf("metadata=%+v", got)
	}
	if len(got.Genres) != 2 || len(got.Cast) != 1 || !strings.Contains(got.Poster, "Show.S01E01-poster.png") || !strings.Contains(got.Backdrop, "fanart.jpg") {
		t.Fatalf("assets=%+v", got)
	}
	if len(got.Subtitles) != 1 || !strings.Contains(got.Subtitles[0].URL, "Show.S01E01.zh-CN.srt") {
		t.Fatalf("subtitles=%+v", got.Subtitles)
	}
}

func TestLocalMetadataFallsBackToMovieNFOAndCommonArtwork(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "Film.mkv"), []byte("v"), 0644)
	os.WriteFile(filepath.Join(d, "movie.nfo"), []byte(`<movie><title>本地电影</title><premiered>2023-01-02</premiered><outline>简介</outline><thumb aspect="poster">poster.jpg</thumb><fanart><thumb>backdrop.png</thumb></fanart></movie>`), 0644)
	os.WriteFile(filepath.Join(d, "poster.jpg"), []byte("p"), 0644)
	os.WriteFile(filepath.Join(d, "backdrop.png"), []byte("b"), 0644)
	a := &App{libs: []Library{{ID: "movie", Type: "movie", Path: d}}}
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	w := httptest.NewRecorder()
	a.localMetadata(w, httptest.NewRequest(http.MethodGet, "/api/media/metadata?id=movie&path=Film.mkv", nil))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var got localMediaMetadata
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Title != "本地电影" || got.Year != "2023" || got.Poster == "" || got.Backdrop == "" {
		t.Fatalf("got=%+v", got)
	}
}

func TestLocalMetadataRequiresSessionAndSafePath(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "Film.mkv"), []byte("v"), 0644)
	a := &App{libs: []Library{{ID: "movie", Type: "movie", Path: d}}}
	old := managerSessionOK
	defer func() { managerSessionOK = old }()
	managerSessionOK = func(*http.Request) bool { return false }
	w := httptest.NewRecorder()
	a.localMetadata(w, httptest.NewRequest(http.MethodGet, "/api/media/metadata?id=movie&path=Film.mkv", nil))
	if w.Code != 401 {
		t.Fatalf("unauth=%d", w.Code)
	}
	managerSessionOK = func(*http.Request) bool { return true }
	w = httptest.NewRecorder()
	a.localMetadata(w, httptest.NewRequest(http.MethodGet, "/api/media/metadata?id=movie&path=../escape.mkv", nil))
	if w.Code != 404 {
		t.Fatalf("unsafe=%d", w.Code)
	}
}

func TestExternalVTTSubtitleIsServedAsTrack(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "Film.mkv"), []byte("v"), 0644)
	os.WriteFile(filepath.Join(d, "Film.zh.vtt"), []byte("WEBVTT\n\n00:00.000 --> 00:01.000\n字幕"), 0644)
	a := &App{libs: []Library{{ID: "movie", Type: "movie", Path: d}}}
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = old }()
	w := httptest.NewRecorder()
	a.externalSubtitle(w, httptest.NewRequest(http.MethodGet, "/api/media/subtitles/proxy?id=movie&path=Film.zh.vtt", nil))
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/vtt") || !strings.Contains(w.Body.String(), "WEBVTT") {
		t.Fatalf("status=%d type=%s body=%s", w.Code, w.Header().Get("Content-Type"), w.Body.String())
	}
}

func TestCommonMetadataNotSharedAcrossMultipleVideos(t *testing.T) {
	d := t.TempDir()
	for _, name := range []string{"A.mkv", "B.mkv"} {
		os.WriteFile(filepath.Join(d, name), []byte("v"), 0644)
	}
	os.WriteFile(filepath.Join(d, "movie.nfo"), []byte(`<movie><title>错误共享</title></movie>`), 0644)
	os.WriteFile(filepath.Join(d, "poster.jpg"), []byte("p"), 0644)
	os.WriteFile(filepath.Join(d, "A.jpg"), []byte("ambiguous"), 0644)
	lib := Library{ID: "movie", Type: "movie", Path: d}
	for _, name := range []string{"A.mkv", "B.mkv"} {
		got, err := readLocalMediaMetadata(lib, name)
		if err != nil {
			t.Fatal(err)
		}
		if got.NFO != "" || got.Poster != "" {
			t.Fatalf("%s incorrectly inherited common metadata: %+v", name, got)
		}
	}
}
