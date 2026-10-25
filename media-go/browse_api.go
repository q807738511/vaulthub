package main

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* v1.0.9（需求3）：大媒体库的服务端分页 / 聚合。
 *
 * 现场实测（生产库 18.4 万条电子书、17.9 万条音乐）：
 *   打开音乐库 → 174 次 /api/media/files 请求、36 MB JSON、一次性 5828 张歌手卡；
 *   打开电子书库 → 231 次请求 / 52.6 MB JSON。
 * 首屏单次请求只有 ~60 ms，慢的完全是「把整库索引搬到浏览器再本地排序/分组」。
 *
 * 这里把两件事挪到服务端：
 *   1. POST /api/media/shelf —— 书刊/影视分页（搜索、排序、页签筛选与计数）；
 *   2. GET  /api/media/audio/browse —— 音乐三级聚合（歌手 → 专辑 → 曲目）。
 * 客户端只拿当屏数据，单页几十条、几 KB。
 *
 * 约定：
 *   - 数据源是本地索引表 files（lib, path, size, mtime），不额外扫盘；
 *   - 喜欢 / 已完成仍是客户端状态（localStorage 是权威），客户端只把「路径列表」
 *     传上来参与筛选，服务端不做持久化，避免两套状态打架；
 *   - 路径集超过上限时降级：不做该筛选，返回提示字段，前端回落到原有整库逻辑。
 */

const (
	shelfStateMaxPaths = 20000 // 客户端传来的喜欢/已完成路径上限
	shelfMaxSize       = 200   // 单页上限
	audioBrowseMaxSize = 200
)

