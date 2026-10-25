package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// v1.0.7：播放进度服务端持久化（「继续观看」）。测试点与 reading_progress 对齐：
// 往返、钳制/完成态推断、编辑删除、越权路径、鉴权、跨重启（文件落盘）。
func newPlaybackProgressApp(t *testing.T) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Movie.mp4"), []byte("body"), 0644); err != nil {
		t.Fatal(err)
	}
	a := &App{
		libs:              []Library{{ID: "movies", Name: "电影", Type: "movie", Path: dir}},
		metadataOverrides: filepath.Join(t.TempDir(), "overrides.json"),
	}
	t.Setenv("MEDIA_PLAYBACK_PROGRESS", filepath.Join(t.TempDir(), "playback.json"))
	return a, dir
}

func putPlaybackProgress(t *testing.T, a *App, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPut, "/api/media/playback/progress?id=movies&path="+path, bytes.NewBufferString(body))
	a.playbackProgress(w, r)
	return w
}

func getPlaybackProgress(t *testing.T, a *App) map[string]playbackProgressEntry {
	t.Helper()
	w := httptest.NewRecorder()
	a.playbackProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/playback/progress?id=movies", nil))
	if w.Code != 200 {
		t.Fatalf("GET want 200 got %d: %s", w.Code, w.Body.String())
	}
	var out struct {
		ID    string                           `json:"id"`
		Items map[string]playbackProgressEntry `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != "movies" {
		t.Fatalf("library id mismatch: %+v", out)
	}
	return out.Items
}

func TestPlaybackProgressRoundTrip(t *testing.T) {
	withManagerSession(t)
	a, _ := newPlaybackProgressApp(t)

	if w := putPlaybackProgress(t, a, "Movie.mp4", `{"position_ms":120000,"duration_ms":600000}`); w.Code != 200 {
		t.Fatalf("PUT want 200 got %d: %s", w.Code, w.Body.String())
	}
	items := getPlaybackProgress(t, a)
	entry, ok := items["Movie.mp4"]
	if !ok {
		t.Fatalf("entry missing: %+v", items)
	}
	if entry.PositionMS != 120000 || entry.DurationMS != 600000 {
		t.Fatalf("roundtrip mismatch: %+v", entry)
	}
	if entry.Completed {
		t.Fatalf("20%% should not be completed: %+v", entry)
	}
	if entry.UpdatedAt <= 0 {
		t.Fatalf("updated_at not set: %+v", entry)
	}
}

func TestPlaybackProgressClampsAndCompletes(t *testing.T) {
	withManagerSession(t)
	a, _ := newPlaybackProgressApp(t)

	// position 超出 duration → 钳到 duration，且 ≥95% 自动 completed。
	if w := putPlaybackProgress(t, a, "Movie.mp4", `{"position_ms":900000,"duration_ms":600000}`); w.Code != 200 {
		t.Fatalf("PUT want 200 got %d: %s", w.Code, w.Body.String())
	}
	entry := getPlaybackProgress(t, a)["Movie.mp4"]
	if entry.PositionMS != 600000 {
		t.Fatalf("position not clamped: %+v", entry)
	}
	if !entry.Completed {
		t.Fatalf("100%% should be completed: %+v", entry)
	}

	// 负数 → 400
	if w := putPlaybackProgress(t, a, "Movie.mp4", `{"position_ms":-1}`); w.Code != 400 {
		t.Fatalf("negative position want 400 got %d", w.Code)
	}
	// 非法 JSON → 400
	if w := putPlaybackProgress(t, a, "Movie.mp4", `{`); w.Code != 400 {
		t.Fatalf("bad json want 400 got %d", w.Code)
	}
}

func TestPlaybackProgressDeleteAndPathGuard(t *testing.T) {
	withManagerSession(t)
	a, _ := newPlaybackProgressApp(t)

	putPlaybackProgress(t, a, "Movie.mp4", `{"position_ms":1000}`)
	w := httptest.NewRecorder()
	a.playbackProgress(w, httptest.NewRequest(http.MethodDelete, "/api/media/playback/progress?id=movies&path=Movie.mp4", nil))
	if w.Code != 200 {
		t.Fatalf("DELETE want 200 got %d: %s", w.Code, w.Body.String())
	}
	var res map[string]any
	json.Unmarshal(w.Body.Bytes(), &res)
	if res["removed"] != true {
		t.Fatalf("want removed=true: %v", res)
	}
	// 幂等
	w = httptest.NewRecorder()
	a.playbackProgress(w, httptest.NewRequest(http.MethodDelete, "/api/media/playback/progress?id=movies&path=Movie.mp4", nil))
	json.Unmarshal(w.Body.Bytes(), &res)
	if res["removed"] != false {
		t.Fatalf("second delete want removed=false: %v", res)
	}
	// 越界路径 → 404
	if w := putPlaybackProgress(t, a, "../etc/passwd", `{"position_ms":1}`); w.Code != 404 {
		t.Fatalf("traversal want 404 got %d", w.Code)
	}
	// 不存在的库 → 404
	w = httptest.NewRecorder()
	a.playbackProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/playback/progress?id=nope", nil))
	if w.Code != 404 {
		t.Fatalf("unknown library want 404 got %d", w.Code)
	}
}

func TestPlaybackProgressRequiresSession(t *testing.T) {
	a, _ := newPlaybackProgressApp(t) // 未装 manager 桩：readAuth/writeAuth 应失败
	w := httptest.NewRecorder()
	a.playbackProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/playback/progress?id=movies", nil))
	if w.Code != 401 {
		t.Fatalf("no session want 401 got %d: %s", w.Code, w.Body.String())
	}
}

func TestPlaybackProgressPersistsAcrossInstances(t *testing.T) {
	withManagerSession(t)
	a, _ := newPlaybackProgressApp(t)
	putPlaybackProgress(t, a, "Movie.mp4", `{"position_ms":42000,"duration_ms":600000}`)

	// 新实例（模拟容器重启）读同一个文件，应看到条目。
	a2 := &App{libs: a.libs, metadataOverrides: a.metadataOverrides}
	entry, ok := getPlaybackProgress(t, a2)["Movie.mp4"]
	if !ok || entry.PositionMS != 42000 {
		t.Fatalf("progress not persisted across instances: %+v", entry)
	}
}
