package main

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type localMetadataCast struct {
	Name      string `json:"name"`
	Character string `json:"character"`
	/* v0.9.98：演职人员头像。本地 NFO（tinyMediaManager / Emby / Jellyfin 写的
	   `<actor><thumb>`）里通常是 TMDB 图片地址或 .actors/ 目录下的本地文件，
	   这里统一转成**可直接放进 <img src> 的地址**（TMDB 走 /api/media/cast/avatar?person=，
	   本地文件走 /api/media/cast/avatar?id=&path=），前端不必再判断来源。
	   AvatarThumb 保留原始值，写 NFO 时原样回填。 */
	Avatar      string `json:"avatar,omitempty"`
	AvatarKind  string `json:"avatar_kind,omitempty"` // tmdb / local / remote
	AvatarThumb string `json:"avatar_thumb,omitempty"`
}
type localMetadataSubtitle struct {
	Label    string `json:"label"`
	Language string `json:"language"`
	URL      string `json:"url"`
}
type localMediaMetadata struct {
	Title      string              `json:"title,omitempty"`
	ShowTitle  string              `json:"show_title,omitempty"`
	Year       string              `json:"year,omitempty"`
	Overview   string              `json:"overview,omitempty"`
	Runtime    int                 `json:"runtime,omitempty"`
	Rating     float64             `json:"rating,omitempty"`
	UserRating float64             `json:"user_rating,omitempty"`
	Genres     []string            `json:"genres"`
	Cast       []localMetadataCast `json:"cast"`
	TMDBID     string              `json:"tmdb_id,omitempty"`
	TVDBID     string              `json:"tvdb_id,omitempty"`
	/* v1.0.2（需求2/演职人员全量修复）：剧集级（show 级）字段 —— 单集 NFO 里
	   只有分集信息与「分集自己的 tmdbid」（例如 1019299 是第 1 集的 id），
	   拿它去查剧集详情/推荐必然查错片子。这里把剧名根目录 tvshow.nfo 的
	   剧集级 ID 单独带出来，前端查演职人员与推荐时优先用它。 */
	ShowTMDBID string `json:"show_tmdb_id,omitempty"`
	ShowTVDBID string `json:"show_tvdb_id,omitempty"`
	/* 剧名的来源：season-nfo / tvshow-nfo / folder。前端据此判断「本地 NFO 的
	   剧名」是否可用（本地优先），避免历史刮削写错的剧名（例如东京喰种被写成
	   别的片名）继续把演职人员/推荐带偏。 */
	ShowTitleSource string                  `json:"show_title_source,omitempty"`
	EpisodeTMDBID   string                  `json:"episode_tmdb_id,omitempty"`
	Poster          string                  `json:"poster,omitempty"`
	Logo            string                  `json:"logo,omitempty"`
	Fanart          string                  `json:"fanart,omitempty"`
	Backdrop        string                  `json:"backdrop,omitempty"`
	Tags            []string                `json:"tags,omitempty"`
	Watched         bool                    `json:"watched,omitempty"`
	Subtitles       []localMetadataSubtitle `json:"subtitles"`
	Provider        string                  `json:"provider"`
	NFO             string                  `json:"nfo,omitempty"`
}
type nfoActor struct {
	Name  string `xml:"name"`
	Role  string `xml:"role"`
	Thumb string `xml:"thumb,omitempty"`
}
type nfoThumb struct {
	Aspect string `xml:"aspect,attr"`
	Value  string `xml:",chardata"`
}
type nfoUniqueID struct {
	Type  string `xml:"type,attr"`
	Value string `xml:",chardata"`
}
type nfoDocument struct {
	Title        string        `xml:"title"`
	ShowTitle    string        `xml:"showtitle"`
	Year         string        `xml:"year"`
	Premiered    string        `xml:"premiered"`
	Plot         string        `xml:"plot"`
	Outline      string        `xml:"outline"`
	Runtime      string        `xml:"runtime"`
	Rating       string        `xml:"rating"`
	Genres       []string      `xml:"genre"`
	Actors       []nfoActor    `xml:"actor"`
	UniqueIDs    []nfoUniqueID `xml:"uniqueid"`
	Thumbs       []nfoThumb    `xml:"thumb"`
	FanartThumbs []string      `xml:"fanart>thumb"`
	/* v1.0.2：刮削器（tinyMediaManager / MoviePilot / Emby）写的 NFO 里
	   ID 有两种写法并存：`<uniqueid type="tmdb">` 与直接的 `<tmdbid>` /
	   `<tvdbid>`。旧实现只读 uniqueid，tvshow.nfo 只写 <tmdbid> 时剧集级 ID
	   就丢了（前端拿不到 <tmdbid>61374</tmdbid>，只能退回分集 id 去查，必然查错）。 */
	TMDBID string `xml:"tmdbid"`
	TVDBID string `xml:"tvdbid"`
	IMDBID string `xml:"imdbid"`
}

