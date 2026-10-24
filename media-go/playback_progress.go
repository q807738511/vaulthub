package main

// v1.0.7 播放进度持久化（「继续观看」）。
//
// 背景（ROUTE_INVENTORY §4.2）：playback session 的 position_ms 只存在内存里，
// 2 分钟无心跳即回收，跨设备/重启后的断点续播没有落点。阅读进度早在 v0.9.30
// 就持久化了（reading_progress.go），本文件复用同一存储模式：
//   - 单 JSON 文件（默认 /data/media-playback-progress.json），键 "<libID>\n<相对路径>"
//   - configMu 串行化读写，写入即落盘
//   - 与 readingProgress 相同的包含性校验（safeFile），防 id+path 组合越权写别的键
//
// 契约（docs/api/openapi.yaml /api/media/playback/progress）：
//   GET    ?id=<lib>            → {"id": lib, "items": {path: entry}}
//   PUT    ?id=<lib>&path=<rel>  → 写入单条（position_ms 0..duration_ms 钳制；completed 自动推断）
//   DELETE ?id=<lib>&path=<rel>  → 幂等删除 {"ok","id","path","removed"}
//
// 与内存 playback session 的关系：互不替代。会话仍管转码任务生命周期；本端点
// 只回答「这台设备的用户上次看到哪」，APP/WebUI 在 progress 心跳里顺手 PUT 一份。

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// playbackProgressEntry is one persisted playback position.
type playbackProgressEntry struct {
	PositionMS int64 `json:"position_ms"`
	DurationMS int64 `json:"duration_ms"`
	/* Completed 由服务端推断：时长已知且 position ≥ 95% 视为看完；
	   显式传 true/false 亦可（看完的条目前端可从「继续观看」里过滤掉）。 */
	Completed bool  `json:"completed"`
	UpdatedAt int64 `json:"updated_at"`
}

func (a *App) playbackProgressPath() string {
	return env("MEDIA_PLAYBACK_PROGRESS", "/data/media-playback-progress.json")
}

func (a *App) loadPlaybackProgress() (map[string]playbackProgressEntry, error) {
	out := map[string]playbackProgressEntry{}
	b, err := os.ReadFile(a.playbackProgressPath())
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &out); err != nil {
		// 与 readingProgress 一致：坏文件不静默吞，让调用方 500 并在日志里暴露。
		return nil, err
	}
	return out, nil
}

func (a *App) savePlaybackProgressStore(all map[string]playbackProgressEntry) error {
	store := a.playbackProgressPath()
	if store == "" {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(filepath.Dir(store), 0755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	tmp := store + ".tmp"
	if err := os.WriteFile(tmp, b, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, store)
}

func (a *App) playbackProgress(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	lib, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}

	switch r.Method {
	case http.MethodGet:
		a.configMu.Lock()
		all, err := a.loadPlaybackProgress()
		a.configMu.Unlock()
		if err != nil {
			errJSON(w, 500, "playback progress store is invalid")
			return
		}
		prefix := lib.ID + "\n"
		items := map[string]playbackProgressEntry{}
		for key, entry := range all {
			if hasPrefix := len(key) > len(prefix) && key[:len(prefix)] == prefix; hasPrefix {
				items[key[len(prefix):]] = entry
			}
		}
		writeJSON(w, 200, map[string]any{"id": lib.ID, "items": items})

	case http.MethodPut, http.MethodPost:
		mediaPath := r.URL.Query().Get("path")
		// 与 readingProgress PUT 相同的包含性校验：库 ID + 相对路径 + 媒体根包含 + 文件存在。
		if _, _, err := safeFile(lib, mediaPath); err != nil {
			errJSON(w, 404, "invalid media path")
			return
		}
		var in playbackProgressEntry
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&in); err != nil {
			errJSON(w, 400, "invalid playback progress")
			return
		}
		if in.PositionMS < 0 || in.DurationMS < 0 {
			errJSON(w, 400, "invalid playback progress")
			return
		}
		// 时长已知时钳制 position，并推断完成态（≥95%）；时长未知时保留显式 completed。
		if in.DurationMS > 0 {
			if in.PositionMS > in.DurationMS {
				in.PositionMS = in.DurationMS
			}
			if !in.Completed {
				in.Completed = float64(in.PositionMS) >= 0.95*float64(in.DurationMS)
			}
		}
		in.UpdatedAt = time.Now().Unix()
		a.configMu.Lock()
		defer a.configMu.Unlock()
		all, err := a.loadPlaybackProgress()
		if err != nil {
			errJSON(w, 500, "playback progress store is invalid")
			return
		}
		all[overrideKey(lib.ID, mediaPath)] = in
		if err := a.savePlaybackProgressStore(all); err != nil {
			errJSON(w, 500, "playback progress save failed")
			return
		}
		writeJSON(w, 200, in)

	case http.MethodDelete:
		mediaPath := r.URL.Query().Get("path")
		if _, _, err := safeFile(lib, mediaPath); err != nil {
			errJSON(w, 404, "invalid media path")
			return
		}
		a.configMu.Lock()
		defer a.configMu.Unlock()
		all, err := a.loadPlaybackProgress()
		if err != nil {
			errJSON(w, 500, "playback progress store is invalid")
			return
		}
		key := overrideKey(lib.ID, mediaPath)
		if _, exists := all[key]; !exists {
			writeJSON(w, 200, map[string]any{"ok": true, "id": lib.ID, "path": mediaPath, "removed": false})
			return
		}
		delete(all, key)
		if err := a.savePlaybackProgressStore(all); err != nil {
			errJSON(w, 500, "playback progress save failed")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "id": lib.ID, "path": mediaPath, "removed": true})

	default:
		errJSON(w, 405, "method not allowed")
	}
}
