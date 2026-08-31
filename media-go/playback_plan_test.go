package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChoosePlaybackPlan(t *testing.T) {
	cases := []struct {
		name      string
		media     playbackMedia
		client    playbackClient
		wantMode  string
		wantVideo string
		wantAudio string
	}{
		{"compatible mp4 direct", playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}, playbackClient{MP4: true, H264: true, AAC: true}, "direct", "copy", "copy"},
		{"mkv h264 aac remux", playbackMedia{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac"}, playbackClient{MP4: true, H264: true, AAC: true}, "remux", "copy", "copy"},
		{"mkv h264 dts audio transcode", playbackMedia{Container: "mkv", VideoCodec: "h264", AudioCodec: "dts"}, playbackClient{MP4: true, H264: true, AAC: true}, "audio_transcode", "copy", "aac"},
		{"hevc full transcode", playbackMedia{Container: "mkv", VideoCodec: "hevc", AudioCodec: "dts"}, playbackClient{MP4: true, H264: true, AAC: true, HEVC: false}, "full_transcode", "h264", "aac"},
		{"browser hevc mp4 direct", playbackMedia{Container: "mp4", VideoCodec: "hevc", AudioCodec: "aac"}, playbackClient{MP4: true, HEVC: true, AAC: true}, "direct", "copy", "copy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := choosePlaybackPlan(tc.media, tc.client, "auto", "cuda")
			if got.Mode != tc.wantMode || got.VideoAction != tc.wantVideo || got.AudioAction != tc.wantAudio {
				t.Fatalf("got mode=%s video=%s audio=%s reason=%s", got.Mode, got.VideoAction, got.AudioAction, got.Reason)
			}
			if got.Layer == "" {
				t.Fatalf("plan missing layer: %+v", got)
			}
		})
	}
}

func TestPlaybackPlanHandlerUsesSafeLibraryPath(t *testing.T) {
	oldSession := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldSession }()
	dir := t.TempDir()
	media := filepath.Join(dir, "sample.mp4")
	if err := os.WriteFile(media, []byte("fixture"), 0644); err != nil {
		t.Fatal(err)
	}
	a := &App{libs: []Library{{ID: "lib", Path: dir}}, tasks: map[string]context.CancelFunc{}}
	old := probePlaybackMedia
	probePlaybackMedia = func(_ context.Context, _ string) (playbackMedia, error) {
		return playbackMedia{Container: "mp4", VideoCodec: "h264", AudioCodec: "aac", Width: 1920, Height: 1080}, nil
	}
	defer func() { probePlaybackMedia = old }()

	body := `{"library_id":"lib","path":"sample.mp4","quality":"auto","client":{"mp4":true,"h264":true,"aac":true,"mse":true}}`
	req := httptest.NewRequest("POST", "/api/media/playback/plan", strings.NewReader(body))
	w := httptest.NewRecorder()
	a.playbackPlan(w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var got playbackPlan
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Mode != "direct" || !strings.Contains(got.URL, "/api/media/file?") {
		t.Fatalf("unexpected plan %+v", got)
	}

	bad := httptest.NewRequest("POST", "/api/media/playback/plan", strings.NewReader(`{"library_id":"lib","path":"../escape.mp4","client":{}}`))
	bw := httptest.NewRecorder()
	a.playbackPlan(bw, bad)
	if bw.Code != 404 {
		t.Fatalf("unsafe path status=%d body=%s", bw.Code, bw.Body.String())
	}
}

func TestPlaybackSessionLifecycle(t *testing.T) {
	oldSession := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { managerSessionOK = oldSession }()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "movie.mkv"), []byte("fixture"), 0644); err != nil {
		t.Fatal(err)
	}
	a := &App{libs: []Library{{ID: "lib", Path: dir}}, tasks: map[string]context.CancelFunc{}, playbackSessions: map[string]playbackSession{}}
	create := httptest.NewRequest("POST", "/api/media/playback/sessions", strings.NewReader(`{"library_id":"lib","path":"movie.mkv","mode":"remux"}`))
	cw := httptest.NewRecorder()
	a.playbackSessionsHandler(cw, create)
	if cw.Code != 200 {
		t.Fatalf("create status=%d body=%s", cw.Code, cw.Body.String())
	}
	var s playbackSession
	if err := json.Unmarshal(cw.Body.Bytes(), &s); err != nil {
		t.Fatal(err)
	}
	if s.ID == "" || s.State != "playing" {
		t.Fatalf("bad session %+v", s)
	}

	progress := httptest.NewRequest("POST", "/api/media/playback/sessions/"+s.ID+"/progress", strings.NewReader(`{"position_ms":12345,"duration_ms":90000,"state":"paused"}`))
	pw := httptest.NewRecorder()
	a.playbackSessionAction(pw, progress)
	if pw.Code != 200 {
		t.Fatalf("progress status=%d body=%s", pw.Code, pw.Body.String())
	}
	if got := a.playbackSessions[s.ID]; got.PositionMS != 12345 || got.State != "paused" {
		t.Fatalf("progress not stored %+v", got)
	}

	stop := httptest.NewRequest("POST", "/api/media/playback/sessions/"+s.ID+"/stop", nil)
	sw := httptest.NewRecorder()
	a.playbackSessionAction(sw, stop)
	if sw.Code != 200 {
		t.Fatalf("stop status=%d", sw.Code)
	}
	if _, ok := a.playbackSessions[s.ID]; ok {
		t.Fatal("session not removed")
	}
}