// browseExts 各分组的可列文件扩展名（与 web/js/02-media.js 的 MEDIA_FORMATS 对齐）。
var browseExts = map[string]map[string]bool{
	"book":   extSet("epub", "pdf", "mobi", "azw", "azw3", "chm", "exe", "umd", "jar", "jad", "caj", "pdg", "djvu", "djv", "ceb", "doc", "docx", "xps", "txt"),
	"comic":  extSet("epub", "mobi", "zip", "cbz", "pdf", "rar", "cbr", "7z", "cb7", "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "cpg", "lzh", "cbl", "tar", "cbt"),
	"audio":  extSet("mp3", "flac", "m4a", "ogg", "wav", "aac", "ape", "opus"),
	"movie":  extSet("mp4", "mkv", "avi", "mov", "m4v", "webm", "ts", "m2ts", "wmv", "flv", "mpg", "mpeg", "rmvb", "iso"),
	"series": extSet("mp4", "mkv", "avi", "mov", "m4v", "webm", "ts", "m2ts", "wmv", "flv", "mpg", "mpeg", "rmvb"),
}

func extSet(list ...string) map[string]bool {
	out := make(map[string]bool, len(list))
	for _, x := range list {
		out[x] = true
	}
	return out
}

// browseGroupFor 把库类型映射到扩展名分组。音乐 MV 库按视频口径。
func browseGroupFor(lib Library, want string) map[string]bool {
	switch want {
	case "book", "comic", "audio", "movie", "series":
		if want == "audio" && lib.Type == "musicvideo" {
			return browseExts["movie"]
		}
		return browseExts[want]
	}
	switch lib.Type {
	case "book":
		return browseExts["book"]
	case "comic":
		return browseExts["comic"]
	case "audio":
		return browseExts["audio"]
	case "series":
		return browseExts["series"]
	default:
		return browseExts["movie"]
	}
}

/* ---------- 书刊 / 影视：服务端分页 ---------- */

type shelfRequest struct {
	ID        string   `json:"id"`
	Group     string   `json:"group"`
	Tab       string   `json:"tab"`
	Q         string   `json:"q"`
	Sort      string   `json:"sort"`
	Dir       string   `json:"dir"`
	Page      int      `json:"page"`
	Size      int      `json:"size"`
	Like      []string `json:"like"`
	Completed []string `json:"completed"`
}

func (a *App) shelfBrowse(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodPost {
		errJSON(w, 405, "POST only")
		return
	}
	var req shelfRequest
	if json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req) != nil {
		errJSON(w, 400, "invalid json")
		return
	}
	lib, ok := a.find(strings.TrimSpace(req.ID))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	if a.db == nil {
		errJSON(w, 503, "index database unavailable")
		return
	}
	// 索引未就绪时明确告知，前端保留「正在索引」界面。
	var total int
	if e := a.db.QueryRow(`SELECT count(*) FROM files WHERE lib=?`, lib.ID).Scan(&total); e != nil {
		errJSON(w, 500, "index query failed")
		return
	}
	if total == 0 {
		writeJSON(w, 200, map[string]any{"ok": true, "id": lib.ID, "status": "indexing", "total": 0,
			"page": 0, "size": 0, "pages": 0, "has_more": false, "files": []FileEntry{},
			"counts": map[string]int{"all": 0, "shelf": 0, "like": 0, "completed": 0}})
		return
	}
	tab := strings.TrimSpace(req.Tab)
	if tab == "" {
		tab = "shelf"
	}
	if tab != "shelf" && tab != "like" && tab != "completed" && tab != "all" {
		errJSON(w, 400, "invalid tab")
		return
	}
	size := req.Size
	if size <= 0 {
		size = 20
	}
	if size > shelfMaxSize {
		size = shelfMaxSize
	}
	page := req.Page
	if page < 0 {
		page = 0
	}
	q := strings.TrimSpace(req.Q)
	if len([]rune(q)) > 200 {
		q = string([]rune(q)[:200])
	}
	exts := browseGroupFor(lib, req.Group)

	like := sanitizePathList(req.Like, shelfStateMaxPaths)
	completed := sanitizePathList(req.Completed, shelfStateMaxPaths)
	truncated := len(req.Like) > shelfStateMaxPaths || len(req.Completed) > shelfStateMaxPaths

	where, args := shelfWhere(lib.ID, q, exts)
	// 页签筛选：喜欢 / 已完成用 IN，书架用 NOT IN（喜欢与已完成集合都很小，
	// 18 万条的整库补集交给 SQL 处理，不需要把整库路径传上去）。
	switch tab {
	case "like":
		if len(like) == 0 {
			writeJSON(w, 200, shelfEmptyPayload(lib.ID, tab, size, truncated))
			return
		}
		where += ` AND path IN (` + placeholders(len(like)) + `)`
		args = append(args, toAny(like)...)
	case "completed":
		if len(completed) == 0 {
			writeJSON(w, 200, shelfEmptyPayload(lib.ID, tab, size, truncated))
			return
		}
		where += ` AND path IN (` + placeholders(len(completed)) + `)`
		args = append(args, toAny(completed)...)
	case "shelf":
		if len(completed) > 0 {
			where += ` AND path NOT IN (` + placeholders(len(completed)) + `)`
			args = append(args, toAny(completed)...)
		}
	}

	counts := a.shelfCounts(lib, q, exts, like, completed)
	matched := counts["all"]
	switch tab {
	case "like":
		matched = counts["like"]
	case "completed":
		matched = counts["completed"]
	case "shelf":
		matched = counts["shelf"]
	}
	pages := 0
	if matched > 0 {
		pages = (matched + size - 1) / size
	}
	if pages > 0 && page >= pages {
		page = pages - 1
	}
	if page < 0 {
		page = 0
	}
	offset := page * size

	order := shelfOrder(req.Sort, req.Dir)
	rows, e := a.db.Query(`SELECT path,size,mtime FROM files WHERE `+where+` ORDER BY `+order+` LIMIT ? OFFSET ?`,
		append(args, size, offset)...)
	files := []FileEntry{}
	if e == nil {
		for rows.Next() {
			var fe FileEntry
			if err := rows.Scan(&fe.Path, &fe.Size, &fe.Mtime); err == nil {
				files = append(files, fe)
			}
		}
		rows.Close()
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "id": lib.ID, "status": "ready", "tab": tab,
		"total": matched, "page": page, "size": size, "pages": pages,
		"has_more": offset+len(files) < matched, "files": files,
		"counts": counts, "truncated_state": truncated,
	})
}

