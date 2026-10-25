package main

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
	"time"
)

/* ==================== v0.9.88：刮削结果服务端持久化 ====================
客户要求：「影视及音乐及电子书籍刮削，完成刮削后优先将刮削信息返回到服务器内部
进行持久化保存，防止出现多次批量重复读取的操作从而影响体验」。

现状与缺口：
  · 音乐：v0.9.67 起已有服务端持久化（写源目录 sidecar + SQLite +
    /api/media/audio/cache），换浏览器或清缓存后进库先吃服务端缓存，不再重复联网。
  · 影视 / 电子书：刮削结果只落在浏览器 localStorage（vaulthub_movie_metadata_v1
    与封面缓存）。换浏览器、清缓存、换设备、或同库被多次批量扫描，就要把整库重新
    刮一遍 —— 每条一次 TMDB/Google/Bangumi 请求，几千条就是几千次外网请求，
    这正是「多次批量重复读取」的来源。

本文件补上影视 / 电子书这一层：一份服务端刮削结果库
（默认 /data/media-scrape-cache.json，0600），前端进库先读它、刮完再写回。
  · 读取：GET  /api/media/scrape-cache?id=<库ID>[&since=<毫秒>]
  · 写入：POST /api/media/scrape-cache   {id, items:{path:条目}, replace?:bool}
  · 清空：DELETE /api/media/scrape-cache?id=<库ID>   （重新刮削时用）

安全与边界：
  · 路径一律库内相对路径（与 /api/media/files 同一套语义）：拒绝绝对路径、".."、
    反斜杠；图片地址只接受 http(s) 或本站 /api/media/（沿用 override 的校验口径）。
  · 字段逐项限长，条目数分库与全局双重上限，防止一个被攻破的会话把磁盘写满。
  · 合并写入：同一路径只有更新的 checked_at 才能覆盖，避免旧设备的陈旧结果
    回冲新结果；replace=true 时才整条替换（手动编辑名称后重刮）。
  · 落盘 0600、临时文件 + rename、目录 fsync —— 与 runtime / override 一致。
*/

const (
	scrapeCacheVersion   = 1
	scrapeCacheMaxItems  = 50000  // 单库条目上限
	scrapeCacheMaxTotal  = 200000 // 全部库合计上限
	scrapeCacheMaxTitle  = 300
	scrapeCacheMaxDesc   = 4000
	scrapeCacheMaxSmall  = 200
	scrapeCacheMaxURLLen = 2048
	scrapeCacheMaxPath   = 1024
)

// scrapeCacheItem 是一条持久化下来的刮削结果。字段与前端 movieMetadata 的
// 子集一一对应，前端 hydrate 时直接并入本地元数据层。
type scrapeCacheItem struct {
	Title string `json:"title,omitempty"`
	/* v0.9.91：剧集刮削后的「剧名」必须一起持久化。
	   旧实现前端把 show_title 写在本地元数据层（一级标题 = 当前语言刮到的剧名），
	   但上传到服务端结果库时被字段白名单丢掉 —— 换设备 / 清缓存 / 重新进库水合后
	   show_title 变空，剧名又退回文件名解析结果，表现为「刮削后的媒体名称展示规则没生效」。 */
	ShowTitle string  `json:"show_title,omitempty"`
	Year      string  `json:"year,omitempty"`
	Poster    string  `json:"poster,omitempty"`
	Backdrop  string  `json:"backdrop,omitempty"`
	Logo      string  `json:"logo,omitempty"`
	Fanart    string  `json:"fanart,omitempty"`
	Overview  string  `json:"overview,omitempty"`
	Rating    float64 `json:"rating,omitempty"`
	Provider  string  `json:"provider,omitempty"`
	TMDBID    int64   `json:"tmdb_id,omitempty"`
	TVDBID    int64   `json:"tvdb_id,omitempty"`
	MediaType string  `json:"media_type,omitempty"`
	UserTitle string  `json:"user_title,omitempty"`
	/* v0.9.94（需求9 多季度分离刮削）：季标签刮削结果也要持久化 ——
	   季号（4）、季标签原文（幽游白书S04）、季名与季简介。
	   旧实现这几个字段只活在前端 localStorage 里，换设备/水合后季信息丢失，
	   同一部剧的不同季又退回按文件名猜，表现为「第一季刮到后其余季对不上」。 */
	SeasonNum      int    `json:"season_num,omitempty"`
	SeasonTag      string `json:"season_tag,omitempty"`
	SeasonName     string `json:"season_name,omitempty"`
	SeasonOverview string `json:"season_overview,omitempty"`
	Kind           string `json:"kind,omitempty"`         // movie / series / book / comic
	State     string  `json:"scrape_state,omitempty"` // ok / failed / skip / pending
	Reason    string  `json:"reason,omitempty"`
	CheckedAt int64   `json:"checked_at,omitempty"`
}

