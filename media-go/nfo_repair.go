package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* v1.0.9（需求1）：NFO 体检与补全。
 *
 * 现场问题：库里大量条目的 NFO「信息缺失」甚至「完全无信息」——
 *   · 没有 NFO 文件（老库、下载自带的散装目录）；
 *   · NFO 存在但只有标题，没有简介/评分/海报；
 *   · 剧集只有单集 NFO，剧名根目录没有 tvshow.nfo。
 * 旧版只能靠前端「翻到哪个条目才刮哪个」，没人翻的条目永远补不上。
 *
 * 这里把它做成服务端作业：
 *   1. 逐条读本地元数据（复用 readLocalMediaMetadata 的全部候选规则）；
 *   2. 判定「缺什么」：NFO / 标题 / 简介 / 评分 / 海报；
 *   3. 缺就刮：TMDB（配了密钥时优先，含简介/类型/演职人员）→ 豆瓣兜底（标题/年份/评分/海报）；
 *   4. 写回媒体同目录：<文件名>.nfo（剧集另写剧名根 tvshow.nfo），海报下载成
 *      <文件名>-poster.jpg（与读取端 local_metadata 的候选名一致）；
 *   5. 只填不改：已有值一律保留，用户手写 NFO 走 nfoMergeIntoExisting 合并。
 *
 * 接口：
 *   POST /api/media/nfo/repair        {id, limit, dry_run, download_art}  启动作业
 *   GET  /api/media/nfo/repair/status?id=                               进度快照
 *   POST /api/media/nfo/repair/cancel?id=                               取消
 *   POST /api/media/nfo/repair/one    {id, path, download_art}          单条补全（详情页用）
 */

const (
	nfoRepairMaxLimit   = 5000
	nfoRepairSampleMax  = 200
	nfoRepairMaxRuntime = 40 * time.Minute
)

type nfoRepairItem struct {
	Path     string   `json:"path"`
	State    string   `json:"state"` // ok | repaired | missing | failed | skipped
	Missing  []string `json:"missing,omitempty"`
	Title    string   `json:"title,omitempty"`
	Year     string   `json:"year,omitempty"`
	Provider string   `json:"provider,omitempty"`
	NFO      string   `json:"nfo,omitempty"`
	Artwork  []string `json:"artwork,omitempty"`
	Error    string   `json:"error,omitempty"`
}

type nfoRepairJob struct {
	mu         sync.Mutex
	LibID      string          `json:"id"`
	LibName    string          `json:"library"`
	DryRun     bool            `json:"dry_run"`
	Download   bool            `json:"download_art"`
	State      string          `json:"state"` // running | done | cancelled | error
	Total      int             `json:"total"`
	Scanned    int             `json:"scanned"`
	OK         int             `json:"ok"`
	Missing    int             `json:"missing"`
	Repaired   int             `json:"repaired"`
	Failed     int             `json:"failed"`
	Artwork    int             `json:"artwork"`
	ArtworkErr int             `json:"artwork_failed"`
	StartedAt  int64           `json:"started_at"`
	EndedAt    int64           `json:"ended_at"`
	Current    string          `json:"current"`
	Message    string          `json:"message,omitempty"`
	Sample     []nfoRepairItem `json:"sample"`
	ErrorList  []string        `json:"errors,omitempty"`
	cancelled  bool
	finishedAt int64
}

func (j *nfoRepairJob) snapshot() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	sample := make([]nfoRepairItem, len(j.Sample))
	copy(sample, j.Sample)
	errs := make([]string, len(j.ErrorList))
	copy(errs, j.ErrorList)
	return map[string]any{
		"ok": true, "id": j.LibID, "library": j.LibName, "state": j.State,
		"dry_run": j.DryRun, "download_art": j.Download,
		"total": j.Total, "scanned": j.Scanned, "ok_count": j.OK,
		"missing": func() int {
			// 「仍缺」= 判定缺信息但本次没补上的条数（不含已补全的）。
			if j.Missing-j.Repaired > 0 {
				return j.Missing - j.Repaired
			}
			return 0
		}(), "repaired": j.Repaired, "failed": j.Failed, "artwork": j.Artwork, "artwork_failed": j.ArtworkErr,
		"progress": func() int {
			if j.Total <= 0 {
				return 0
			}
			return j.Scanned * 100 / j.Total
		}(),
		"started_at": j.StartedAt, "ended_at": j.EndedAt, "current": j.Current,
		"message": j.Message, "sample": sample, "errors": errs,
	}
}

