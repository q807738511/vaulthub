package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

/* v0.9.67：音乐元数据/歌词的服务端持久缓存。
 *
 * 用户诉求（2026-09）：「刮削后有必要独立做媒体库写入来进行缓存数据，预备下次读取」。
 * 现状问题：元数据与歌词此前只存在浏览器 localStorage —— 换浏览器/清缓存即全丢，
 * 每次重新打开音乐库都要逐首联网刮削（上千首要几分钟，还容易触发公开 API 限流）。
 *
 * 设计：
 *   - 复用项目已有的 modernc.org/sqlite（无新依赖），主键 (lib, path)；
 *   - 失效判定绑定文件 size+mtime：写入时服务端 stat 记录，读取时 JOIN 索引表 files
 *     （同样记录 size/mtime）比对，不一致即视为过期不返回 → 文件一改自动重刮，
 *     也天然避免「歌曲被替换后读到旧元数据」；
 *   - 一次请求返回整库缓存，前端启动毫秒级拿全量，只对未命中项发刮削请求；
 *   - 歌词单条上限 64KB，避免异常内容把库撑爆。
 */

const audioCacheLyricsLimit = 64 * 1024

func (a *App) ensureAudioCacheTable() error {
	if a.db == nil {
		return os.ErrInvalid
	}
	_, err := a.db.Exec(`CREATE TABLE IF NOT EXISTS audio_metadata(
  lib           TEXT NOT NULL,
  path          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  title         TEXT,
  artist        TEXT,
  album         TEXT,
  cover         TEXT,
  lyrics        TEXT,
  lyrics_source TEXT,
  provider      TEXT,
  checked_at    INTEGER NOT NULL,
  PRIMARY KEY(lib, path)
);`)
	return err
}

type audioCacheEntry struct {
	Path         string `json:"path"`
	Title        string `json:"title,omitempty"`
	Artist       string `json:"artist,omitempty"`
	Album        string `json:"album,omitempty"`
	Cover        string `json:"cover,omitempty"`
	Lyrics       string `json:"lyrics,omitempty"`
	LyricsSource string `json:"lyrics_source,omitempty"`
	Provider     string `json:"provider,omitempty"`
	CheckedAt    int64  `json:"checked_at,omitempty"`
}

func (a *App) audioCache(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	if err := a.ensureAudioCacheTable(); err != nil {
		errJSON(w, 500, "audio cache unavailable")
		return
	}
	switch r.Method {
	case http.MethodGet:
		/* LEFT JOIN：仍在索引里且 size/mtime 一致的条目才算新鲜；
		   索引里查不到的（如刚加入还没扫描完）也返回，交由前端决定是否重刮。 */
		rows, err := a.db.Query(`
SELECT m.path, m.title, m.artist, m.album, m.cover, m.lyrics, m.lyrics_source, m.provider, m.checked_at
FROM audio_metadata m
LEFT JOIN files f ON f.lib = m.lib AND f.path = m.path
WHERE m.lib = ? AND (f.size IS NULL OR (f.size = m.size AND f.mtime = m.mtime))`, l.ID)
		if err != nil {
			errJSON(w, 500, "audio cache read failed")
			return
		}
		defer rows.Close()
		items := map[string]audioCacheEntry{}
		for rows.Next() {
			var e audioCacheEntry
			if err := rows.Scan(&e.Path, &e.Title, &e.Artist, &e.Album, &e.Cover, &e.Lyrics, &e.LyricsSource, &e.Provider, &e.CheckedAt); err != nil {
				continue
			}
			items[e.Path] = e
		}
		writeJSON(w, 200, map[string]any{"id": l.ID, "items": items, "count": len(items)})
	case http.MethodPut, http.MethodPost:
		if !writeAuth(r) {
			errJSON(w, 401, "login required")
			return
		}
		var in audioCacheEntry
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
			errJSON(w, 400, "invalid audio cache entry")
			return
		}
		if len(in.Lyrics) > audioCacheLyricsLimit {
			in.Lyrics = in.Lyrics[:audioCacheLyricsLimit]
		}
		abs, _, err := safeFile(l, in.Path)
		if err != nil {
			errJSON(w, 404, "file not found")
			return
		}
		fi, err := os.Stat(abs)
		if err != nil {
			errJSON(w, 404, "file not found")
			return
		}
		_, err = a.db.Exec(`INSERT OR REPLACE INTO audio_metadata
(lib, path, size, mtime, title, artist, album, cover, lyrics, lyrics_source, provider, checked_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			l.ID, in.Path, fi.Size(), fi.ModTime().Unix(),
			in.Title, in.Artist, in.Album, in.Cover, in.Lyrics, in.LyricsSource, in.Provider, time.Now().Unix())
		if err != nil {
			errJSON(w, 500, "audio cache write failed")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": in.Path, "stored": true})
	case http.MethodDelete:
		if !writeAuth(r) {
			errJSON(w, 401, "login required")
			return
		}
		if path := r.URL.Query().Get("path"); path != "" {
			_, _ = a.db.Exec(`DELETE FROM audio_metadata WHERE lib=? AND path=?`, l.ID, path)
		} else {
			_, _ = a.db.Exec(`DELETE FROM audio_metadata WHERE lib=?`, l.ID)
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		errJSON(w, 405, "method not allowed")
	}
}

// audioCacheStats 供「系统信息」类页面查看缓存规模。
func (a *App) audioCacheStats(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if err := a.ensureAudioCacheTable(); err != nil {
		writeJSON(w, 200, map[string]any{"available": false})
		return
	}
	var rows, withLyrics int
	var bytes int64
	_ = a.db.QueryRow(`SELECT count(*), coalesce(sum(length(coalesce(lyrics,''))),0) FROM audio_metadata`).Scan(&rows, &bytes)
	_ = a.db.QueryRow(`SELECT count(*) FROM audio_metadata WHERE coalesce(lyrics,'') <> ''`).Scan(&withLyrics)
	writeJSON(w, 200, map[string]any{
		"available":   true,
		"entries":     rows,
		"with_lyrics": withLyrics,
		"lyrics_bytes": bytes,
		"netease":     a.neteaseLyricsEnabled(),
		"lyrics_sources": []string{"local-lrc", "local-id3", "local-vorbis", "local-mp4", "LRCLIB", "lyrics.ovh", "NetEase"},
	})
}

var _ = strconv.Itoa
