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

// audioCacheScanCap 允许为跳过「磁盘已变化」的过期行多扫一批，
// 但仍有硬上限，避免整库过期时一次请求扫全表。
func audioCacheScanCap(limit int) int {
	n := limit * 2
	if n < 64 {
		n = 64
	}
	if n > 100000 {
		n = 100000
	}
	return n
}

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
  status        TEXT NOT NULL DEFAULT '',
  error_code    TEXT NOT NULL DEFAULT '',
  query_title   TEXT NOT NULL DEFAULT '',
  query_artist  TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT 'AUTO',
  source        TEXT NOT NULL DEFAULT 'auto',
  lock_title    INTEGER NOT NULL DEFAULT 0,
  lock_artist   INTEGER NOT NULL DEFAULT 0,
  lock_album    INTEGER NOT NULL DEFAULT 0,
  lock_cover    INTEGER NOT NULL DEFAULT 0,
  lock_lyrics   INTEGER NOT NULL DEFAULT 0,
  persisted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(lib, path)
);`)
	if err != nil {
		return err
	}
	/* 旧库在线迁移：SQLite 不支持 ADD COLUMN IF NOT EXISTS，重复列错误可忽略。 */
	for _, ddl := range []string{
		`ALTER TABLE audio_metadata ADD COLUMN status TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE audio_metadata ADD COLUMN error_code TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE audio_metadata ADD COLUMN query_title TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE audio_metadata ADD COLUMN query_artist TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE audio_metadata ADD COLUMN country TEXT NOT NULL DEFAULT 'AUTO'`,
		`ALTER TABLE audio_metadata ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'`,
		`ALTER TABLE audio_metadata ADD COLUMN lock_title INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE audio_metadata ADD COLUMN lock_artist INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE audio_metadata ADD COLUMN lock_album INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE audio_metadata ADD COLUMN lock_cover INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE audio_metadata ADD COLUMN lock_lyrics INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE audio_metadata ADD COLUMN persisted INTEGER NOT NULL DEFAULT 0`,
	} {
		_, _ = a.db.Exec(ddl)
	}
	return nil
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
	Status       string `json:"status,omitempty"`
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
	Persisted    bool   `json:"persisted"`
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
		/* v0.9.69：整库 GET 不分页，2k 曲目一次数 MB。在 **SQL 侧** 加 ORDER BY + LIMIT，
		   而不是只裁剪响应体 —— 审查指出后者不会减少 DB 扫描与内存占用，且批次不确定。
		   多取一行用于判定 truncated。 */
		limit := 5000
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 50000 {
				limit = n
			}
		}
		/* v0.9.72：新鲜度以磁盘真实 size/mtime 为准（索引表可能落后于磁盘），
		   索引里查不到的（如刚加入还没扫描完）仍返回，交由前端决定是否重刮。
		   NULL 列统一 coalesce 成空串/0：否则 Scan 失败会被静默丢弃，
		   表现为「缓存里明明有记录却读不到」。 */
		rows, err := a.db.Query(`
SELECT m.path, coalesce(m.title,''), coalesce(m.artist,''), coalesce(m.album,''), coalesce(m.cover,''),
       coalesce(m.lyrics,''), coalesce(m.lyrics_source,''), coalesce(m.provider,''), m.checked_at,
       m.status, m.error_code, m.query_title, m.query_artist, m.country, m.source,
       m.lock_title, m.lock_artist, m.lock_album, m.lock_cover, m.lock_lyrics, m.persisted,
       m.size, m.mtime
FROM audio_metadata m
LEFT JOIN files f ON f.lib = m.lib AND f.path = m.path
WHERE m.lib = ?
ORDER BY m.path LIMIT ?`, l.ID, audioCacheScanCap(limit))
		if err != nil {
			errJSON(w, 500, "audio cache read failed")
			return
		}
		defer rows.Close()
		truncated := false
		items := map[string]audioCacheEntry{}
		scanned := 0
		scanErrs := 0
		for rows.Next() {
			var e audioCacheEntry
			var size, mtime int64
			if err := rows.Scan(&e.Path, &e.Title, &e.Artist, &e.Album, &e.Cover, &e.Lyrics, &e.LyricsSource, &e.Provider, &e.CheckedAt,
				&e.Status, &e.ErrorCode, &e.QueryTitle, &e.QueryArtist, &e.Country, &e.Source,
				&e.LockTitle, &e.LockArtist, &e.LockAlbum, &e.LockCover, &e.LockLyrics, &e.Persisted,
				&size, &mtime); err != nil {
				scanErrs++
				continue
			}
			if scanned >= audioCacheScanCap(limit) {
				/* 扫描上限内的行都用完了，剩余条目本次不返回。 */
				truncated = true
				break
			}
			scanned++
			/* 磁盘上已变化/已消失的条目视为过期，不返回，前端会按未命中重新刮削。 */
			if !a.audioFileUnchanged(l, e.Path, size, mtime) {
				continue
			}
			if len(items) >= limit {
				truncated = true
				break
			}
			items[e.Path] = e
		}
		writeJSON(w, 200, map[string]any{"id": l.ID, "items": items, "count": len(items), "truncated": truncated, "limit": limit, "scan_errors": scanErrs})
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
		/* 兼容旧写入口，但不得用 REPLACE 清空 v0.9.72 新增的查询参数、字段锁和真实状态。 */
		_, err = a.db.Exec(`INSERT INTO audio_metadata
(lib, path, size, mtime, title, artist, album, cover, lyrics, lyrics_source, provider, checked_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(lib,path) DO UPDATE SET
size=excluded.size, mtime=excluded.mtime, title=excluded.title, artist=excluded.artist,
album=excluded.album, cover=excluded.cover, lyrics=excluded.lyrics,
lyrics_source=excluded.lyrics_source, provider=excluded.provider, checked_at=excluded.checked_at`,
			l.ID, in.Path, fi.Size(), fi.ModTime().Unix(),
			in.Title, in.Artist, in.Album, in.Cover, in.Lyrics, in.LyricsSource, in.Provider, time.Now().Unix())
		if err != nil {
			errJSON(w, 500, "audio cache write failed")
			return
		}
		invalidateAudioScrapeStatus(l.ID)
		writeJSON(w, 200, map[string]any{"ok": true, "path": in.Path, "stored": true})
	case http.MethodDelete:
		if !writeAuth(r) {
			errJSON(w, 401, "login required")
			return
		}
		/* 审查建议：不带 path 即清空整库过于隐晦，要求显式 ?all=1 防误删。 */
		if path := r.URL.Query().Get("path"); path != "" {
			_, _ = a.db.Exec(`DELETE FROM audio_metadata WHERE lib=? AND path=?`, l.ID, path)
		} else if r.URL.Query().Get("all") == "1" {
			_, _ = a.db.Exec(`DELETE FROM audio_metadata WHERE lib=?`, l.ID)
		} else {
			errJSON(w, 400, "path or all=1 required")
			return
		}
		invalidateAudioScrapeStatus(l.ID)
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
		"available":      true,
		"entries":        rows,
		"with_lyrics":    withLyrics,
		"lyrics_bytes":   bytes,
		"netease":        a.neteaseLyricsEnabled(),
		"lyrics_sources": []string{"local-lrc", "local-id3", "local-vorbis", "local-mp4", "LRCLIB", "lyrics.ovh", "NetEase"},
	})
}

var _ = strconv.Itoa
