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
	rel, e := filepath.Rel(lib.Path, abs)
	if e != nil {
		return ""
	}
	if _, _, e = safeFile(lib, rel); e != nil {
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
			rel, _ := filepath.Rel(lib.Path, nfo)
			m.NFO = filepath.ToSlash(rel)
		}
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
		rel, _ := filepath.Rel(lib.Path, abs)
		m.Subtitles = append(m.Subtitles, localMetadataSubtitle{Label: "本地 · " + x.Name(), Language: subtitleLanguage(x.Name(), stem), URL: "/api/media/subtitles/proxy?id=" + url.QueryEscape(lib.ID) + "&path=" + url.QueryEscape(filepath.ToSlash(rel))})
	}
	return m, nil
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