// indexRelFor maps an absolute path back to the indexed rel path the files API
// and playback expect. Single-path library → rel to lib.Path (no prefix, the
// v0.9.30 contract). Multi-path library (Paths non-empty) → the root-prefixed
// form "<root-base>/<rel-to-root>" that walkMultiLibraryFiles emits and safeFile
// resolves, so artwork / subtitle URLs keep working for files on extra volumes.
func indexRelFor(lib Library, abs string) string {
	abs, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return ""
	}
	multi := len(lib.AllPaths()) > 1
	for _, root := range lib.AllPaths() {
		rootReal, e := filepath.EvalSymlinks(root)
		if e != nil {
			continue
		}
		rel, e := filepath.Rel(rootReal, abs)
		if e != nil || rel == "." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || rel == ".." {
			continue
		}
		rel = filepath.ToSlash(rel)
		if multi {
			rel = filepath.Base(rootReal) + "/" + rel
		}
		return rel
	}
	return ""
}
func mediaAssetURL(libID, rel string) string {
	return "/api/media/file?id=" + url.QueryEscape(libID) + "&path=" + url.QueryEscape(filepath.ToSlash(rel))
}
func firstExistingFile(dir string, names []string) string {
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || filepath.IsAbs(name) || strings.Contains(name, "..") {
			continue
		}
		p := filepath.Join(dir, filepath.FromSlash(name))
		if st, e := os.Stat(p); e == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}
func relativeAssetURL(lib Library, abs string) string {
	if abs == "" {
		return ""
	}
	rel := indexRelFor(lib, abs)
	if rel == "" {
		return ""
	}
	if _, _, e := safeFile(lib, rel); e != nil {
		return ""
	}
	return mediaAssetURL(lib.ID, rel)
}
func subtitleLanguage(name, stem string) string {
	s := strings.TrimSuffix(name, filepath.Ext(name))
	s = strings.TrimPrefix(strings.ToLower(s), strings.ToLower(stem))
	s = strings.TrimLeft(s, ".-_ ")
	if s == "" {
		return "und"
	}
	return s
}