func shelfEmptyPayload(libID, tab string, size int, truncated bool) map[string]any {
	return map[string]any{
		"ok": true, "id": libID, "status": "ready", "tab": tab,
		"total": 0, "page": 0, "size": size, "pages": 0, "has_more": false,
		"files": []FileEntry{}, "counts": map[string]int{"all": 0, "shelf": 0, "like": 0, "completed": 0},
		"truncated_state": truncated,
	}
}

// shelfWhere 构造 WHERE（固定 lib + 可选搜索 + 扩展名白名单 + 排除图片 sidecar）。
func shelfWhere(libID, q string, exts map[string]bool) (string, []any) {
	where := `lib=?`
	args := []any{libID}
	if q != "" {
		where += ` AND lower(path) LIKE ? ESCAPE '\'`
		args = append(args, "%"+strings.ToLower(sqliteLikeEscape(q))+"%")
	}
	if len(exts) > 0 {
		names := make([]string, 0, len(exts))
		for x := range exts {
			names = append(names, x)
		}
		sort.Strings(names)
		parts := make([]string, 0, len(names))
		for _, x := range names {
			parts = append(parts, `lower(path) LIKE ?`)
			args = append(args, "%."+x)
		}
		where += ` AND (` + strings.Join(parts, " OR ") + `)`
	}
	// 封面/海报 sidecar 不是内容（isMediaSidecarImage：<名>.cover.jpg / <名>-poster.jpg …）。
	where += ` AND lower(path) NOT LIKE '%.cover.jpg' AND lower(path) NOT LIKE '%.cover.png'` +
		` AND lower(path) NOT LIKE '%.cover.webp' AND lower(path) NOT LIKE '%.cover.gif'` +
		` AND lower(path) NOT LIKE '%-poster.%' AND lower(path) NOT LIKE '%-fanart.%'` +
		` AND lower(path) NOT LIKE '%-backdrop.%' AND lower(path) NOT LIKE '%-logo.%'` +
		` AND lower(path) NOT LIKE '%.vaulthub.json'`
	return where, args
}

func shelfOrder(sortBy, dir string) string {
	desc := strings.EqualFold(dir, "desc")
	switch sortBy {
	case "date", "mtime":
		if desc {
			return "mtime ASC, path"
		}
		return "mtime DESC, path"
	case "size":
		if desc {
			return "size DESC, path"
		}
		return "size ASC, path"
	default:
		if desc {
			return "lower(path) DESC"
		}
		return "lower(path) ASC"
	}
}

// shelfCounts 计算四个页签的条数（搜索词同时生效）。
func (a *App) shelfCounts(lib Library, q string, exts map[string]bool, like, completed []string) map[string]int {
	out := map[string]int{"all": 0, "shelf": 0, "like": 0, "completed": 0}
	where, args := shelfWhere(lib.ID, q, exts)
	allCount := 0
	_ = a.db.QueryRow(`SELECT count(*) FROM files WHERE `+where, args...).Scan(&allCount)
	out["all"] = allCount
	likeIn := 0
	if len(like) > 0 {
		_ = a.db.QueryRow(`SELECT count(*) FROM files WHERE `+where+` AND path IN (`+placeholders(len(like))+`)`,
			append(args, toAny(like)...)...).Scan(&likeIn)
	}
	doneIn := 0
	if len(completed) > 0 {
		_ = a.db.QueryRow(`SELECT count(*) FROM files WHERE `+where+` AND path IN (`+placeholders(len(completed))+`)`,
			append(args, toAny(completed)...)...).Scan(&doneIn)
	}
	out["like"] = likeIn
	out["completed"] = doneIn
	out["shelf"] = out["all"] - doneIn
	if out["shelf"] < 0 {
		out["shelf"] = 0
	}
	return out
}