var (
	nfoRepairMu   sync.Mutex
	nfoRepairJobs = map[string]*nfoRepairJob{}
)

func nfoRepairActive(libID string) *nfoRepairJob {
	nfoRepairMu.Lock()
	defer nfoRepairMu.Unlock()
	j := nfoRepairJobs[libID]
	if j == nil {
		return nil
	}
	j.mu.Lock()
	running := j.State == "running"
	j.mu.Unlock()
	if running {
		return j
	}
	return j // 已结束的运行结果仍可读，是否可重启由调用方判断
}

func nfoRepairIsRunning(libID string) bool {
	j := nfoRepairActive(libID)
	if j == nil {
		return false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.State == "running"
}

/* ---------- HTTP ---------- */

func (a *App) nfoRepairHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		a.nfoRepairStart(w, r)
	case http.MethodGet:
		a.nfoRepairStatus(w, r)
	default:
		errJSON(w, 405, "method not allowed")
	}
}

func (a *App) nfoRepairStart(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	var body struct {
		ID          string `json:"id"`
		Limit       int    `json:"limit"`
		DryRun      bool   `json:"dry_run"`
		DownloadArt *bool  `json:"download_art"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body) != nil {
		errJSON(w, 400, "invalid json")
		return
	}
	lib, ok := a.find(strings.TrimSpace(body.ID))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	if lib.Type != "movie" && lib.Type != "series" {
		errJSON(w, 400, "nfo repair supports movie/series libraries only")
		return
	}
	if a.db == nil {
		errJSON(w, 503, "index database unavailable")
		return
	}
	if nfoRepairIsRunning(lib.ID) {
		errJSON(w, 409, "nfo repair already running")
		return
	}
	limit := body.Limit
	if limit <= 0 {
		limit = 500
	}
	if limit > nfoRepairMaxLimit {
		limit = nfoRepairMaxLimit
	}
	download := true
	if body.DownloadArt != nil {
		download = *body.DownloadArt
	}
	paths, err := a.nfoRepairTargets(lib, limit)
	if err != nil {
		errJSON(w, 500, "index query failed")
		return
	}
	job := &nfoRepairJob{
		LibID: lib.ID, LibName: lib.Name, DryRun: body.DryRun, Download: download,
		State: "running", Total: len(paths), StartedAt: time.Now().UnixMilli(),
		Sample: []nfoRepairItem{}, ErrorList: []string{},
	}
	nfoRepairMu.Lock()
	nfoRepairJobs[lib.ID] = job
	nfoRepairMu.Unlock()
	go a.nfoRepairRun(job, lib, paths)
	writeJSON(w, 202, job.snapshot())
}

func (a *App) nfoRepairStatus(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		nfoRepairMu.Lock()
		out := make([]map[string]any, 0, len(nfoRepairJobs))
		for _, j := range nfoRepairJobs {
			out = append(out, j.snapshot())
		}
		nfoRepairMu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "jobs": out})
		return
	}
	job := nfoRepairActive(id)
	if job == nil {
		writeJSON(w, 200, map[string]any{"ok": true, "id": id, "state": "idle"})
		return
	}
	writeJSON(w, 200, job.snapshot())
}

func (a *App) nfoRepairCancel(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	job := nfoRepairActive(id)
	if job == nil {
		errJSON(w, 404, "no repair job")
		return
	}
	job.mu.Lock()
	job.cancelled = true
	job.Message = "已请求取消"
	job.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true, "id": id, "cancelling": true})
}

// nfoRepairOne 单条补全：详情页「补全此条目」按钮。
func (a *App) nfoRepairOne(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodPost {
		errJSON(w, 405, "POST only")
		return
	}
	var body struct {
		ID          string `json:"id"`
		Path        string `json:"path"`
		DownloadArt *bool  `json:"download_art"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body) != nil {
		errJSON(w, 400, "invalid json")
		return
	}
	lib, ok := a.find(strings.TrimSpace(body.ID))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	if lib.Type != "movie" && lib.Type != "series" {
		errJSON(w, 400, "nfo repair supports movie/series libraries only")
		return
	}
	if _, _, err := safeFile(lib, body.Path); err != nil {
		errJSON(w, 400, "invalid media path")
		return
	}
	download := true
	if body.DownloadArt != nil {
		download = *body.DownloadArt
	}
	item := a.nfoRepairOneItem(context.Background(), lib, strings.TrimSpace(body.Path), false, download)
	writeJSON(w, 200, map[string]any{"ok": item.State != "failed", "item": item})
}