func readLocalMediaMetadata(lib Library, mediaPath string) (localMediaMetadata, error) {
	p, _, err := safeFile(lib, mediaPath)
	if err != nil {
		return localMediaMetadata{}, err
	}
	dir := filepath.Dir(p)
	base := filepath.Base(p)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	m := localMediaMetadata{Genres: []string{}, Cast: []localMetadataCast{}, Subtitles: []localMetadataSubtitle{}, Provider: "本地文件"}
	commonAllowed := true
	if ents, e := os.ReadDir(dir); e == nil {
		mediaCount := 0
		for _, x := range ents {
			if !x.IsDir() && map[string]bool{".mp4": true, ".mkv": true, ".avi": true, ".mov": true, ".m4v": true, ".webm": true, ".ts": true, ".m2ts": true}[strings.ToLower(filepath.Ext(x.Name()))] {
				mediaCount++
			}
		}
		commonAllowed = mediaCount == 1
	}
	nfoNames := []string{stem + ".nfo"}
	if commonAllowed {
		nfoNames = append(nfoNames, "movie.nfo")
	}
	// v0.9.52：series 库的单集文件通常位于 Show/Season 01/… 下，剧集级
	// tvshow.nfo 与海报在 Show 根目录。把该目录本身也纳入 nfo 候选，
	// 这样扁平结构（Show 根直接放视频）也能读到 show 级信息。
	if lib.Type == "series" {
		nfoNames = append(nfoNames, "tvshow.nfo")
	}
	nfo := firstExistingFile(dir, nfoNames)
	/* v0.9.99：剧集库的 tvshow.nfo 放在「剧名根目录」，而单集通常在 Season NN/ 子目录中，
	   旧实现只在本集目录里找 nfo，于是永远读不到 show 级 NFO —— 演职人员、评分、tmdbid
	   全为空（用户可见症状：本地明明有 NFO，却看不到演职人员与相关推荐）。
	   这里复用 seriesShowDirs 逐级向上回溯到剧名根目录补找 tvshow.nfo / movie.nfo。 */
	if nfo == "" && lib.Type == "series" {
		for _, showDir := range seriesShowDirs(lib, dir) {
			if cand := firstExistingFile(showDir, []string{"tvshow.nfo", "movie.nfo"}); cand != "" {
				nfo = cand
				break
			}
		}
	}
	var doc nfoDocument
	if nfo != "" {
		doc, _ = parseNFODocument(nfo)
		if true {
			m.Provider = "本地 NFO"
			m.Title = strings.TrimSpace(doc.Title)
			m.ShowTitle = strings.TrimSpace(doc.ShowTitle)
			m.Year = strings.TrimSpace(doc.Year)
			if m.Year == "" && len(doc.Premiered) >= 4 {
				m.Year = doc.Premiered[:4]
			}
			m.Overview = strings.TrimSpace(doc.Plot)
			if m.Overview == "" {
				m.Overview = strings.TrimSpace(doc.Outline)
			}
			m.Runtime, _ = strconv.Atoi(strings.TrimSpace(doc.Runtime))
			m.Rating, _ = strconv.ParseFloat(strings.TrimSpace(doc.Rating), 64)
			for _, g := range doc.Genres {
				if g = strings.TrimSpace(g); g != "" {
					m.Genres = append(m.Genres, g)
				}
			}
			m.Cast = append(m.Cast, nfoCastEntries(lib, filepath.Dir(nfo), doc.Actors)...)
			for _, id := range doc.UniqueIDs {
				switch strings.ToLower(strings.TrimSpace(id.Type)) {
				case "tmdb":
					m.TMDBID = strings.TrimSpace(id.Value)
				case "tvdb":
					m.TVDBID = strings.TrimSpace(id.Value)
				}
			}
			/* v1.0.2：部分刮削器只写 <tmdbid>/<tvdbid>（没有 <uniqueid>）——
			   旧实现只认 uniqueid，这类 NFO 的 ID 就丢了。这里补一次兜底。 */
			if strings.TrimSpace(m.TMDBID) == "" {
				m.TMDBID = strings.TrimSpace(doc.TMDBID)
			}
			if strings.TrimSpace(m.TVDBID) == "" {
				m.TVDBID = strings.TrimSpace(doc.TVDBID)
			}
			rel := indexRelFor(lib, nfo)
			m.NFO = filepath.ToSlash(rel)
		}
	}
	// series：单集 nfo 里常见只给 show 名（<showtitle>），标题留空时用 show 名回填，
	// 保证剧集列表行始终有可读标题，而不只是“S01E01”。
	if lib.Type == "series" {
		mergeSeriesShowNFO(lib, dir, &m)
	}
	if lib.Type == "series" && m.Title == "" && m.ShowTitle != "" {
		m.Title = m.ShowTitle
	}
	posterNames := []string{stem + "-poster.png", stem + "-poster.jpg", stem + ".png", stem + ".jpg", "poster.png", "poster.jpg", "folder.png", "folder.jpg", "cover.png", "cover.jpg"}
	logoNames := []string{stem + "-logo.png", stem + "-logo.webp", "logo.png", "logo.webp"}
	fanartNames := []string{stem + "-fanart.jpg", stem + "-fanart.png", "fanart.jpg", "fanart.png"}
	backdropNames := []string{stem + "-backdrop.jpg", stem + "-backdrop.png", "backdrop.jpg", "backdrop.png"}
	if !commonAllowed {
		posterNames = posterNames[:2]
		logoNames = logoNames[:2]
		fanartNames = fanartNames[:2]
		backdropNames = backdropNames[:2]
	}
	for _, th := range doc.Thumbs {
		if strings.EqualFold(th.Aspect, "poster") || th.Aspect == "" {
			posterNames = append([]string{strings.TrimSpace(th.Value)}, posterNames...)
		}
	}
	fanartNames = append(doc.FanartThumbs, fanartNames...)
	m.Poster = relativeAssetURL(lib, firstExistingFile(dir, posterNames))
	m.Logo = relativeAssetURL(lib, firstExistingFile(dir, logoNames))
	m.Fanart = relativeAssetURL(lib, firstExistingFile(dir, fanartNames))
	m.Backdrop = relativeAssetURL(lib, firstExistingFile(dir, backdropNames))
	if m.Backdrop == "" {
		m.Backdrop = m.Fanart
	}
	// v0.9.52 T4：series 单集在 Season 01/ 子目录时，海报/剧照/logo 常放在
	// 剧集根目录（Show/）而非单集目录。逐级向上回溯到库根，缺啥补啥；
	// 扩展存储路径同样生效（indexRelFor 会把绝对路径映射回带前缀的索引路径）。
	// 注意：不能复用上面被 commonAllowed 截断的 stem 优先列表 —— 剧集根目录
	// 下是通用名（poster.jpg / fanart.jpg …），用独立的 show 级名称集合查找。
	if lib.Type == "series" {
		showPosterNames := []string{"poster.png", "poster.jpg", "folder.png", "folder.jpg", "cover.png", "cover.jpg", "show.png", "show.jpg", "season01-poster.jpg", "default.png", "default.jpg"}
		showLogoNames := []string{"logo.png", "logo.webp"}
		showFanartNames := []string{"fanart.jpg", "fanart.png", "show-fanart.jpg", "backdrop.jpg"}
		showBackdropNames := []string{"backdrop.jpg", "backdrop.png", "fanart.jpg", "fanart.png"}
		for _, showDir := range seriesShowDirs(lib, dir) {
			if m.Poster == "" {
				m.Poster = relativeAssetURL(lib, firstExistingFile(showDir, showPosterNames))
			}
			if m.Logo == "" {
				m.Logo = relativeAssetURL(lib, firstExistingFile(showDir, showLogoNames))
			}
			if m.Fanart == "" {
				m.Fanart = relativeAssetURL(lib, firstExistingFile(showDir, showFanartNames))
			}
			if m.Backdrop == "" {
				m.Backdrop = relativeAssetURL(lib, firstExistingFile(showDir, showBackdropNames))
			}
			if m.Backdrop == "" {
				m.Backdrop = m.Fanart
			}
		}
	}
	ents, _ := os.ReadDir(dir)
	for _, x := range ents {
		if x.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(x.Name()))
		if !map[string]bool{".srt": true, ".vtt": true, ".ass": true, ".ssa": true, ".sub": true}[ext] {
			continue
		}
		lower := strings.ToLower(x.Name())
		if !strings.HasPrefix(lower, strings.ToLower(stem)+".") && !strings.HasPrefix(lower, strings.ToLower(stem)+"-") {
			continue
		}
		abs := filepath.Join(dir, x.Name())
		rel := indexRelFor(lib, abs)
		if rel == "" {
			continue
		}
		m.Subtitles = append(m.Subtitles, localMetadataSubtitle{Label: "本地 · " + x.Name(), Language: subtitleLanguage(x.Name(), stem), URL: "/api/media/subtitles/proxy?id=" + url.QueryEscape(lib.ID) + "&path=" + url.QueryEscape(filepath.ToSlash(rel))})
	}
	return m, nil
}