func placeholders(n int) string {
	if n <= 0 {
		return "NULL"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func toAny(list []string) []any {
	out := make([]any, 0, len(list))
	for _, x := range list {
		out = append(out, x)
	}
	return out
}

func sanitizePathList(in []string, max int) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, x := range in {
		x = strings.TrimSpace(x)
		if x == "" || len(x) > 1024 || seen[x] {
			continue
		}
		seen[x] = true
		out = append(out, x)
		if len(out) >= max {
			break
		}
	}
	return out
}

/* ---------- 音乐：服务端三级聚合 ---------- */

type audioTrackNode struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Title string `json:"title"`
	// Track 是文件名里的音轨号（无则 0），用于曲目排序。
	Track int `json:"track,omitempty"`
}

type audioAlbumNode struct {
	Name   string           `json:"name"`
	Artist string           `json:"artist"`
	Dir    string           `json:"dir"`
	Tracks []audioTrackNode `json:"tracks"`
}

type audioArtistNode struct {
	Name   string           `json:"name"`
	Albums []audioAlbumNode `json:"albums"`
}

type audioLibAggregate struct {
	version string
	at      int64
	artists map[string]*audioArtistNode
	// order 保留首次出现顺序（按路径字典序），翻页稳定。
	order []string
	total int
}

var (
	audioAggMu    sync.Mutex
	audioAggCache = map[string]*audioLibAggregate{}
)

func (a *App) audioAggregate(lib Library) (*audioLibAggregate, error) {
	var total int
	var maxMtime int64
	if e := a.db.QueryRow(`SELECT count(*), coalesce(max(mtime),0) FROM files WHERE lib=?`, lib.ID).Scan(&total, &maxMtime); e != nil {
		return nil, e
	}
	version := libraryIndexVersion(lib.ID, "audio-agg", "", total, maxMtime)
	audioAggMu.Lock()
	if c, ok := audioAggCache[lib.ID]; ok && c.version == version {
		audioAggMu.Unlock()
		return c, nil
	}
	audioAggMu.Unlock()

	rows, e := a.db.Query(`SELECT path,size,mtime FROM files WHERE lib=? ORDER BY lower(path)`, lib.ID)
	if e != nil {
		return nil, e
	}
	agg := &audioLibAggregate{version: version, at: time.Now().UnixMilli(), artists: map[string]*audioArtistNode{}}
	for rows.Next() {
		var fe FileEntry
		if err := rows.Scan(&fe.Path, &fe.Size, &fe.Mtime); err != nil {
			continue
		}
		if !isAudioBrowseExt(fe.Path) || isMediaSidecarImage(pathBase(fe.Path)) {
			continue
		}
		artist, album, title, track := parseAudioPath(fe.Path)
		an := agg.artists[artist]
		if an == nil {
			an = &audioArtistNode{Name: artist}
			agg.artists[artist] = an
			agg.order = append(agg.order, artist)
		}
		var al *audioAlbumNode
		for i := range an.Albums {
			if an.Albums[i].Name == album {
				al = &an.Albums[i]
				break
			}
		}
		if al == nil {
			an.Albums = append(an.Albums, audioAlbumNode{Name: album, Artist: artist, Dir: pathDir(fe.Path)})
			al = &an.Albums[len(an.Albums)-1]
		}
		al.Tracks = append(al.Tracks, audioTrackNode{Path: fe.Path, Size: fe.Size, Mtime: fe.Mtime, Title: title, Track: track})
		agg.total++
	}
	rows.Close()
	for _, an := range agg.artists {
		sort.SliceStable(an.Albums, func(i, j int) bool { return an.Albums[i].Name < an.Albums[j].Name })
		for i := range an.Albums {
			al := &an.Albums[i]
			sort.SliceStable(al.Tracks, func(x, y int) bool {
				a1, a2 := al.Tracks[x], al.Tracks[y]
				if a1.Track != a2.Track && a1.Track > 0 && a2.Track > 0 {
					return a1.Track < a2.Track
				}
				return a1.Path < a2.Path
			})
		}
	}
	audioAggMu.Lock()
	audioAggCache[lib.ID] = agg
	// 只保留最近使用的 3 个库，避免多库切换时内存无限增长。
	if len(audioAggCache) > 3 {
		for id, c := range audioAggCache {
			if id != lib.ID && time.Now().UnixMilli()-c.at > 10*60*1000 {
				delete(audioAggCache, id)
			}
		}
	}
	audioAggMu.Unlock()
	return agg, nil
}

