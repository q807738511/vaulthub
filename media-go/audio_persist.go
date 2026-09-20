package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// v0.9.72: 音频刮削的权威状态和同目录结构化 sidecar。
// sidecar 只保存文本参数/来源，不改写原始音频标签，避免损坏媒体文件。
type audioPersistedMetadata struct {
	Schema       int    `json:"schema"`
	GeneratedBy  string `json:"generated_by"`
	Title        string `json:"title,omitempty"`
	Artist       string `json:"artist,omitempty"`
	Album        string `json:"album,omitempty"`
	Cover        string `json:"cover,omitempty"`
	Lyrics       string `json:"lyrics,omitempty"`
	LyricsSource string `json:"lyrics_source,omitempty"`
	Provider     string `json:"provider,omitempty"`
	Status       string `json:"status"`
	ErrorCode    string `json:"error_code,omitempty"`
	QueryTitle   string `json:"query_title,omitempty"`
	QueryArtist  string `json:"query_artist,omitempty"`
	Country      string `json:"country,omitempty"`
	Source       string `json:"source,omitempty"`
	LockTitle    bool   `json:"lock_title,omitempty"`
	LockArtist   bool   `json:"lock_artist,omitempty"`
	LockAlbum    bool   `json:"lock_album,omitempty"`
	LockCover    bool   `json:"lock_cover,omitempty"`
	LockLyrics   bool   `json:"lock_lyrics,omitempty"`
	CheckedAt    int64  `json:"checked_at"`
}

func audioMetadataSidecar(abs string) string {
	stem := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	return filepath.Join(filepath.Dir(abs), stem+".vaulthub.json")
}

func validAudioScrapeState(v string) bool {
	switch v {
	case "pending", "running", "succeeded", "not_found", "failed", "manual", "local":
		return true
	}
	return false
}

func validAudioCountry(v string) bool {
	switch strings.ToUpper(strings.TrimSpace(v)) {
	case "", "AUTO", "TW", "JP", "US", "HK":
		return true
	}
	return false
}

func boundedAudioText(v string, max int) (string, bool) {
	v = strings.TrimSpace(v)
	if len(v) > max || strings.IndexByte(v, 0) >= 0 {
		return "", false
	}
	return v, true
}

var audioSidecarLocks sync.Map

func audioSidecarLock(path string) *sync.Mutex {
	lock, _ := audioSidecarLocks.LoadOrStore(path, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func writeAudioMetadataSidecar(abs string, in audioPersistedMetadata) (string, error) {
	if !isAudioMediaPath(abs) {
		return "", errors.New("not audio")
	}
	final := audioMetadataSidecar(abs)
	lock := audioSidecarLock(final)
	lock.Lock()
	defer lock.Unlock()
	if fi, err := os.Lstat(final); err == nil {
		if fi.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("sidecar symlink refused")
		}
		// 只覆盖 VaultHub 自己生成的 JSON；用户自建同名文件不碰。
		old, readErr := os.ReadFile(final)
		var marker struct {
			GeneratedBy string `json:"generated_by"`
		}
		if readErr != nil || json.Unmarshal(old, &marker) != nil || marker.GeneratedBy != "VaultHub" {
			return "", errors.New("sidecar owned by user")
		}
	}
	in.Schema, in.GeneratedBy = 1, "VaultHub"
	if in.CheckedAt == 0 {
		in.CheckedAt = time.Now().Unix()
	}
	data, err := json.MarshalIndent(in, "", "  ")
	if err != nil || len(data) > 256*1024 {
		return "", errors.New("metadata too large")
	}
	data = append(data, '\n')
	f, err := os.CreateTemp(filepath.Dir(abs), ".vaulthub-meta-*.tmp")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0o644); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, final)
	}
	if err != nil {
		return "", err
	}
	if dir, openErr := os.Open(filepath.Dir(final)); openErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return final, nil
}

