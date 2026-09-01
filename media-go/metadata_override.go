package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type mediaMetadataOverride struct {
	Poster   string   `json:"poster,omitempty"`
	Logo     string   `json:"logo,omitempty"`
	Fanart   string   `json:"fanart,omitempty"`
	Backdrop string   `json:"backdrop,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	Watched  bool     `json:"watched,omitempty"`
}

func overrideKey(libID, mediaPath string) string {
	return libID + "\n" + filepath.ToSlash(filepath.Clean(mediaPath))
}

func (a *App) loadMetadataOverrides() map[string]mediaMetadataOverride {
	out := map[string]mediaMetadataOverride{}
	if a.metadataOverrides == "" {
		return out
	}
	b, err := os.ReadFile(a.metadataOverrides)
	if err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func (a *App) saveMetadataOverrides(all map[string]mediaMetadataOverride) error {
	if a.metadataOverrides == "" {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(filepath.Dir(a.metadataOverrides), 0755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(a.metadataOverrides), ".metadata-overrides-*.tmp")
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
	return os.Rename(tmp, a.metadataOverrides)
}

func validArtworkValue(lib Library, raw string) bool {
	if raw == "" {
		return true
	}
	if strings.HasPrefix(raw, "/api/media/file?") {
		u, err := url.Parse(raw)
		if err != nil || u.Path != "/api/media/file" || u.Query().Get("id") != lib.ID {
			return false
		}
		p := u.Query().Get("path")
		if p == "" {
			return false
		}
		_, _, err = safeFile(lib, p)
		return err == nil && isArtworkFile(p)
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil && len(raw) <= 2048
}

func isArtworkFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif":
		return true
	}
	return false
}

func sanitizeOverride(lib Library, in mediaMetadataOverride) (mediaMetadataOverride, error) {
	for _, raw := range []string{in.Poster, in.Logo, in.Fanart, in.Backdrop} {
		if !validArtworkValue(lib, strings.TrimSpace(raw)) {
			return in, os.ErrInvalid
		}
	}
	in.Poster, in.Logo, in.Fanart, in.Backdrop = strings.TrimSpace(in.Poster), strings.TrimSpace(in.Logo), strings.TrimSpace(in.Fanart), strings.TrimSpace(in.Backdrop)
	seen, tags := map[string]bool{}, []string{}
	for _, tag := range in.Tags {
		tag = strings.TrimSpace(tag)
		if tag != "" && len([]rune(tag)) <= 32 && !seen[tag] && len(tags) < 20 {
			seen[tag] = true
			tags = append(tags, tag)
		}
	}
	in.Tags = tags
	return in, nil
}

func (a *App) metadataOverride(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodPut {
		errJSON(w, 405, "method not allowed")
		return
	}
	lib, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	mediaPath := r.URL.Query().Get("path")
	if _, _, err := safeFile(lib, mediaPath); err != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	var in mediaMetadataOverride
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&in); err != nil {
		errJSON(w, 400, "invalid metadata override")
		return
	}
	in, err := sanitizeOverride(lib, in)
	if err != nil {
		errJSON(w, 400, "invalid artwork URL or media path")
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	all := a.loadMetadataOverrides()
	all[overrideKey(lib.ID, mediaPath)] = in
	if err := a.saveMetadataOverrides(all); err != nil {
		errJSON(w, 500, "metadata override save failed")
		return
	}
	writeJSON(w, 200, in)
}

func (a *App) mergeMetadataOverride(lib Library, mediaPath string, m *localMediaMetadata) {
	in, ok := a.loadMetadataOverrides()[overrideKey(lib.ID, mediaPath)]
	if !ok {
		return
	}
	if in.Poster != "" {
		m.Poster = in.Poster
	}
	if in.Logo != "" {
		m.Logo = in.Logo
	}
	if in.Fanart != "" {
		m.Fanart = in.Fanart
	}
	if in.Backdrop != "" {
		m.Backdrop = in.Backdrop
	}
	m.Tags, m.Watched = in.Tags, in.Watched
}

func (a *App) artworkCandidates(w http.ResponseWriter, r *http.Request) {
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
	p, _, err := safeFile(lib, r.URL.Query().Get("path"))
	if err != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	entries, err := os.ReadDir(filepath.Dir(p))
	if err != nil {
		errJSON(w, 500, "artwork list failed")
		return
	}
	items := []map[string]string{}
	for _, entry := range entries {
		if entry.IsDir() || !isArtworkFile(entry.Name()) {
			continue
		}
		abs := filepath.Join(filepath.Dir(p), entry.Name())
		rel, err := filepath.Rel(lib.Path, abs)
		if err != nil {
			continue
		}
		if _, _, err = safeFile(lib, rel); err != nil {
			continue
		}
		items = append(items, map[string]string{"name": entry.Name(), "url": mediaAssetURL(lib.ID, rel)})
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["name"] < items[j]["name"] })
	writeJSON(w, 200, map[string]any{"items": items})
}