/*
v1.0.2（需求2）：NFO 解析抽成独立函数 —— 单集 NFO 之外还要读季目录的

	season.nfo 与剧名根目录的 tvshow.nfo。上限 2 MB，解析失败返回 false（不报错，
	本地 NFO 只是「有则优先」的增强项）。
*/
func parseNFODocument(path string) (nfoDocument, bool) {
	var doc nfoDocument
	f, e := os.Open(path)
	if e != nil {
		return doc, false
	}
	defer f.Close()
	if e = xml.NewDecoder(io.LimitReader(f, 2<<20)).Decode(&doc); e != nil {
		return doc, false
	}
	return doc, true
}

/* v1.0.2（需求2）：NFO 演员表 -> 可直接渲染的演职人员条目。 */
func nfoCastEntries(lib Library, nfoDir string, actors []nfoActor) []localMetadataCast {
	out := make([]localMetadataCast, 0, len(actors))
	for _, a := range actors {
		name := strings.TrimSpace(a.Name)
		if name == "" {
			continue
		}
		/* v0.9.99：show 级 NFO 里的相对头像（.actors/x.jpg）要相对 NFO 所在目录解析。 */
		avatar, kind, raw := localCastAvatar(lib, nfoDir, strings.TrimSpace(a.Thumb))
		out = append(out, localMetadataCast{Name: name, Character: strings.TrimSpace(a.Role), Avatar: avatar, AvatarKind: kind, AvatarThumb: raw})
	}
	return out
}