type scrapeCacheLibrary struct {
	Updated int64                      `json:"updated"`
	Items   map[string]scrapeCacheItem `json:"items"`
}

type scrapeCacheFile struct {
	Version   int                           `json:"version"`
	Libraries map[string]scrapeCacheLibrary `json:"libraries"`
}

// scrapeCachePathOf 解析刮削结果库的文件位置（可被 MEDIA_SCRAPE_CACHE 覆盖）。
func (a *App) scrapeCachePathOf() string {
	if a.scrapeCachePath != "" {
		return a.scrapeCachePath
	}
	return env("MEDIA_SCRAPE_CACHE", "/data/media-scrape-cache.json")
}

// cloneScrapeCacheFile 深拷贝整个结果库。
//
// v0.9.89（生产事故修复）：Go 的 map 不是并发安全的，两个请求只要有一个在写、
// 另一个在读（哪怕只是 range），运行时就抛 fatal error: concurrent map writes ——
// 这是**不可 recover** 的致命错误，会当场杀掉整个 media-api 进程，Caddy 上游
// 127.0.0.1:9100 拒连，于是全站 /api 接口全部 502（表现为「媒体库没了 / 新建报 502」）。
// 因此：共享 map 只在 scrapeCacheMu 内访问，锁外一律用副本。
func cloneScrapeCacheFile(in scrapeCacheFile) scrapeCacheFile {
	out := scrapeCacheFile{Version: in.Version, Libraries: make(map[string]scrapeCacheLibrary, len(in.Libraries))}
	for id, lib := range in.Libraries {
		items := make(map[string]scrapeCacheItem, len(lib.Items))
		for p, it := range lib.Items {
			items[p] = it
		}
		out.Libraries[id] = scrapeCacheLibrary{Updated: lib.Updated, Items: items}
	}
	return out
}

// loadScrapeCacheLocked 读盘（懒加载，只读一次）。调用者必须已持有 scrapeCacheMu。
// 文件不存在视为空库；解析失败返回错误而不是静默清空 —— 否则一次坏写会让整库
// 刮削结果消失。返回的是**共享结构**，只能在锁内使用。
func (a *App) loadScrapeCacheLocked() (scrapeCacheFile, error) {
	if a.scrapeCacheLoaded {
		return a.scrapeCache, nil
	}
	out := scrapeCacheFile{Version: scrapeCacheVersion, Libraries: map[string]scrapeCacheLibrary{}}
	b, err := os.ReadFile(a.scrapeCachePathOf())
	switch {
	case errors.Is(err, os.ErrNotExist):
		a.scrapeCache, a.scrapeCacheLoaded = out, true
		return out, nil
	case err != nil:
		return out, err
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return scrapeCacheFile{Version: scrapeCacheVersion, Libraries: map[string]scrapeCacheLibrary{}}, err
	}
	if out.Libraries == nil {
		out.Libraries = map[string]scrapeCacheLibrary{}
	}
	out.Version = scrapeCacheVersion
	a.scrapeCache, a.scrapeCacheLoaded = out, true
	return out, nil
}