// audioFileUnchanged 以磁盘真实状态为准判断缓存是否仍然有效。
// 索引表可能落后于磁盘（用户重新打标签/替换文件后未重扫），因此这里 stat 实际文件：
// 路径不安全、文件消失或 size/mtime 变化一律视为过期，避免旧刮削结果冒充完成。
func (a *App) audioFileUnchanged(l Library, path string, size, mtime int64) bool {
	abs, _, err := safeFile(l, path)
	if err != nil {
		return false
	}
	fi, err := os.Stat(abs)
	if err != nil || fi.IsDir() {
		return false
	}
	return fi.Size() == size && fi.ModTime().Unix() == mtime
}

const audioScrapeStatusMaxRows = 20000

/*
首页每 5 秒轮询一次状态，而状态要逐首 stat 比对磁盘：用 10 秒进程内快照，

	把每库的扫描合并成最多每 10 秒一次；元数据写入/删除立即失效，保证刚校正完
	就能读到真实结果。
*/
// TTL 用变量而非常量，便于测试注入更短的窗口。
var audioScrapeStatusTTL = 10 * time.Second

type audioScrapeStatusSnapshot struct {
	total    int
	complete int
	counts   map[string]int
	expires  time.Time
}

var audioScrapeStatusCache sync.Map

func invalidateAudioScrapeStatus(lib string) {
	if lib == "" {
		return
	}
	audioScrapeStatusCache.Delete(lib)
}

func audioScrapeStatusPayload(id string, total, complete int, counts map[string]int) map[string]any {
	out := make(map[string]int, len(counts))
	for k, v := range counts {
		out[k] = v
	}
	return map[string]any{"id": id, "tracked": true, "total": total, "complete": complete, "counts": out, "updated_at": time.Now().Unix()}
}

// audioScrapeStatus 返回服务端真实记录，不把文件名回退算作成功。
func (a *App) audioScrapeStatus(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, http.StatusNotFound, "library not found")
		return
	}
	if l.Type != "audio" {
		writeJSON(w, 200, map[string]any{"id": l.ID, "tracked": false, "state": "not_applicable"})
		return
	}
	if err := a.ensureAudioCacheTable(); err != nil {
		errJSON(w, 500, "audio cache unavailable")
		return
	}
	/* 状态要逐首比对磁盘 size/mtime，而首页每 5 秒轮询一次；用 10 秒进程内快照
	   把每库的 stat 扫描合并成最多每 10 秒一次，任何写入都会立即让快照失效。 */
	if snap, ok := audioScrapeStatusCache.Load(l.ID); ok {
		if s, valid := snap.(audioScrapeStatusSnapshot); valid && time.Now().Before(s.expires) {
			writeJSON(w, 200, audioScrapeStatusPayload(l.ID, s.total, s.complete, s.counts))
			return
		}
	}
	var total int
	_ = a.db.QueryRow(`SELECT count(*) FROM files WHERE lib=?`, l.ID).Scan(&total)
	counts := map[string]int{"pending": total, "running": 0, "succeeded": 0, "not_found": 0, "failed": 0, "manual": 0, "local": 0}
	/* 只统计「仍在索引里」且「磁盘上 size/mtime 未变」的条目：
	   已删除、已替换或重新打标签的文件，其旧抓取结果不能虚增完成数。 */
	rows, err := a.db.Query(`SELECT m.path, m.size, m.mtime, coalesce(nullif(m.status,''), CASE WHEN m.provider='manual' THEN 'manual' WHEN m.provider<>'' THEN 'succeeded' ELSE 'not_found' END)
FROM audio_metadata m
JOIN files f ON f.lib=m.lib AND f.path=m.path
WHERE m.lib=? LIMIT ?`, l.ID, audioScrapeStatusMaxRows)
	if err == nil {
		defer rows.Close()
		seen := 0
		for rows.Next() {
			var (
				path, state string
				size, mtime int64
			)
			if rows.Scan(&path, &size, &mtime, &state) != nil || !validAudioScrapeState(state) {
				continue
			}
			if !a.audioFileUnchanged(l, path, size, mtime) {
				continue
			}
			counts[state]++
			seen++
		}
		counts["pending"] = total - seen
		if counts["pending"] < 0 {
			counts["pending"] = 0
		}
	}
	complete := counts["succeeded"] + counts["manual"] + counts["local"]
	audioScrapeStatusCache.Store(l.ID, audioScrapeStatusSnapshot{total: total, complete: complete, counts: counts, expires: time.Now().Add(audioScrapeStatusTTL)})
	writeJSON(w, 200, audioScrapeStatusPayload(l.ID, total, complete, counts))
}

