package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

/* v0.9.67：在线歌词刮削 + 落盘填充。
 *
 * 真机实测（从生产容器直连，2026-09）：
 *   LRCLIB /api/get     200 / 0.85s  含 syncedLyrics + plainLyrics  ← 主源（中英文都能命中）
 *   LRCLIB /api/search  遇到 503 ServerOverloaded（重试即命中）      ← 需指数退避
 *   lyrics.ovh          英文 200 / 0.9s；中文 404                    ← 纯文本兜底（英文向）
 *   NetEase 非官方接口  200 / 0.14s  带时间轴歌词 + tlyric 翻译      ← 默认关闭（见下）
 *   api.synclrc.com     实测完全不可达；Deezer 从 NAS 超时            ← 均不采纳
 *
 * 版权与合规：歌词仅落盘到用户自己的自托管媒体库（同目录 .lrc sidecar），
 * 与既有封面刮削同类，不重新分发、不打包进发布物。NetEase 走的是未公开接口，
 * 可能变更或封禁，因此默认关闭，需显式 VAULTHUB_LYRICS_NETEASE=1 才启用。
 */

var (
	lrclibBase    = "https://lrclib.net"
	lyricsOvhBase = "https://api.lyrics.ovh"
	neteaseBase   = "https://music.163.com"
)

// lyricsMinInterval 全局节流间隔：LRCLIB 公开实例对突发请求会返回 503。
const lyricsMinInterval = 900 * time.Millisecond

func (a *App) neteaseLyricsEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(env("VAULTHUB_LYRICS_NETEASE", "0")))
	return v == "1" || v == "true" || v == "on"
}

// lyricsThrottle 保证两次外呼之间至少间隔 lyricsMinInterval。
func (a *App) lyricsThrottle(ctx context.Context) {
	a.lyricsMu.Lock()
	wait := lyricsMinInterval - time.Since(a.lyricsLast)
	a.lyricsLast = time.Now().Add(wait)
	a.lyricsMu.Unlock()
	if wait <= 0 {
		return
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

func (a *App) lyricsClient() (*http.Client, error) {
	return outboundHTTPClient(a.scraperProxy)
}

// scrapeAudioLyrics 按「LRCLIB 精确 → LRCLIB 搜索 → lyrics.ovh → （可选）NetEase」顺序尝试。
func (a *App) scrapeAudioLyrics(ctx context.Context, title, artist string) (lyricsResult, bool) {
	title = strings.TrimSpace(title)
	artist = strings.TrimSpace(artist)
	if title == "" {
		return lyricsResult{}, false
	}
	if r, ok := a.lrclibGet(ctx, title, artist); ok {
		return r, true
	}
	if r, ok := a.lrclibSearch(ctx, title, artist); ok {
		return r, true
	}
	if r, ok := a.lyricsOvh(ctx, title, artist); ok {
		return r, true
	}
	if a.neteaseLyricsEnabled() {
		if r, ok := a.neteaseLyrics(ctx, title, artist); ok {
			return r, true
		}
	}
	return lyricsResult{}, false
}

type lrclibRecord struct {
	TrackName     string `json:"trackName"`
	ArtistName    string `json:"artistName"`
	AlbumName     string `json:"albumName"`
	PlainLyrics   string `json:"plainLyrics"`
	SyncedLyrics  string `json:"syncedLyrics"`
	Instrumental  bool   `json:"instrumental"`
	Duration      float64 `json:"duration"`
}

func (a *App) lrclibGet(ctx context.Context, title, artist string) (lyricsResult, bool) {
	client, err := a.lyricsClient()
	if err != nil {
		return lyricsResult{}, false
	}
	a.lyricsThrottle(ctx)
	q := url.Values{}
	q.Set("track_name", title)
	if artist != "" {
		q.Set("artist_name", artist)
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, lrclibBase+"/api/get?"+q.Encode(), nil)
	if err != nil {
		return lyricsResult{}, false
	}
	req.Header.Set("User-Agent", "VaultHub/0.9.67 (+https://github.com/q807738511/vaulthub)")
	res, err := client.Do(req)
	if err != nil {
		return lyricsResult{}, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return lyricsResult{}, false
	}
	var rec lrclibRecord
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&rec); err != nil {
		return lyricsResult{}, false
	}
	return lrclibResult(rec, "LRCLIB")
}

// lrclibSearch 模糊搜索（中文场景更稳），503 时指数退避重试。
func (a *App) lrclibSearch(ctx context.Context, title, artist string) (lyricsResult, bool) {
	client, err := a.lyricsClient()
	if err != nil {
		return lyricsResult{}, false
	}
	q := url.Values{}
	q.Set("track_name", title)
	if artist != "" {
		q.Set("artist_name", artist)
	}
	backoff := 800 * time.Millisecond
	for attempt := 0; attempt < 3; attempt++ {
		a.lyricsThrottle(ctx)
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, lrclibBase+"/api/search?"+q.Encode(), nil)
		if err != nil {
			cancel()
			return lyricsResult{}, false
		}
		req.Header.Set("User-Agent", "VaultHub/0.9.67 (+https://github.com/q807738511/vaulthub)")
		res, err := client.Do(req)
		if err != nil {
			cancel()
			return lyricsResult{}, false
		}
		if res.StatusCode == http.StatusServiceUnavailable || res.StatusCode == http.StatusTooManyRequests {
			res.Body.Close()
			cancel()
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return lyricsResult{}, false
			}
			backoff *= 2
			continue
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			cancel()
			return lyricsResult{}, false
		}
		var list []lrclibRecord
		decErr := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&list)
		res.Body.Close()
		cancel()
		if decErr != nil || len(list) == 0 {
			return lyricsResult{}, false
		}
		best := pickLrclibRecord(title, artist, list)
		return lrclibResult(best, "LRCLIB")
	}
	return lyricsResult{}, false
}