// loadScrapeCache 返回深拷贝，供锁外只读使用。
func (a *App) loadScrapeCache() (scrapeCacheFile, error) {
	a.scrapeCacheMu.Lock()
	defer a.scrapeCacheMu.Unlock()
	c, err := a.loadScrapeCacheLocked()
	if err != nil {
		return c, err
	}
	return cloneScrapeCacheFile(c), nil
}

// scrapeCacheRead 在锁内取指定库的条目副本（since/limit 过滤后返回），锁外不再碰共享 map。
func (a *App) scrapeCacheRead(id string, since int64, limit int) (items map[string]scrapeCacheItem, updated int64, total int, version int, err error) {
	a.scrapeCacheMu.Lock()
	defer a.scrapeCacheMu.Unlock()
	c, err := a.loadScrapeCacheLocked()
	if err != nil {
		return nil, 0, 0, 0, err
	}
	lib := c.Libraries[id]
	out := map[string]scrapeCacheItem{}
	keys := make([]string, 0, len(lib.Items))
	for k := range lib.Items {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		it := lib.Items[k]
		if since > 0 && it.CheckedAt < since {
			continue
		}
		if limit > 0 && len(out) >= limit {
			break
		}
		out[k] = it
	}
	return out, lib.Updated, len(lib.Items), c.Version, nil
}

// scrapeCacheMerge 把「读盘 → 合并 → 落盘」整段放进同一把锁：并发 POST 不再互相踩 map，
// 也不会与 GET/DELETE 交错。replace=true 表示显式重刮（覆盖同路径旧条目）。
func (a *App) scrapeCacheMerge(id string, in map[string]scrapeCacheItem, replace bool) (stored, skipped, count int, updated int64, err error) {
	a.scrapeCacheMu.Lock()
	defer a.scrapeCacheMu.Unlock()
	cache, err := a.loadScrapeCacheLocked()
	if err != nil {
		return 0, 0, 0, 0, err
	}
	if cache.Libraries == nil {
		cache.Libraries = map[string]scrapeCacheLibrary{}
	}
	lib := cache.Libraries[id]
	if lib.Items == nil {
		lib.Items = map[string]scrapeCacheItem{}
	}
	total := 0
	for _, entry := range cache.Libraries {
		total += len(entry.Items)
	}
	for path, raw := range in {
		if !validScrapeCachePath(path) {
			skipped++
			continue
		}
		item, ok := sanitizeScrapeCacheItem(raw)
		if !ok || scrapeCacheItemEmpty(item) {
			skipped++
			continue
		}
		existing, exists := lib.Items[path]
		if exists {
			if !replace && existing.CheckedAt > item.CheckedAt {
				skipped++ // 旧设备的陈旧结果不回冲新结果
				continue
			}
			if replace {
				delete(lib.Items, path)
			}
		} else if len(lib.Items) >= scrapeCacheMaxItems || total+stored >= scrapeCacheMaxTotal {
			skipped++
			continue
		}
		lib.Items[path] = item
		stored++
	}
	lib.Updated = time.Now().UnixMilli()
	cache.Libraries[id] = lib
	if stored > 0 {
		if err := a.saveScrapeCache(cache); err != nil {
			return stored, skipped, 0, 0, err
		}
	}
	return stored, skipped, len(lib.Items), lib.Updated, nil
}

// scrapeCacheClear 清空一个库或整库，同样全程持锁。
func (a *App) scrapeCacheClear(id string, all bool) (cleared int, err error) {
	a.scrapeCacheMu.Lock()
	defer a.scrapeCacheMu.Unlock()
	cache, err := a.loadScrapeCacheLocked()
	if err != nil {
		return 0, err
	}
	if all {
		for k, entry := range cache.Libraries {
			cleared += len(entry.Items)
			delete(cache.Libraries, k)
		}
	} else {
		entry, ok := cache.Libraries[id]
		if !ok {
			return 0, nil
		}
		cleared = len(entry.Items)
		delete(cache.Libraries, id)
	}
	if err := a.saveScrapeCache(cache); err != nil {
		return 0, err
	}
	return cleared, nil
}

