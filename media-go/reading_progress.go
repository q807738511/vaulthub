package main

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// readingProgressEntry is one persisted reading position.
//
// v0.9.30: reading progress used to live only in localStorage, so closing a
// comic/ebook and reopening it later (other browser, cleared cache, another
// device) always restarted at page one. The manager session already gates every
// other write, so the same guard applies here.
type readingProgressEntry struct {
	Progress  float64 `json:"progress"`
	/* v0.9.67：漫画阅读器改为「按页码」记录（百分比在页数变化/不同字号下会漂移）。
	   Page/Total 为首选，Progress 仍保留写入以便书架卡片沿用百分比展示。 */
	Page      int   `json:"page,omitempty"`
	Total     int   `json:"total,omitempty"`
	UpdatedAt int64 `json:"updated_at,omitempty"`
}

func (a *App) readingProgressPath() string {
	return env("MEDIA_READING_PROGRESS", "/data/media-reading-progress.json")
}

func (a *App) loadReadingProgress() (map[string]readingProgressEntry, error) {
	out := map[string]readingProgressEntry{}
	b, err := os.ReadFile(a.readingProgressPath())
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (a *App) saveReadingProgressStore(all map[string]readingProgressEntry) error {
	store := a.readingProgressPath()
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
	f, err := os.CreateTemp(filepath.Dir(store), ".reading-progress-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Chmod(tmp, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, store); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(store))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// readingProgress serves GET (whole library), PUT (one media path) and
// DELETE (release one media path from the reading history).
//
// GET    /api/media/reading/progress?id=<lib>
// PUT    /api/media/reading/progress?id=<lib>&path=<rel>   {"progress": 42.5}
// DELETE /api/media/reading/progress?id=<lib>&path=<rel>
//
// v0.9.73: before this, a finished book could never leave 「历史阅读」 — the store
// only ever gained entries, so the shelf kept counting it as read even after the
// user asked to release it. DELETE removes the entry outright (rather than
// writing progress 0, which would leave a zero-progress row behind and made the
// release look like it had not happened).
func (a *App) readingProgress(w http.ResponseWriter, r *http.Request) {
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
		all, err := a.loadReadingProgress()
		a.configMu.Unlock()
		if err != nil {
			errJSON(w, 500, "reading progress store is invalid")
			return
		}
		prefix := lib.ID + "\n"
		items := map[string]readingProgressEntry{}
		for key, entry := range all {
			if strings.HasPrefix(key, prefix) {
				items[strings.TrimPrefix(key, prefix)] = entry
			}
		}
		writeJSON(w, 200, map[string]any{"id": lib.ID, "items": items})
	case http.MethodPut, http.MethodPost:
		mediaPath := r.URL.Query().Get("path")
		// The same containment rules as playback: library ID + relative path +
		// EvalSymlinks + media-root containment + file existence.
		if _, _, err := safeFile(lib, mediaPath); err != nil {
			errJSON(w, 404, "invalid media path")
			return
		}
		var in readingProgressEntry
		if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&in); err != nil {
			errJSON(w, 400, "invalid reading progress")
			return
		}
		if math.IsNaN(in.Progress) || math.IsInf(in.Progress, 0) {
			errJSON(w, 400, "invalid reading progress")
			return
		}
		in.Progress = math.Max(0, math.Min(100, in.Progress))
		/* v0.9.67：页码同样做边界钳制与合法性校验，避免脏值写进进度库。 */
		if in.Total < 0 || in.Total > 100000 || in.Page < 0 || in.Page > 100000 {
			errJSON(w, 400, "invalid reading progress")
			return
		}
		if in.Total > 0 && in.Page > in.Total {
			in.Page = in.Total
		}
		in.UpdatedAt = time.Now().Unix()
		a.configMu.Lock()
		defer a.configMu.Unlock()
		all, err := a.loadReadingProgress()
		if err != nil {
			errJSON(w, 500, "reading progress store is invalid")
			return
		}
		all[overrideKey(lib.ID, mediaPath)] = in
		if err := a.saveReadingProgressStore(all); err != nil {
			errJSON(w, 500, "reading progress save failed")
			return
		}
		writeJSON(w, 200, in)
	case http.MethodDelete:
		/* v0.9.73：「释放」= 从阅读历史里真正删除该条目（用户诉求：已读收藏可释放）。
		   路径校验沿用与 PUT 相同的包含性检查，避免用 id+path 组合删掉别的键。 */
		mediaPath := r.URL.Query().Get("path")
		if _, _, err := safeFile(lib, mediaPath); err != nil {
			errJSON(w, 404, "invalid media path")
			return
		}
		a.configMu.Lock()
		defer a.configMu.Unlock()
		all, err := a.loadReadingProgress()
		if err != nil {
			errJSON(w, 500, "reading progress store is invalid")
			return
		}
		key := overrideKey(lib.ID, mediaPath)
		if _, exists := all[key]; !exists {
			/* 幂等：重复释放不算错误，但要如实回报「这次没有条目被删除」。 */
			writeJSON(w, 200, map[string]any{"ok": true, "id": lib.ID, "path": mediaPath, "removed": false})
			return
		}
		delete(all, key)
		if err := a.saveReadingProgressStore(all); err != nil {
			errJSON(w, 500, "reading progress save failed")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "id": lib.ID, "path": mediaPath, "removed": true})
	default:
		errJSON(w, 405, "method not allowed")
	}
}