func filepathExt(p string) string {
	i := strings.LastIndexByte(p, '.')
	slash := strings.LastIndexByte(p, '/')
	if i < 0 || i < slash {
		return ""
	}
	return p[i:]
}

func pathBase(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

func pathDir(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return ""
}

var (
	audioQualityTailRe = regexp.MustCompile(`(?i)^\s*(alac|flac|mp3|wav|aac|aiff|dsd|dsf|hi-?res|24bit|16bit|32bit|320k|panda|mora|ototoy|qobuz|tidal)\b`)
	audioYearPrefixRe  = regexp.MustCompile(`^\s*(19\d{2}|20\d{2})\s*[.\-_·]?\s*`)
	audioTrackPrefixRe = regexp.MustCompile(`^\s*(?:0\d{1,2}|\d{1,3})\s*[.\-_]\s*|^\s*0\d{1,2}\s+`)
)

// isAudioBrowseExt 判定索引路径是否为音频。扩展名表不带点、路径带点 ——
// v1.0.9 首版漏了 TrimPrefix，音乐聚合直接返回空列表，测试钉住这个差异。
func isAudioBrowseExt(p string) bool {
	return browseExts["audio"][strings.ToLower(strings.TrimPrefix(filepathExt(p), "."))]
}

/*
parseAudioPath 从索引路径推断（歌手, 专辑, 曲名, 音轨号）。

	与前端 audioBaseMetadata 同源，但优先用目录结构：音乐库最常见的两种组织方式是
	`<歌手>/<专辑>/01 曲名.flac` 与 `<年份 歌手 - 专辑>/曲名.flac`。
	子目录（Booklet / Disc 1 / Scans / cover）先上溯，避免把插图目录当专辑。
*/
func parseAudioPath(p string) (artist, album, title string, track int) {
	stem := pathBase(p)
	if i := strings.LastIndexByte(stem, '.'); i > 0 {
		stem = stem[:i]
	}
	segs := strings.Split(pathDir(p), "/")
	for len(segs) > 0 && isGenericAudioDir(segs[len(segs)-1]) {
		segs = segs[:len(segs)-1]
	}
	folder, parent := "", ""
	if len(segs) > 0 {
		folder = segs[len(segs)-1]
	}
	if len(segs) > 1 {
		parent = segs[len(segs)-2]
	}
	norm := strings.NewReplacer(
		"\u3000", " ",
		"－", "-", "−", "-", "—", "-", "―", "-", "–", "-",
	).Replace(stem)
	if m := audioTrackPrefixRe.FindString(norm); m != "" {
		num := strings.TrimSpace(strings.Trim(m, ".-_ "))
		if n, err := strconv.Atoi(num); err == nil {
			track = n
		}
		norm = strings.TrimSpace(norm[len(m):])
	}
	folderArtist, folderAlbum := splitArtistAlbum(folder)
	artist, album = folderArtist, folderAlbum
	if artist == "" {
		// 目录名没有「歌手 - 专辑」写法：用上一级目录当歌手（经典 Artist/Album 结构）。
		if parent != "" && !isGenericAudioDir(parent) {
			artist = strings.TrimSpace(audioYearPrefixRe.ReplaceAllString(parent, ""))
		}
	}
	title = strings.TrimSpace(norm)
	if titleArtist, rest := splitArtistAlbum(norm); titleArtist != "" && rest != "" && artist == "" {
		artist = titleArtist
		title = rest
	}
	if artist == "" {
		artist = "未知歌手"
	}
	if album == "" {
		album = "未知专辑"
	}
	if title == "" {
		title = stem
	}
	return artist, album, title, track
}

// isGenericAudioDir 判定插图 / 分盘这类子目录，它们不是专辑名。
func isGenericAudioDir(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "", "booklet", "booklets", "scan", "scans", "cover", "covers", "artwork", "art", "images", "jpg",
		"cd1", "cd2", "cd3", "cd4", "disc1", "disc2", "disc3", "disc 1", "disc 2", "disc 3", "disk1", "disk2",
		"covers+booklet", "bk":
		return true
	}
	return false
}