// pickLrclibRecord 优先「标题命中且歌手命中」，其次标题命中，最后取第一条有歌词的。
func pickLrclibRecord(title, artist string, list []lrclibRecord) lrclibRecord {
	hasLyrics := func(r lrclibRecord) bool { return strings.TrimSpace(r.SyncedLyrics) != "" || strings.TrimSpace(r.PlainLyrics) != "" }
	norm := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		s = strings.NewReplacer(" ", "", "-", "", "_", "", "(", "", ")", "", "[", "", "]", "", "（", "", "）", "").Replace(s)
		return s
	}
	nt, na := norm(title), norm(artist)
	for _, r := range list {
		if !hasLyrics(r) {
			continue
		}
		if norm(r.TrackName) == nt && (na == "" || audioArtistNameMatches(artist, r.ArtistName) || norm(r.ArtistName) == na) {
			return r
		}
	}
	for _, r := range list {
		if hasLyrics(r) && norm(r.TrackName) == nt {
			return r
		}
	}
	for _, r := range list {
		if hasLyrics(r) {
			return r
		}
	}
	return list[0]
}

func lrclibResult(rec lrclibRecord, source string) (lyricsResult, bool) {
	if rec.Instrumental {
		return lyricsResult{Instrumental: true, Source: source}, false
	}
	synced := strings.TrimSpace(rec.SyncedLyrics)
	plain := strings.TrimSpace(rec.PlainLyrics)
	text := synced
	if text == "" {
		text = plain
	}
	if !lyricsLooksValid(text) {
		return lyricsResult{}, false
	}
	return lyricsResult{Lyrics: text, Synced: synced, Source: source}, true
}

func (a *App) lyricsOvh(ctx context.Context, title, artist string) (lyricsResult, bool) {
	if artist == "" {
		return lyricsResult{}, false
	}
	client, err := a.lyricsClient()
	if err != nil {
		return lyricsResult{}, false
	}
	a.lyricsThrottle(ctx)
	u := lyricsOvhBase + "/v1/" + url.PathEscape(artist) + "/" + url.PathEscape(title)
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return lyricsResult{}, false
	}
	res, err := client.Do(req)
	if err != nil {
		return lyricsResult{}, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return lyricsResult{}, false
	}
	var out struct {
		Lyrics string `json:"lyrics"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return lyricsResult{}, false
	}
	text := strings.TrimSpace(out.Lyrics)
	if !lyricsLooksValid(text) {
		return lyricsResult{}, false
	}
	return lyricsResult{Lyrics: text, Source: "lyrics.ovh"}, true
}

// neteaseLyrics 走未公开接口（默认关闭）：搜索最佳匹配后取带时间轴歌词，
// 若主歌词为占位内容则尝试 tlyric 翻译。
func (a *App) neteaseLyrics(ctx context.Context, title, artist string) (lyricsResult, bool) {
	client, err := a.lyricsClient()
	if err != nil {
		return lyricsResult{}, false
	}
	a.lyricsThrottle(ctx)
	searchURL := fmt.Sprintf("%s/api/search/get?s=%s&type=1&limit=8", neteaseBase, url.QueryEscape(title+" "+artist))
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, searchURL, nil)
	if err != nil {
		return lyricsResult{}, false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (VaultHub lyrics scraper)")
	res, err := client.Do(req)
	if err != nil {
		return lyricsResult{}, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return lyricsResult{}, false
	}
	var search struct {
		Result struct {
			Songs []struct {
				ID   int64  `json:"id"`
				Name string `json:"name"`
			} `json:"songs"`
		} `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&search); err != nil {
		return lyricsResult{}, false
	}
	if len(search.Result.Songs) == 0 {
		return lyricsResult{}, false
	}
	id := search.Result.Songs[0].ID
	lyricURL := fmt.Sprintf("%s/api/song/lyric?id=%d&lv=-1&kv=-1&tv=-1", neteaseBase, id)
	req2, err := http.NewRequestWithContext(reqCtx, http.MethodGet, lyricURL, nil)
	if err != nil {
		return lyricsResult{}, false
	}
	req2.Header.Set("User-Agent", "Mozilla/5.0 (VaultHub lyrics scraper)")
	res2, err := client.Do(req2)
	if err != nil {
		return lyricsResult{}, false
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusOK {
		return lyricsResult{}, false
	}
	var body struct {
		NoLyric bool `json:"nolyric"`
		Lrc     struct {
			Lyric string `json:"lyric"`
		} `json:"lrc"`
		TLrc struct {
			Lyric string `json:"lyric"`
		} `json:"tlyric"`
	}
	if err := json.NewDecoder(io.LimitReader(res2.Body, 1<<20)).Decode(&body); err != nil {
		return lyricsResult{}, false
	}
	if body.NoLyric {
		return lyricsResult{Instrumental: true, Source: "NetEase"}, false
	}
	text := strings.TrimSpace(body.Lrc.Lyric)
	if !lyricsLooksValid(text) {
		text = strings.TrimSpace(body.TLrc.Lyric)
	}
	if !lyricsLooksValid(text) {
		return lyricsResult{}, false
	}
	return lyricsResult{Lyrics: text, Synced: text, Source: "NetEase"}, true
}