/* ---------- 作业主体 ---------- */

func (a *App) nfoRepairTargets(lib Library, limit int) ([]string, error) {
	rows, e := a.db.Query(`SELECT path FROM files WHERE lib=? ORDER BY lower(path)`, lib.ID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := make([]string, 0, limit)
	for rows.Next() {
		var p string
		if rows.Scan(&p) != nil {
			continue
		}
		if !plexIsMediaExt(filepath.Ext(p)) || isMediaSidecarImage(filepath.Base(p)) {
			continue
		}
		/* v1.0.12：原盘备份（BDMV/STREAM/00000.m2ts、VIDEO_TS/VTS_01_1.VOB）里的每个
		   分片不是独立条目 —— 逐片刮削会在媒体库里生成成百上千个垃圾 NFO，
		   而且名字全是 "00000"。整盘交给 /api/media/disc/playlists 处理。 */
		if isDiscSegmentPath(p) {
			continue
		}
		out = append(out, p)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (a *App) nfoRepairRun(job *nfoRepairJob, lib Library, paths []string) {
	deadline := time.Now().Add(nfoRepairMaxRuntime)
	for i, p := range paths {
		job.mu.Lock()
		stop := job.cancelled
		job.Current = p
		job.mu.Unlock()
		if stop || time.Now().After(deadline) {
			break
		}
		item := a.nfoRepairOneItem(context.Background(), lib, p, job.DryRun, job.Download)
		job.mu.Lock()
		job.Scanned = i + 1
		switch item.State {
		case "ok":
			job.OK++
		case "repaired":
			job.Repaired++
			job.Missing++
		case "missing":
			job.Missing++
		case "failed":
			job.Failed++
			if item.Error != "" && len(job.ErrorList) < 40 {
				job.ErrorList = append(job.ErrorList, p+": "+item.Error)
			}
		}
		job.Artwork += len(item.Artwork)
		if strings.HasPrefix(item.Error, "artwork:") {
			job.ArtworkErr++
			if len(job.ErrorList) < 40 {
				job.ErrorList = append(job.ErrorList, p+": "+item.Error)
			}
		}
		if item.State != "ok" && len(job.Sample) < nfoRepairSampleMax {
			job.Sample = append(job.Sample, item)
		}
		job.mu.Unlock()
	}
	job.mu.Lock()
	job.EndedAt = time.Now().UnixMilli()
	job.Current = ""
	switch {
	case job.cancelled:
		job.State = "cancelled"
		job.Message = fmt.Sprintf("已取消（已处理 %d/%d）", job.Scanned, job.Total)
	case time.Now().After(deadline):
		job.State = "done"
		job.Message = fmt.Sprintf("达到单次上限（%d/%d），可再次运行继续", job.Scanned, job.Total)
	default:
		job.State = "done"
		still := job.Missing - job.Repaired
		if still < 0 {
			still = 0
		}
		job.Message = fmt.Sprintf("完成：检查 %d 条，补全 %d 条，仍缺 %d 条，失败 %d 条",
			job.Scanned, job.Repaired, still, job.Failed)
	}
	job.finishedAt = job.EndedAt
	job.mu.Unlock()
}

// nfoAssessment 判定一条媒体缺什么（只看本地，不联网）。
type nfoAssessment struct {
	Missing  []string
	Meta     localMediaMetadata
	Provider string
}

func (a *App) nfoAssess(lib Library, mediaPath string) nfoAssessment {
	out := nfoAssessment{Missing: []string{}}
	m, err := readLocalMediaMetadata(lib, mediaPath)
	if err != nil {
		out.Missing = append(out.Missing, "path")
		return out
	}
	a.mergeMetadataOverride(lib, mediaPath, &m)
	out.Meta = m
	if strings.TrimSpace(m.NFO) == "" {
		out.Missing = append(out.Missing, "nfo")
	}
	if strings.TrimSpace(m.Title) == "" {
		out.Missing = append(out.Missing, "title")
	}
	if strings.TrimSpace(m.Overview) == "" {
		out.Missing = append(out.Missing, "overview")
	}
	if m.Rating <= 0 {
		out.Missing = append(out.Missing, "rating")
	}
	if strings.TrimSpace(m.Poster) == "" {
		out.Missing = append(out.Missing, "poster")
	}
	return out
}

func (a *App) nfoRepairOneItem(ctx context.Context, lib Library, mediaPath string, dryRun, downloadArt bool) nfoRepairItem {
	item := nfoRepairItem{Path: mediaPath, State: "ok"}
	assess := a.nfoAssess(lib, mediaPath)
	if len(assess.Missing) == 0 {
		return item
	}
	// NFO 存在且信息完整、只缺海报：也算「需要补图」。
	needNFO := false
	for _, m := range assess.Missing {
		if m == "nfo" || m == "title" || m == "overview" || m == "rating" {
			needNFO = true
		}
	}
	item.Missing = assess.Missing
	item.Title = assess.Meta.Title
	item.Year = assess.Meta.Year
	item.NFO = assess.Meta.NFO
	if dryRun {
		item.State = "missing"
		return item
	}
	meta, artURL, provider, err := a.nfoScrapeFor(ctx, lib, mediaPath, assess.Meta)
	if err != nil {
		item.State = "failed"
		item.Error = err.Error()
		return item
	}
	if provider != "" {
		item.Provider = provider
	}
	if meta.Title != "" {
		item.Title = meta.Title
	}
	if meta.Year != "" {
		item.Year = meta.Year
	}
	wrote := false
	if needNFO {
		targets := a.nfoRepairTargetsFor(lib, mediaPath)
		for _, t := range targets {
			if _, _, _, werr := writeNFOFile(t, nfoDocFromMeta(meta), false); werr != nil {
				item.State = "failed"
				item.Error = "nfo write failed: " + werr.Error()
				return item
			}
			wrote = true
			item.NFO = t
		}
	}
	if downloadArt && artURL != "" {
		if rel, derr := a.nfoDownloadArt(lib, mediaPath, "poster", artURL); derr == nil {
			item.Artwork = append(item.Artwork, rel)
		} else if strings.Contains(derr.Error(), "artwork exists") {
			// 已经下载过：重复运行不该被记成失败。
			item.Artwork = append(item.Artwork, "exists")
		} else {
			item.Error = "artwork: " + derr.Error()
		}
	}
	if wrote || len(item.Artwork) > 0 {
		item.State = "repaired"
		return item
	}
	item.State = "missing"
	return item
}

// isDiscSegmentPath 判定原盘备份内的分片（这些不是独立影片）。
func isDiscSegmentPath(rel string) bool {
	u := strings.ToUpper("/" + strings.TrimPrefix(filepath.ToSlash(rel), "/"))
	for _, marker := range []string{"/BDMV/STREAM/", "/BDMV/PLAYLIST/", "/VIDEO_TS/", "/CERTIFICATE/"} {
		if strings.Contains(u, marker) {
			return true
		}
	}
	return false
}

// nfoRepairTargetsFor 返回该媒体应写的 NFO 绝对路径（<文件名>.nfo，剧集补 tvshow.nfo）。
func (a *App) nfoRepairTargetsFor(lib Library, mediaPath string) []string {
	abs, _, err := safeFile(lib, mediaPath)
	if err != nil {
		return nil
	}
	dir := filepath.Dir(abs)
	stem := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	out := []string{}
	if stem == "" {
		stem = "movie"
	}
	out = append(out, filepath.Join(dir, stem+".nfo"))
	// 单文件目录额外写 movie.nfo（与读取端 / 其它刮削器一致）。
	if nfoDirMediaCount(dir) == 1 {
		out = append(out, filepath.Join(dir, "movie.nfo"))
	}
	if lib.Type == "series" {
		if e := plexParseRel(mediaPath); e != nil && e.ShowDir != "" {
			showAbs, _, serr := safeFile(lib, indexRelJoin(e.ShowDir, "tvshow.nfo"))
			if serr == nil && !fileExists(showAbs) {
				out = append(out, showAbs)
			}
		}
	}
	return dedupeStrings(out)
}

func indexRelJoin(dir, name string) string {
	dir = strings.TrimSuffix(filepath.ToSlash(strings.TrimSpace(dir)), "/")
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

func fileExists(p string) bool {
	st, e := os.Stat(p)
	return e == nil && !st.IsDir()
}

func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, x := range in {
		if x == "" || seen[x] {
			continue
		}
		seen[x] = true
		out = append(out, x)
	}
	return out
}

// nfoDocFromMeta 把补全结果转成 NFO 文档；只写有值的字段。
func nfoDocFromMeta(m nfoWriteMeta) nfoWriteDoc {
	doc := nfoWriteDoc{
		Title:         nfoClip(m.Title, 200),
		OriginalTitle: nfoClip(m.OriginalTitle, 200),
		ShowTitle:     nfoClip(m.ShowTitle, 200),
		Year:          nfoClip(m.Year, 8),
		Premiered:     nfoClip(m.Premiered, 32),
		Plot:          nfoClip(m.Overview, 4000),
		Outline:       nfoClip(m.Outline, 4000),
		Genres:        []string{},
		Actors:        []nfoActor{},
		UniqueIDs:     []nfoUniqueID{},
		Thumbs:        []nfoThumb{},
		WrittenBy:     "VaultHub",
	}
	if m.Runtime > 0 {
		doc.Runtime = strconv.Itoa(m.Runtime)
	}
	if m.Rating > 0 {
		doc.Rating = strconv.FormatFloat(m.Rating, 'f', 1, 64)
	}
	for _, g := range m.Genres {
		if g = strings.TrimSpace(g); g != "" {
			doc.Genres = append(doc.Genres, nfoClip(g, 40))
		}
	}
	for _, c := range m.Cast {
		if strings.TrimSpace(c.Name) == "" {
			continue
		}
		doc.Actors = append(doc.Actors, nfoActor{Name: nfoClip(c.Name, 80), Role: nfoClip(c.Character, 120)})
		if len(doc.Actors) >= 20 {
			break
		}
	}
	if id := strings.TrimSpace(m.TMDBID); id != "" {
		doc.UniqueIDs = append(doc.UniqueIDs, nfoUniqueID{Type: "tmdb", Value: id})
	}
	if id := strings.TrimSpace(m.TVDBID); id != "" {
		doc.UniqueIDs = append(doc.UniqueIDs, nfoUniqueID{Type: "tvdb", Value: id})
	}
	if p := strings.TrimSpace(m.Poster); p != "" {
		doc.Thumbs = append(doc.Thumbs, nfoThumb{Aspect: "poster", Value: p})
	}
	if f := strings.TrimSpace(m.Fanart); f != "" {
		doc.FanartThumbs = append(doc.FanartThumbs, f)
	}
	return doc
}

/* ---------- 刮削：TMDB 优先，豆瓣兜底 ---------- */

func (a *App) nfoScrapeFor(ctx context.Context, lib Library, mediaPath string, local localMediaMetadata) (nfoWriteMeta, string, string, error) {
	title, year, kind := nfoQueryFromPath(lib, mediaPath, local)
	if strings.TrimSpace(title) == "" {
		return nfoWriteMeta{}, "", "", errors.New("无法从文件名解析出片名")
	}
	meta := nfoWriteMeta{Title: title, Year: year}
	// 已有本地值原样带上（writeNFOFile 合并时不会覆盖已有字段）。
	if strings.TrimSpace(local.Overview) != "" {
		meta.Overview = local.Overview
	}
	artURL := ""
	provider := ""
	if hit, derr := a.nfoTMDBLookup(ctx, kind, title, year); derr == nil && hit.Title != "" {
		meta = hit
		provider = "TMDB"
		artURL = hit.Poster
	}
	if meta.Overview == "" || meta.Rating <= 0 {
		dh := a.lookupDouban(title, year, kind)
		if dh.Match {
			if meta.Title == "" {
				meta.Title = dh.Title
			}
			if meta.Year == "" {
				meta.Year = dh.Year
			}
			if meta.Rating <= 0 && dh.Rating > 0 {
				meta.Rating = dh.Rating
			}
			if meta.Poster == "" && dh.Poster != "" {
				meta.Poster = dh.Poster
			}
			if artURL == "" {
				artURL = dh.Poster
			}
			if provider == "" {
				provider = "豆瓣"
			}
		}
	}
	if meta.Poster == "" && artURL != "" {
		meta.Poster = artURL
	}
	if meta.Overview == "" && meta.Rating <= 0 && meta.Poster == "" {
		return meta, "", provider, errors.New("刮削无有效结果")
	}
	return meta, artURL, provider, nil
}

// nfoQueryFromPath 从路径推断（片名, 年份, 类型）。
func nfoQueryFromPath(lib Library, mediaPath string, local localMediaMetadata) (string, string, string) {
	if lib.Type == "series" {
		if e := plexParseRel(mediaPath); e != nil && strings.TrimSpace(e.ShowTitle) != "" {
			return plexCleanStem(e.ShowTitle), strings.TrimSpace(e.ShowYear), "tv"
		}
		if t := strings.TrimSpace(local.ShowTitle); t != "" {
			return t, strings.TrimSpace(local.Year), "tv"
		}
	}
	if t := strings.TrimSpace(local.Title); t != "" {
		return t, strings.TrimSpace(local.Year), "movie"
	}
	stem := strings.TrimSuffix(filepath.Base(mediaPath), filepath.Ext(mediaPath))
	return parseMovieStem(stem)
}

var movieYearRe = regexp.MustCompile(`(?i)(?:^|[\s._\-\(\[])((?:19|20)\d{2})(?:[\s._\-\)\]]|$)`)

// parseMovieStem 从电影文件名解析（片名, 年份）。
func parseMovieStem(stem string) (string, string, string) {
	s := plexStripBrackets(stem)
	s = strings.ReplaceAll(s, "_", " ")
	s = strings.ReplaceAll(s, ".", " ")
	s = plexSepRe.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	year := ""
	if m := movieYearRe.FindStringSubmatchIndex(s); m != nil {
		year = s[m[2]:m[3]]
		s = strings.TrimSpace(s[:m[0]])
	}
	s = plexNoiseRe.ReplaceAllString(s, " ")
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", year, "movie"
	}
	return s, year, "movie"
}

/* ---------- TMDB ---------- */

type nfoTMDBResult struct {
	ID           int     `json:"id"`
	Title        string  `json:"title"`
	Name         string  `json:"name"`
	OriginalName string  `json:"original_name"`
	Original     string  `json:"original_title"`
	ReleaseDate  string  `json:"release_date"`
	FirstAir     string  `json:"first_air_date"`
	Overview     string  `json:"overview"`
	Vote         float64 `json:"vote_average"`
	PosterPath   string  `json:"poster_path"`
	Backdrop     string  `json:"backdrop_path"`
	Runtime      int     `json:"runtime"`
	Genres       []struct {
		Name string `json:"name"`
	} `json:"genres"`
	Credits struct {
		Cast []struct {
			Name      string `json:"name"`
			Character string `json:"character"`
		} `json:"cast"`
	} `json:"credits"`
}

func (a *App) nfoTMDBLookup(ctx context.Context, kind, title, year string) (nfoWriteMeta, error) {
	a.mu.RLock()
	key, base, proxy := a.tmdbAPIKey, a.tmdbAPIBase, a.scraperProxy
	a.mu.RUnlock()
	if strings.TrimSpace(key) == "" {
		return nfoWriteMeta{}, errors.New("tmdb not configured")
	}
	if base == "" {
		base = "https://api.themoviedb.org"
	}
	tr, err := safeTransport(proxy)
	if err != nil {
		return nfoWriteMeta{}, err
	}
	client := &http.Client{Transport: tr, Timeout: 20 * time.Second}
	endpoint := "movie"
	if kind == "tv" {
		endpoint = "tv"
	}
	searchURL := strings.TrimSuffix(base, "/") + "/3/search/" + endpoint + "?language=zh-CN&query=" + url.QueryEscape(title)
	if year != "" {
		if kind == "tv" {
			searchURL += "&first_air_date_year=" + url.QueryEscape(year)
		} else {
			searchURL += "&year=" + url.QueryEscape(year)
		}
	}
	var list struct {
		Results []nfoTMDBResult `json:"results"`
	}
	if err := a.tmdbGetJSON(ctx, client, key, searchURL, &list); err != nil {
		return nfoWriteMeta{}, err
	}
	if len(list.Results) == 0 {
		return nfoWriteMeta{}, errors.New("tmdb: no result")
	}
	best := list.Results[0]
	want := doubanNormTitle(title)
	for _, r := range list.Results {
		name := r.Title
		if kind == "tv" {
			name = r.Name
		}
		if doubanNormTitle(name) == want {
			best = r
			break
		}
	}
	detailURL := strings.TrimSuffix(base, "/") + "/3/" + endpoint + "/" + strconv.Itoa(best.ID) +
		"?language=zh-CN&append_to_response=credits"
	var detail nfoTMDBResult
	if err := a.tmdbGetJSON(ctx, client, key, detailURL, &detail); err == nil && detail.ID != 0 {
		best = detail
	}
	meta := nfoWriteMeta{
		TMDBID:    strconv.Itoa(best.ID),
		Overview:  strings.TrimSpace(best.Overview),
		Rating:    best.Vote,
		Runtime:   best.Runtime,
		Poster:    tmdbImageURL(best.PosterPath),
		Fanart:    tmdbImageURL(best.Backdrop),
		Backdrop:  tmdbImageURL(best.Backdrop),
		Genres:    []string{},
		Cast:      []localMetadataCast{},
		ImageBase: "https://image.tmdb.org/t/p/original",
	}
	if kind == "tv" {
		meta.Title = strings.TrimSpace(best.Name)
		meta.ShowTitle = meta.Title
		if len(best.FirstAir) >= 4 {
			meta.Year = best.FirstAir[:4]
			meta.Premiered = best.FirstAir
		}
	} else {
		meta.Title = strings.TrimSpace(best.Title)
		if len(best.ReleaseDate) >= 4 {
			meta.Year = best.ReleaseDate[:4]
			meta.Premiered = best.ReleaseDate
		}
	}
	for _, g := range best.Genres {
		if g.Name != "" {
			meta.Genres = append(meta.Genres, g.Name)
		}
	}
	for _, c := range best.Credits.Cast {
		if c.Name == "" {
			continue
		}
		meta.Cast = append(meta.Cast, localMetadataCast{Name: c.Name, Character: c.Character})
		if len(meta.Cast) >= 15 {
			break
		}
	}
	return meta, nil
}

func tmdbImageURL(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if strings.HasPrefix(p, "http://") || strings.HasPrefix(p, "https://") {
		return p
	}
	return "https://image.tmdb.org/t/p/w780" + p
}

func (a *App) tmdbGetJSON(ctx context.Context, client *http.Client, key, rawURL string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	// v3 API Key 与 v4 Read Token 两种形态都要支持（同 /api/media/tmdb 的处理）。
	if strings.Count(key, ".") == 2 && strings.HasPrefix(key, "eyJ") {
		req.Header.Set("Authorization", "Bearer "+key)
	} else {
		q := req.URL.Query()
		q.Set("api_key", key)
		req.URL.RawQuery = q.Encode()
	}
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("tmdb HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out)
}

/* ---------- 海报下载 ---------- */

/* artworkUserAgent：图片站（豆瓣 / TMDB 镜像）对非浏览器 UA 会直接回 418/403。
   实测 https://img9.doubanio.com/... 用 "VaultHub/..." 取到 418，换成浏览器 UA 立刻 200。
   海报下载必须带 Referer + 浏览器 UA，否则「刮削成功但图存不下来」。 */
const artworkUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/* artworkCandidateURLs：豆瓣图床按分片（img1..img9）做反爬 —— 实测同一个
   public id，img9 分片对 Go 客户端返回 JS 校验页（200 + text/html），img1/img2
   直接给 JPEG。海报下载因此要按分片轮询，命中图片魔数才算成功。 */
var doubanImgShardRe = regexp.MustCompile(`^(https?://)img\d+\.doubanio\.com(/.*)$`)

func artworkCandidateURLs(raw string) []string {
	raw = strings.TrimSpace(raw)
	out := []string{raw}
	if m := doubanImgShardRe.FindStringSubmatch(raw); m != nil {
		for _, shard := range []string{"img1", "img2", "img3", "img9", "img5", "img8"} {
			cand := m[1] + shard + ".doubanio.com" + m[2]
			dup := false
			for _, x := range out {
				if x == cand {
					dup = true
					break
				}
			}
			if !dup {
				out = append(out, cand)
			}
		}
	}
	return out
}

// fetchArtworkBytes 下载图片并按魔数校验；分片反爬时自动换分片重试。
func (a *App) fetchArtworkBytes(ctx context.Context, rawURL string) ([]byte, string, error) {
	client, err := a.coverDownloadClient()
	if err != nil {
		return nil, "", err
	}
	lastErr := errors.New("artwork download failed")
	for _, cand := range artworkCandidateURLs(rawURL) {
		u, perr := url.Parse(cand)
		if perr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
			lastErr = errors.New("invalid artwork url")
			continue
		}
		if err := coverTargetGuard(ctx, u); err != nil {
			lastErr = err
			continue
		}
		req, rerr := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if rerr != nil {
			lastErr = rerr
			continue
		}
		req.Header.Set("User-Agent", artworkUserAgent)
		req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
		req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
		req.Header.Set("Referer", "https://movie.douban.com/")
		res, derr := client.Do(req)
		if derr != nil {
			lastErr = derr
			continue
		}
		body, berr := io.ReadAll(io.LimitReader(res.Body, coverDownloadMaxBytes+1))
		res.Body.Close()
		if berr != nil {
			lastErr = berr
			continue
		}
		if res.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("artwork HTTP %d", res.StatusCode)
			continue
		}
		if len(body) > coverDownloadMaxBytes {
			lastErr = errors.New("artwork exceeds 20 MiB")
			continue
		}
		if ext := sniffImageExt(body); ext != "" {
			return body, ext, nil
		}
		lastErr = errors.New("artwork is not jpeg/png/webp/gif")
	}
	return nil, "", lastErr
}

// artworkSidecarName 生成 sidecar 文件名：<媒体名>-<role>.<ext>。
func artworkSidecarName(mediaBase, role, ext string) string {
	stem := mediaBase
	if i := strings.LastIndexByte(stem, '.'); i > 0 {
		stem = stem[:i]
	}
	return stem + "-" + role + "." + ext
}

// nfoDownloadArt 把远程图下载为 <文件名>-<role>.<ext>（读取端 local_metadata 认这个名字）。
func (a *App) nfoDownloadArt(lib Library, mediaPath, role, rawURL string) (string, error) {
	if role != "poster" && role != "fanart" && role != "backdrop" && role != "logo" {
		return "", errors.New("invalid artwork role")
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", errors.New("invalid artwork url")
	}
	abs, _, err := safeFile(lib, mediaPath)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(abs)
	stem := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	for _, ext := range []string{".jpg", ".png", ".webp"} {
		if fileExists(filepath.Join(dir, stem+"-"+role+ext)) {
			return "", errors.New("artwork exists")
		}
	}
	data, ext, err := a.fetchArtworkBytes(context.Background(), rawURL)
	if err != nil {
		return "", err
	}
	// sidecar 必须带扩展名点：<文件名>-poster.jpg（读取端候选名就是这个形态）。
	dest := filepath.Join(dir, artworkSidecarName(filepath.Base(abs), role, ext))
	if filepath.Dir(dest) != dir {
		return "", errors.New("invalid artwork path")
	}
	tmp, err := os.CreateTemp(dir, ".vault-art-*.tmp")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err = tmp.Chmod(0644); err == nil {
		_, err = tmp.Write(data)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if err = os.Rename(tmpName, dest); err != nil {
		return "", err
	}
	return indexRelFor(lib, dest), nil
}