// splitArtistAlbum 把 `2009 fripSide - only my railgun` 拆成（fripSide, only my railgun），
// 并剥掉 `- ALAC 24bit 44.1khz - Panda` 这类发布组/规格尾巴。
func splitArtistAlbum(s string) (string, string) {
	s = strings.TrimSpace(strings.Trim(s, "[]{}【】"))
	s = audioYearPrefixRe.ReplaceAllString(s, "")
	parts := strings.SplitN(s, " - ", 2)
	if len(parts) < 2 {
		return "", strings.TrimSpace(s)
	}
	left := strings.TrimSpace(parts[0])
	right := strings.TrimSpace(parts[1])
	// 规格尾巴可能有多段，逐段截断。
	for {
		idx := strings.Index(right, " - ")
		if idx < 0 {
			break
		}
		if audioQualityTailRe.MatchString(strings.TrimSpace(right[idx+3:])) {
			right = strings.TrimSpace(right[:idx])
			continue
		}
		break
	}
	if audioQualityTailRe.MatchString(right) && left != "" {
		return "", left
	}
	return left, right
}

func (a *App) audioBrowse(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	qp := r.URL.Query()
	lib, ok := a.find(strings.TrimSpace(qp.Get("id")))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	if a.db == nil {
		errJSON(w, 503, "index database unavailable")
		return
	}
	agg, e := a.audioAggregate(lib)
	if e != nil {
		errJSON(w, 500, "index query failed")
		return
	}
	level := strings.TrimSpace(qp.Get("level"))
	if level == "" {
		level = "artists"
	}
	page, _ := strconv.Atoi(qp.Get("page"))
	if page < 0 {
		page = 0
	}
	size, _ := strconv.Atoi(qp.Get("size"))
	if size <= 0 {
		size = 60
	}
	if size > audioBrowseMaxSize {
		size = audioBrowseMaxSize
	}
	q := strings.ToLower(strings.TrimSpace(qp.Get("q")))
	artist := strings.TrimSpace(qp.Get("artist"))
	album := strings.TrimSpace(qp.Get("album"))
	base := map[string]any{"ok": true, "id": lib.ID, "level": level, "page": page, "size": size,
		"tracks_total": agg.total, "artists_total": len(agg.order)}

	switch level {
	case "albums":
		an := agg.artists[artist]
		list := []audioAlbumNode{}
		if an != nil {
			for _, al := range an.Albums {
				if q != "" && !strings.Contains(strings.ToLower(al.Name), q) {
					continue
				}
				list = append(list, al)
			}
		}
		filtered := make([]map[string]any, 0, len(list))
		for _, al := range list {
			filtered = append(filtered, map[string]any{"name": al.Name, "artist": al.Artist, "dir": al.Dir, "tracks": len(al.Tracks)})
		}
		writeJSON(w, 200, mergeMap(base, map[string]any{
			"artist": artist, "total": len(filtered), "albums": filtered,
			"has_more": false,
		}))
	case "tracks":
		tracks := []audioTrackNode{}
		if artist == "" && album != "" {
			// 只给了专辑名（歌单 / 喜欢列表回跳）：跨歌手找同名专辑。
			for _, name := range agg.order {
				an := agg.artists[name]
				for _, al := range an.Albums {
					if al.Name == album {
						tracks = append(tracks, al.Tracks...)
					}
				}
			}
		} else if an := agg.artists[artist]; an != nil {
			for _, al := range an.Albums {
				if album != "" && al.Name != album {
					continue
				}
				tracks = append(tracks, al.Tracks...)
			}
		}
		if q != "" {
			keep := tracks[:0]
			for _, t := range tracks {
				if strings.Contains(strings.ToLower(t.Title), q) || strings.Contains(strings.ToLower(t.Path), q) {
					keep = append(keep, t)
				}
			}
			tracks = keep
		}
		start := page * size
		if start > len(tracks) {
			start = len(tracks)
		}
		end := start + size
		if end > len(tracks) {
			end = len(tracks)
		}
		writeJSON(w, 200, mergeMap(base, map[string]any{
			"artist": artist, "album": album, "total": len(tracks),
			"albums": []any{}, "files": tracks[start:end], "has_more": end < len(tracks),
		}))
	default:
		names := agg.order
		if q != "" {
			keep := make([]string, 0, 64)
			for _, name := range names {
				if strings.Contains(strings.ToLower(name), q) {
					keep = append(keep, name)
					continue
				}
				if an := agg.artists[name]; an != nil {
					for _, al := range an.Albums {
						if strings.Contains(strings.ToLower(al.Name), q) || strings.Contains(strings.ToLower(al.Dir), q) {
							keep = append(keep, name)
							break
						}
					}
				}
			}
			names = keep
		}
		start := page * size
		if start > len(names) {
			start = len(names)
		}
		end := start + size
		if end > len(names) {
			end = len(names)
		}
		out := make([]map[string]any, 0, end-start)
		for _, name := range names[start:end] {
			an := agg.artists[name]
			tracks := 0
			for _, al := range an.Albums {
				tracks += len(al.Tracks)
			}
			out = append(out, map[string]any{"name": name, "albums": len(an.Albums), "tracks": tracks})
		}
		writeJSON(w, 200, mergeMap(base, map[string]any{
			"total": len(names), "artists": out, "has_more": end < len(names),
		}))
	}
}