/* writeLyricsSidecar 把歌词写入媒体库同目录的 <名>.lrc（原子写）。
   为什么写 sidecar 而不是改音频内嵌标签：重写音频文件风险高（大文件重排、
   失败即损坏原文件），而 .lrc 是行业通用格式（Navidrome/Emby/Plex 同规则），
   删除即回滚，且不触碰原始音频字节。 */
func writeLyricsSidecar(absPath, text string) (string, bool) {
	if strings.TrimSpace(text) == "" || len(text) > 64*1024 {
		return "", false
	}
	/* 只对音频文件写 sidecar：safeFile 已保证目标在媒体库内，但原实现允许对库里
	   任意 `<stem>.lrc`（含视频、含用户已有歌词）落盘。 */
	if !isAudioMediaPath(absPath) {
		return "", false
	}
	dir := filepath.Dir(absPath)
	stem := strings.TrimSuffix(filepath.Base(absPath), filepath.Ext(absPath))
	final := filepath.Join(dir, stem+".lrc")
	/* 目标若是指向别处的符号链接则跳过（避免被诱导写入链接目标）。 */
	if fi, err := os.Lstat(final); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return "", false
	}
	/* 临时名不可预测 + fsync + 显式权限，避免可预测 tmp 被预置链接利用。 */
	f, err := os.CreateTemp(dir, "."+stem+".lrc-*.tmp")
	if err != nil {
		return "", false
	}
	tmp := f.Name()
	if _, err := f.WriteString(text); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(tmp, 0o644)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", false
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", false
	}
	return final, true
}

/* audioLyrics 歌词端点：
     GET /api/media/audio/lyrics?id=&path=&title=&artist=&force=0&save=0
   顺序：本地（同名 .lrc / 内嵌标签）→ 在线源链；save=1 时落盘 sidecar（需要写权限）。
   已有本地歌词时默认直接返回，不再联网（force=1 可跳过本地）。 */
func (a *App) audioLyrics(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	/* 歌词只对音频库有意义：避免把影视库里的 GB 级文件拿来解析标签（审查 B2 建议）。 */
	if l.Type != "audio" {
		errJSON(w, 400, "lyrics require an audio library")
		return
	}
	mediaPath := r.URL.Query().Get("path")
	abs, _, e := safeFile(l, mediaPath)
	if e != nil {
		errJSON(w, 404, "file not found")
		return
	}
	save := r.URL.Query().Get("save") == "1"
	force := r.URL.Query().Get("force") == "1"
	if save && !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if !isAudioMediaPath(abs) {
		errJSON(w, 400, "not an audio file")
		return
	}
	var out lyricsResult
	found := false
	if !force {
		if local, ok := localLyrics(abs); ok {
			out, found = local, true
		}
	}
	if !found {
		title := strings.TrimSpace(r.URL.Query().Get("title"))
		artist := strings.TrimSpace(r.URL.Query().Get("artist"))
		if title == "" {
			title = strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
		}
		if scraped, ok := a.scrapeAudioLyrics(r.Context(), title, artist); ok {
			out, found = scraped, true
		}
	}
	if !found {
		writeJSON(w, 200, map[string]any{"ok": false, "found": false, "path": mediaPath})
		return
	}
	saved := ""
	if save {
		if p, ok := writeLyricsSidecar(abs, out.Lyrics); ok {
			saved = p
		}
	}
	writeJSON(w, 200, map[string]any{
		"ok":             true,
		"found":          true,
		"path":           mediaPath,
		"lyrics":         out.Lyrics,
		"synced_lyrics":  out.Synced,
		"lyrics_source":  out.Source,
		"instrumental":   out.Instrumental,
		"saved":          saved != "",
		"sidecar":        saved,
		"netEaseEnabled": a.neteaseLyricsEnabled(),
	})
}