/*
v1.0.2（需求2）：剧集库的「剧名 / 剧集级 ID / 演职人员」以剧名根目录的

	tvshow.nfo（必要时 season.nfo）为准。
	旧实现的缺口：单集位于 Season 01/ 下且存在分集 NFO 时，只读分集 NFO 就不再向上
	找 tvshow.nfo —— 而 <episodedetails> 里根本没有 <actor>，于是「本地明明有 NFO，
	剧集详情却看不到演职人员」（用户反馈「部分可以展示、部分无法展示」）。
	这里对剧集库无条件补一次 show 级 NFO：
	  1. season.nfo 的 <title> 优先当剧名（tinyMediaManager / MoviePilot 的季 NFO
	     写的是剧名），但「Season 1 / 第1季 / Specials」这类季标记要排除；
	  2. tvshow.nfo 提供演职人员（本集 NFO 没有演员时补入）、剧集级 TMDB/TVDB ID、
	     以及剧名/年份/类型/简介的兜底；
	  3. 都没有时用剧名目录名兜底（plexParseShowDir 会去掉年份与方括号）。
	剧名一律不覆盖已有值（本集 NFO 的 <showtitle> 更精确时保留），并在
	ShowTitleSource 里记录来源，供前端「本地 NFO 优先」的判断使用。
*/
func mergeSeriesShowNFO(lib Library, dir string, m *localMediaMetadata) {
	if m == nil {
		return
	}
	dirs := append([]string{dir}, seriesShowDirs(lib, dir)...)
	if strings.TrimSpace(m.TMDBID) != "" && strings.TrimSpace(m.ShowTMDBID) == "" {
		m.EpisodeTMDBID = strings.TrimSpace(m.TMDBID)
	}
	/* 本集目录里没有 NFO、主 NFO 恰好就是剧集级 tvshow.nfo（扁平结构）时，
	   剧名/<showtitle> 本来就来自剧集级 NFO —— 来源标成 tvshow-nfo，前端不必再猜。 */
	if lower := strings.ToLower(strings.TrimSpace(m.NFO)); strings.HasSuffix(lower, "tvshow.nfo") || strings.HasSuffix(lower, "movie.nfo") {
		if strings.TrimSpace(m.ShowTitle) != "" && strings.TrimSpace(m.ShowTitleSource) == "" {
			m.ShowTitleSource = "tvshow-nfo"
		}
	}
	// 1) season.nfo（季目录内）
	if m.ShowTitle == "" {
		for _, d := range dirs {
			if _, isSeason := plexParseSeasonDir(filepath.Base(d)); !isSeason {
				continue
			}
			cand := firstExistingFile(d, []string{"season.nfo"})
			if cand == "" {
				continue
			}
			doc, ok := parseNFODocument(cand)
			if !ok {
				break
			}
			if t := strings.TrimSpace(doc.Title); t != "" && !seasonMarkerTitle(t) {
				m.ShowTitle = t
				m.ShowTitleSource = "season-nfo"
			}
			if m.Overview == "" {
				if o := strings.TrimSpace(doc.Plot); o != "" {
					m.Overview = o
				}
			}
			break
		}
	}
	// 2) tvshow.nfo（剧名根目录）
	for _, d := range seriesShowDirs(lib, dir) {
		cand := firstExistingFile(d, []string{"tvshow.nfo", "movie.nfo"})
		if cand == "" || cand == m.NFO {
			continue
		}
		doc, ok := parseNFODocument(cand)
		if !ok {
			break
		}
		if len(m.Cast) == 0 {
			m.Cast = nfoCastEntries(lib, filepath.Dir(cand), doc.Actors)
		}
		for _, id := range doc.UniqueIDs {
			switch strings.ToLower(strings.TrimSpace(id.Type)) {
			case "tmdb":
				if m.ShowTMDBID == "" {
					m.ShowTMDBID = strings.TrimSpace(id.Value)
				}
			case "tvdb":
				if m.ShowTVDBID == "" {
					m.ShowTVDBID = strings.TrimSpace(id.Value)
				}
			}
		}
		if m.ShowTMDBID == "" && strings.TrimSpace(doc.TMDBID) != "" {
			m.ShowTMDBID = strings.TrimSpace(doc.TMDBID)
		}
		if m.ShowTVDBID == "" && strings.TrimSpace(doc.TVDBID) != "" {
			m.ShowTVDBID = strings.TrimSpace(doc.TVDBID)
		}
		if m.ShowTitle == "" {
			if t := strings.TrimSpace(doc.Title); t != "" && !seasonMarkerTitle(t) {
				m.ShowTitle = t
				m.ShowTitleSource = "tvshow-nfo"
			}
		}
		if m.Year == "" {
			if y := strings.TrimSpace(doc.Year); y != "" {
				m.Year = y
			} else if len(doc.Premiered) >= 4 {
				m.Year = doc.Premiered[:4]
			}
		}
		if m.Overview == "" {
			if o := strings.TrimSpace(doc.Plot); o != "" {
				m.Overview = o
			}
		}
		if len(m.Genres) == 0 {
			for _, g := range doc.Genres {
				if g = strings.TrimSpace(g); g != "" {
					m.Genres = append(m.Genres, g)
				}
			}
		}
		break
	}
	// 3) 剧名目录兜底
	if m.ShowTitle == "" {
		for _, d := range dirs {
			if _, isSeason := plexParseSeasonDir(filepath.Base(d)); isSeason {
				continue
			}
			if t, _, _ := plexParseShowDir(filepath.Base(d)); strings.TrimSpace(t) != "" {
				m.ShowTitle = strings.TrimSpace(t)
				m.ShowTitleSource = "folder"
				break
			}
		}
	}
	// 4) 剧集级 ID 兜底：分集 NFO 的 tmdbid 是「分集 id」，只有在完全没有 show 级
	//    ID 时才退而求其次（并同时留在 EpisodeTMDBID 里）。
	if m.ShowTMDBID == "" {
		m.ShowTMDBID = ""
	}
}

