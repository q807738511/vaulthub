package main

import (
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
}
type localMetadataSubtitle struct {
	Label    string `json:"label"`
	Language string `json:"language"`
	URL      string `json:"url"`
}
type localMediaMetadata struct {
	Title     string                  `json:"title,omitempty"`
	ShowTitle string                  `json:"show_title,omitempty"`
	Year      string                  `json:"year,omitempty"`
	Overview  string                  `json:"overview,omitempty"`
	Runtime   int                     `json:"runtime,omitempty"`
	Rating    float64                 `json:"rating,omitempty"`
	Genres    []string                `json:"genres"`
	Cast      []localMetadataCast     `json:"cast"`
	TMDBID    string                  `json:"tmdb_id,omitempty"`
	TVDBID    string                  `json:"tvdb_id,omitempty"`
	Poster    string                  `json:"poster,omitempty"`
	Logo      string                  `json:"logo,omitempty"`
	Fanart    string                  `json:"fanart,omitempty"`
	Backdrop  string                  `json:"backdrop,omitempty"`
	Tags      []string                `json:"tags,omitempty"`
	Watched   bool                    `json:"watched,omitempty"`
	Subtitles []localMetadataSubtitle `json:"subtitles"`
	Provider  string                  `json:"provider"`
	NFO       string                  `json:"nfo,omitempty"`
}
type nfoActor struct {
	Name string `xml:"name"`
	Role string `xml:"role"`
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
	var doc nfoDocument
	if nfo != "" {
		f, e := os.Open(nfo)
		if e == nil {
			e = xml.NewDecoder(io.LimitReader(f, 2<<20)).Decode(&doc)
			f.Close()
		}
		if e == nil {
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
			for _, a := range doc.Actors {
				if strings.TrimSpace(a.Name) != "" {
					m.Cast = append(m.Cast, localMetadataCast{Name: strings.TrimSpace(a.Name), Character: strings.TrimSpace(a.Role)})
				}
			}
			for _, id := range doc.UniqueIDs {
				switch strings.ToLower(strings.TrimSpace(id.Type)) {
				case "tmdb":
					m.TMDBID = strings.TrimSpace(id.Value)
				case "tvdb":
					m.TVDBID = strings.TrimSpace(id.Value)
				}
			}
			rel := indexRelFor(lib, nfo)
			m.NFO = filepath.ToSlash(rel)
		}
	}
	// series：单集 nfo 里常见只给 show 名（<showtitle>），标题留空时用 show 名回填，
	// 保证剧集列表行始终有可读标题，而不只是“S01E01”。
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

// seriesShowDirs walks from the episode's own directory up to (but excluding)
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