/* batchLyrics 批量歌词：POST /api/media/audio/lyrics/batch
   前端「一键刮削歌词」用；服务端串行（节流）避免触发公开实例限流。
   请求体: {"items":[{"path","title","artist"}],"save":true} —— 最多 200 条。 */
func (a *App) batchLyrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	/* v0.9.69：单次批量已限 50 首 + 150s 预算，但并发多个请求仍会叠加外呼。
	   这里用非阻塞闸门串行化：已有任务在跑时返回 429，前端稍后重试。 */
	releaseBatch, allowed := a.beginLyricsBatch()
	if !allowed {
		errJSON(w, 429, "another lyrics batch is already running")
		return
	}
	defer releaseBatch()
	var in struct {
		Items []struct {
			Path   string `json:"path"`
			Title  string `json:"title"`
			Artist string `json:"artist"`
		} `json:"items"`
		Save bool `json:"save"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
		errJSON(w, 400, "invalid request body")
		return
	}
	/* 审查建议：原上限 200 × 最多 3 个源 × 全局间隔 ≥900ms ≈ 单次 POST 可占用
	   连接/goroutine 约 9 分钟，并让交互式单曲歌词请求全部排队。降到 50（与前端
	   一次批量的规模一致）并加总时长预算，超时返回已完成的部分。 */
	if len(in.Items) > 50 {
		in.Items = in.Items[:50]
	}
	batchCtx, cancelBatch := context.WithTimeout(r.Context(), 150*time.Second)
	defer cancelBatch()
	type item struct {
		Path    string `json:"path"`
		Found   bool   `json:"found"`
		Source  string `json:"lyrics_source,omitempty"`
		Saved   bool   `json:"saved,omitempty"`
		Length  int    `json:"length,omitempty"`
		Error   string `json:"error,omitempty"`
	}
	out := make([]item, 0, len(in.Items))
	hits := 0
	for _, it := range in.Items {
		one := item{Path: it.Path}
		abs, _, e := safeFile(l, it.Path)
		if e != nil {
			one.Error = "invalid path"
			out = append(out, one)
			continue
		}
		var res lyricsResult
		found := false
		if !isAudioMediaPath(abs) {
			one.Error = "not an audio file"
			out = append(out, one)
			continue
		}
		if local, ok := localLyrics(abs); ok {
			res, found = local, true
		} else {
			title := strings.TrimSpace(it.Title)
			if title == "" {
				title = strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
			}
			if scraped, ok := a.scrapeAudioLyrics(batchCtx, title, it.Artist); ok {
				res, found = scraped, true
			}
		}
		one.Found = found
		if found {
			hits++
			one.Source = res.Source
			one.Length = len(res.Lyrics)
			if in.Save {
				if _, ok := writeLyricsSidecar(abs, res.Lyrics); ok {
					one.Saved = true
				}
			}
		}
		out = append(out, one)
		if batchCtx.Err() != nil {
			break
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "total": len(in.Items), "hits": hits, "items": out})
}

/* v0.9.69：批量歌词的进程内串行闸门（容量 1，非阻塞获取）。
 * 返回 release 闭包而非独立的 end：审查指出「独立的 end + select/default」会被误调
 * （一次非持有者的 end 就能清空持有者令牌，让两个批量同时跑）。闭包模式保证
 * 只有取得令牌的那次调用能释放它，与 acquireTranscode 一致。 */
func (a *App) beginLyricsBatch() (func(), bool) {
	select {
	case a.lyricsBatchSem <- struct{}{}:
		return func() { <-a.lyricsBatchSem }, true
	default:
		return func() {}, false
	}
}

var _ = bytes.MinRead

/* isAudioMediaPath 限定歌词落盘只针对音频文件。
   审查指出：sidecar 目标来自 safeFile，范围已在媒体库内，但原实现可对库里任意
   `<stem>.lrc`（包括视频）写文件；同时歌词识别也应只对音频扩展名生效。 */
var audioMediaExts = map[string]bool{
	".mp3": true, ".flac": true, ".m4a": true, ".ogg": true, ".opus": true,
	".wav": true, ".aac": true, ".ape": true, ".wma": true, ".aiff": true, ".alac": true,
}

func isAudioMediaPath(p string) bool {
	return audioMediaExts[strings.ToLower(filepath.Ext(p))]
}