// audioMetadataCommit 是自动刮削和手工校正的统一原子入口。
func (a *App) audioMetadataCommit(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		ID   string `json:"id"`
		Path string `json:"path"`
		audioPersistedMetadata
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 512<<10)).Decode(&body); err != nil {
		errJSON(w, 400, "invalid metadata")
		return
	}
	l, ok := a.find(body.ID)
	if !ok || l.Type != "audio" {
		errJSON(w, 404, "audio library not found")
		return
	}
	abs, _, err := safeFile(l, body.Path)
	if err != nil || !isAudioMediaPath(abs) {
		errJSON(w, 404, "audio file not found")
		return
	}
	if !validAudioScrapeState(body.Status) || !validAudioCountry(body.Country) {
		errJSON(w, 400, "invalid scrape state")
		return
	}
	for _, pair := range []struct {
		p *string
		n int
	}{{&body.Title, 300}, {&body.Artist, 300}, {&body.Album, 300}, {&body.QueryTitle, 300}, {&body.QueryArtist, 300}, {&body.Provider, 80}, {&body.Source, 80}, {&body.ErrorCode, 80}} {
		v, valid := boundedAudioText(*pair.p, pair.n)
		if !valid {
			errJSON(w, 400, "metadata field too long")
			return
		}
		*pair.p = v
	}
	if len(body.Lyrics) > audioCacheLyricsLimit || len(body.Cover) > 4096 {
		errJSON(w, 400, "metadata field too long")
		return
	}
	body.Country = strings.ToUpper(strings.TrimSpace(body.Country))
	if body.Country == "" {
		body.Country = "AUTO"
	}
	body.CheckedAt = time.Now().Unix()
	persistedPath, persistErr := writeAudioMetadataSidecar(abs, body.audioPersistedMetadata)
	lyricsPersisted := false
	if body.LockLyrics && strings.TrimSpace(body.Lyrics) != "" {
		_, lyricsPersisted = writeLyricsSidecar(abs, body.Lyrics)
	}
	fi, statErr := os.Stat(abs)
	if statErr != nil || a.ensureAudioCacheTable() != nil {
		errJSON(w, 500, "audio cache unavailable")
		return
	}
	_, err = a.db.Exec(`INSERT OR REPLACE INTO audio_metadata
(lib,path,size,mtime,title,artist,album,cover,lyrics,lyrics_source,provider,checked_at,status,error_code,query_title,query_artist,country,source,lock_title,lock_artist,lock_album,lock_cover,lock_lyrics,persisted)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, l.ID, body.Path, fi.Size(), fi.ModTime().Unix(), body.Title, body.Artist, body.Album, body.Cover, body.Lyrics, body.LyricsSource, body.Provider, body.CheckedAt, body.Status, body.ErrorCode, body.QueryTitle, body.QueryArtist, body.Country, body.Source, body.LockTitle, body.LockArtist, body.LockAlbum, body.LockCover, body.LockLyrics, persistErr == nil)
	if err != nil {
		errJSON(w, 500, "audio cache write failed")
		return
	}
	invalidateAudioScrapeStatus(l.ID)
	writeJSON(w, 200, map[string]any{"ok": true, "stored": true, "persisted": persistErr == nil, "sidecar": filepath.Base(persistedPath), "lyrics_persisted": lyricsPersisted, "persist_error": func() string {
		if persistErr != nil {
			return "directory_not_writable"
		}
		return ""
	}()})
}