func mergeMap(base, extra map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

/* v1.0.9（需求3）：按路径批量取索引条目。
 * 歌单、喜欢列表、播放队列只存路径；旧实现为了拿到 size/mtime 会把整库索引拉一遍
 * （18 万条 / 36 MB）。这里一次 IN 查询就够了，歌单通常几十首。
 * 只返回索引里真实存在的路径（顺序与请求一致），不存在的直接跳过。
 */
func (a *App) lookupPaths(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodPost {
		errJSON(w, 405, "POST only")
		return
	}
	var body struct {
		ID    string   `json:"id"`
		Paths []string `json:"paths"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body) != nil {
		errJSON(w, 400, "invalid json")
		return
	}
	lib, ok := a.find(strings.TrimSpace(body.ID))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	if a.db == nil {
		errJSON(w, 503, "index database unavailable")
		return
	}
	paths := sanitizePathList(body.Paths, 5000)
	if len(paths) == 0 {
		writeJSON(w, 200, map[string]any{"ok": true, "id": lib.ID, "files": []FileEntry{}, "missing": 0})
		return
	}
	found := map[string]FileEntry{}
	rows, e := a.db.Query(`SELECT path,size,mtime FROM files WHERE lib=? AND path IN (`+placeholders(len(paths))+`)`,
		append([]any{lib.ID}, toAny(paths)...)...)
	if e == nil {
		for rows.Next() {
			var fe FileEntry
			if rows.Scan(&fe.Path, &fe.Size, &fe.Mtime) == nil {
				found[fe.Path] = fe
			}
		}
		rows.Close()
	}
	out := make([]FileEntry, 0, len(found))
	missing := 0
	for _, p := range paths {
		if fe, ok := found[p]; ok {
			out = append(out, fe)
		} else {
			missing++
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "id": lib.ID, "files": out, "missing": missing, "requested": len(paths)})
}