// saveScrapeCache 原子落盘 0600。
func (a *App) saveScrapeCache(c scrapeCacheFile) error {
	path := a.scrapeCachePathOf()
	if path == "" {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".scrape-cache-*.tmp")
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
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

/* ---------- 校验 ---------- */

// validScrapeCachePath 只接受库内相对路径（与 /api/media/files 返回的 path 同源）。
func validScrapeCachePath(p string) bool {
	if p == "" || len(p) > scrapeCacheMaxPath {
		return false
	}
	if strings.HasPrefix(p, "/") || strings.Contains(p, "\\") || strings.Contains(p, "..") {
		return false
	}
	if strings.ContainsAny(p, "\x00\n\r") {
		return false
	}
	return filepath.Clean(p) == p
}

func clipScrapeText(v string, max int) string {
	v = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, v))
	if len(v) > max {
		/* v0.9.94：按字节切会把多字节字符（中文/emoji）切成半个 —— 落盘 JSON 时
		   半个字符会被替换成 U+FFFD，季名/季标签这类新字段会显示成乱码方块。
		   这里退到合法 UTF-8 边界再裁。 */
		trimmed := v[:max]
		for len(trimmed) > 0 && !utf8.ValidString(trimmed) {
			trimmed = trimmed[:len(trimmed)-1]
		}
		v = strings.TrimSpace(trimmed)
	}
	return v
}

// validScrapeCacheURL 图片/背景地址：本站 /api/media/ 或公网 http(s)。
func validScrapeCacheURL(raw string) bool {
	if raw == "" {
		return true
	}
	if len(raw) > scrapeCacheMaxURLLen {
		return false
	}
	if strings.HasPrefix(raw, "/") {
		if !strings.HasPrefix(raw, "/api/media/") || strings.Contains(raw, "..") {
			return false
		}
		u, err := url.Parse(raw)
		return err == nil && u.Host == "" && u.Path != ""
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}

// sanitizeScrapeCacheItem 逐字段清洗；返回 false 表示整条不可信（拒收）。
func sanitizeScrapeCacheItem(in scrapeCacheItem) (scrapeCacheItem, bool) {
	out := scrapeCacheItem{
		Title:     clipScrapeText(in.Title, scrapeCacheMaxTitle),
		ShowTitle: clipScrapeText(in.ShowTitle, scrapeCacheMaxTitle),
		Year:      clipScrapeText(in.Year, 12),
		Overview:  clipScrapeText(in.Overview, scrapeCacheMaxDesc),
		Provider:  clipScrapeText(in.Provider, scrapeCacheMaxSmall),
		MediaType: clipScrapeText(in.MediaType, 32),
		UserTitle: clipScrapeText(in.UserTitle, scrapeCacheMaxTitle),
		/* v0.9.94（需求9）：季字段同样限长；季号非法（负数/过大）直接归零不拒收整条。 */
		SeasonTag:      clipScrapeText(in.SeasonTag, scrapeCacheMaxSmall),
		SeasonName:     clipScrapeText(in.SeasonName, scrapeCacheMaxTitle),
		SeasonOverview: clipScrapeText(in.SeasonOverview, scrapeCacheMaxDesc),
		Kind:           clipScrapeText(in.Kind, 32),
		Reason:         clipScrapeText(in.Reason, scrapeCacheMaxTitle),
		TMDBID:         in.TMDBID,
		TVDBID:         in.TVDBID,
		CheckedAt:      in.CheckedAt,
	}
	if in.SeasonNum > 0 && in.SeasonNum <= 99 {
		out.SeasonNum = in.SeasonNum
	}
	for _, raw := range []string{in.Poster, in.Backdrop, in.Logo, in.Fanart} {
		if !validScrapeCacheURL(strings.TrimSpace(raw)) {
			return out, false
		}
	}
	out.Poster = strings.TrimSpace(in.Poster)
	out.Backdrop = strings.TrimSpace(in.Backdrop)
	out.Logo = strings.TrimSpace(in.Logo)
	out.Fanart = strings.TrimSpace(in.Fanart)
	if in.Rating < 0 || math.IsNaN(in.Rating) || math.IsInf(in.Rating, 0) {
		return out, false
	}
	out.Rating = math.Round(math.Min(in.Rating, 10)*10) / 10
	switch in.State {
	case "ok", "failed", "skip", "pending":
		out.State = in.State
	case "":
	default:
		// 未知状态不落库（前端会按「待刮削」重新排，不会污染展示）。
		out.State = ""
	}
	if out.CheckedAt < 0 {
		out.CheckedAt = 0
	}
	if out.CheckedAt == 0 {
		out.CheckedAt = time.Now().UnixMilli()
	}
	return out, true
}

func scrapeCacheItemEmpty(it scrapeCacheItem) bool {
	return it.Title == "" && it.ShowTitle == "" && it.Overview == "" && it.Poster == "" && it.Backdrop == "" &&
		it.Logo == "" && it.Fanart == "" && it.Provider == "" && it.UserTitle == "" &&
		it.TMDBID == 0 && it.TVDBID == 0
}

/* ---------- HTTP ---------- */

func (a *App) scrapeCacheHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.scrapeCacheGet(w, r)
	case http.MethodPost:
		a.scrapeCachePost(w, r)
	case http.MethodDelete:
		a.scrapeCacheDelete(w, r)
	default:
		errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *App) scrapeCacheGet(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		errJSON(w, 400, "missing library id")
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit := 0
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
		limit = n
	}
	// v0.9.89：整段读在锁内完成并返回副本 —— 旧实现把共享 map 拿到锁外遍历，
	// 与并发的 POST 写同一张 map 会触发 fatal error（生产事故根因）。
	items, updated, total, version, err := a.scrapeCacheRead(id, since, limit)
	if err != nil {
		// 坏文件：明确报错，让前端继续用本地元数据，而不是假装「库里没数据」。
		errJSON(w, 500, "scrape cache unreadable")
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "id": id, "version": version, "updated": updated,
		"count": len(items), "total": total, "items": items,
	})
}