/* 季标记标题（"Season 3" / "第 1 季" / "Specials"）不能当剧名。 */
func seasonMarkerTitle(t string) bool {
	t = strings.TrimSpace(t)
	if t == "" {
		return true
	}
	if n, ok := plexParseSeasonDir(t); ok && n >= 0 {
		return true
	}
	low := strings.ToLower(t)
	return low == "specials" || low == "特别篇" || low == "花絮"
}

/*
localCastAvatar：把本地 NFO 里 <actor><thumb> 的值换成可直接显示的头像地址。

	三种形态（都实测于常见刮削器的输出）：
	  1. TMDB 图片地址（https://image.tmdb.org/t/p/w500/xxx.jpg）→ 走图片代理
	     /api/media/cast/avatar?person=…，与在线刮削的头像同一条路
	     （浏览器直连 TMDB 会被 CORS/防盗链拦住，代理后稳）；
	  2. `.actors/姓名.jpg` 这类本地文件（Emby / Jellyfin 下载的头像）→ 走本地头像代理
	     /api/media/cast/avatar?id=&path=；
	  3. 其它 http(s) 地址 → 原样返回，交给浏览器。
	返回值第三项是原始 thumb，写回 NFO 时原样保留（不让本地刮削成果被我们改坏）。
*/
func localCastAvatar(lib Library, dir, thumb string) (avatar, kind, raw string) {
	thumb = strings.TrimSpace(thumb)
	if thumb == "" {
		return "", "", ""
	}
	lower := strings.ToLower(thumb)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		if u, err := url.Parse(thumb); err == nil {
			if p := u.Path; strings.HasPrefix(p, "/t/p/") {
				if rest := strings.TrimPrefix(p, "/t/p/"); rest != "" {
					segs := strings.SplitN(rest, "/", 2)
					if len(segs) == 2 && strings.TrimSpace(segs[1]) != "" {
						return "/api/media/cast/avatar?person=" + url.QueryEscape("/"+segs[1]), "tmdb", thumb
					}
				}
			}
		}
		return thumb, "remote", thumb
	}
	abs := thumb
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(dir, filepath.FromSlash(thumb))
	}
	if st, err := os.Stat(abs); err != nil || st.IsDir() {
		return "", "", thumb
	}
	rel := indexRelFor(lib, abs)
	if rel == "" {
		return "", "", thumb
	}
	return "/api/media/cast/avatar?id=" + url.QueryEscape(lib.ID) + "&path=" + url.QueryEscape(filepath.ToSlash(rel)), "local", thumb
}

// seriesShowDirs walks from the episode's own directory up to (but excluding) the media library root,
// the media library root, yielding directories that may hold show/season level
// artwork for a series library. Multi-path libraries are handled through
// AllPaths so extra volumes resolve their own ancestors. v0.9.52：剧集海报/
// 剧照/logo 读取修复 —— 单集在 Season 01/ 下时向 Show 根回溯查找。
func seriesShowDirs(lib Library, startDir string) []string {
	roots := lib.AllPaths()
	realRoots := make([]string, 0, len(roots))
	for _, r := range roots {
		if rr, e := filepath.EvalSymlinks(r); e == nil {
			realRoots = append(realRoots, rr)
		}
	}
	isRoot := func(d string) bool {
		for _, rr := range realRoots {
			if d == rr {
				return true
			}
		}
		return false
	}
	// 找到包含 startDir 的最深 root,作为向上回溯的终点。
	boundary := ""
	for _, rr := range realRoots {
		if withinRoot(startDir, rr) {
			if boundary == "" || len(rr) > len(boundary) {
				boundary = rr
			}
		}
	}
	var dirs []string
	cur := startDir
	for {
		parent := filepath.Dir(cur)
		if parent == cur || isRoot(cur) {
			break
		}
		dirs = append(dirs, parent)
		cur = parent
		if boundary != "" && cur == boundary {
			break
		}
	}
	return dirs
}

/*
v0.9.90：批量本地元数据。

	前端进影视库时原实现对每个文件串行 GET /api/media/metadata —— 1000+ 部剧集就是
	1000+ 次往返，大库进库极慢（用户报告「链接大媒体库后非常慢」）。这里提供一次
	最多 500 条的批量读，前端按 200 条一批，请求数降到个位数。
	结果与单条接口逐字段一致（同一个 readLocalMediaMetadata + 覆盖层合并）。
*/
func (a *App) localMetadataBatch(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	var req struct {
		ID    string   `json:"id"`
		Paths []string `json:"paths"`
	}
	if e := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); e != nil {
		errJSON(w, 400, "invalid json")
		return
	}
	lib, ok := a.find(req.ID)
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	if len(req.Paths) > 500 {
		req.Paths = req.Paths[:500]
	}
	items := make(map[string]any, len(req.Paths))
	for _, path := range req.Paths {
		m, err := readLocalMediaMetadata(lib, path)
		if err != nil {
			continue
		}
		a.mergeMetadataOverride(lib, path, &m)
		items[path] = m
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (a *App) localMetadata(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	lib, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	m, err := readLocalMediaMetadata(lib, r.URL.Query().Get("path"))
	if err != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	a.mergeMetadataOverride(lib, r.URL.Query().Get("path"), &m)
	writeJSON(w, 200, m)
}

var _ = fmt.Sprintf