func (a *App) scrapeCachePost(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	var body struct {
		ID      string                     `json:"id"`
		Items   map[string]scrapeCacheItem `json:"items"`
		Replace bool                       `json:"replace"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&body) != nil {
		errJSON(w, 400, "invalid scrape cache payload")
		return
	}
	if string(body.ID) == "" {
		errJSON(w, 400, "missing library id")
		return
	}
	if _, ok := a.find(body.ID); !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	if len(body.Items) == 0 {
		errJSON(w, 400, "empty scrape cache payload")
		return
	}
	// v0.9.89：合并 + 落盘整段持锁（并发 POST 不会再 fatal）。
	stored, skipped, count, updated, err := a.scrapeCacheMerge(body.ID, body.Items, body.Replace)
	if err != nil {
		if count == 0 && stored == 0 && skipped == 0 {
			errJSON(w, 500, "scrape cache write failed")
			return
		}
		errJSON(w, 500, "scrape cache unreadable")
		return
	}
	/* v1.0.8（需求7）：刮削结果不只落在服务器数据目录，还要写回媒体同目录 ——
	   Kodi / Emby / Jellyfin / Plex 都能直接读，换设备或重装也不用再联网刮一遍。
	   仅影视库；写失败不影响本次保存（只报告计数）。 */
	nfoWritten, nfoKept := a.persistScrapeNFO(body.ID, body.Items)
	writeJSON(w, 200, map[string]any{
		"ok": true, "id": body.ID, "stored": stored, "skipped": skipped,
		"count": count, "updated": updated,
		"nfo_written": nfoWritten, "nfo_kept": nfoKept,
	})
}

func (a *App) scrapeCacheDelete(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	id := r.URL.Query().Get("id")
	all := r.URL.Query().Get("all") == "1"
	if !all && id == "" {
		errJSON(w, 400, "missing library id")
		return
	}
	cleared, err := a.scrapeCacheClear(id, all)
	if err != nil {
		errJSON(w, 500, "scrape cache write failed")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "id": id, "cleared": cleared})
}
