package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// VaultHub media API replacement. It deliberately uses only the Go standard library.
type Library struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	Path string `json:"path"`
}
type App struct {
	mu               sync.RWMutex
	libs             []Library
	indexes          map[string][]FileEntry
	jobs             map[string]bool
	tasks            map[string]context.CancelFunc
	config, indexDir string
}
type FileEntry struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func (a *App) load() {
	a.config = env("MEDIA_CONFIG", "/data/media-libraries.json")
	a.indexDir = env("MEDIA_INDEX_DIR", "/data/media-index")
	b, e := os.ReadFile(a.config)
	if e == nil {
		_ = json.Unmarshal(b, &a.libs)
	}
	a.indexes = map[string][]FileEntry{}
	a.jobs = map[string]bool{}
	a.tasks = map[string]context.CancelFunc{}
	for _, l := range a.libs {
		var xs []FileEntry
		if b, e := os.ReadFile(filepath.Join(a.indexDir, l.ID+".json")); e == nil && json.Unmarshal(b, &xs) == nil {
			a.indexes[l.ID] = xs
		}
	}
}
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func errJSON(w http.ResponseWriter, c int, s string) {
	writeJSON(w, c, map[string]any{"ok": false, "error": s})
}
func auth(r *http.Request) bool {
	t := os.Getenv("ADMIN_TOKEN")
	return t == "" || r.Header.Get("X-VaultHub-Token") == t
}

// managerSessionOK asks the co-located Go manager whether the caller's session
// cookie is still valid. The manager owns the session store, so it stays the
// single authority for authentication and idle-timeout sliding.
func managerSessionOK(r *http.Request) bool {
	c, e := r.Cookie("vh_session")
	if e != nil || c.Value == "" {
		return false
	}
	addr := env("MANAGER_ADDR", "127.0.0.1:9099")
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", "http://"+addr+"/api/session/check", nil)
	if e != nil {
		return false
	}
	req.AddCookie(&http.Cookie{Name: "vh_session", Value: c.Value})
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		return false
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	return res.StatusCode == http.StatusOK
}

// writeAuth guards every mutating media endpoint. An explicit ADMIN_TOKEN still
// works for legacy clients, otherwise a valid manager session is required.
// Unlike auth(), it never fails open when ADMIN_TOKEN is empty.
func writeAuth(r *http.Request) bool {
	if t := os.Getenv("ADMIN_TOKEN"); t != "" && r.Header.Get("X-VaultHub-Token") == t {
		return true
	}
	return managerSessionOK(r)
}
func validID(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.", c)) {
			return false
		}
	}
	return true
}
func (a *App) save() error {
	_ = os.MkdirAll(filepath.Dir(a.config), 0755)
	b, e := json.MarshalIndent(a.libs, "", "  ")
	if e == nil {
		e = os.WriteFile(a.config, b, 0644)
	}
	return e
}
func (a *App) find(id string) (Library, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, l := range a.libs {
		if l.ID == id {
			return l, true
		}
	}
	return Library{}, false
}
func safeFile(lib Library, rel string) (string, os.FileInfo, error) {
	if rel == "" || filepath.IsAbs(rel) || strings.Contains(rel, "\\") {
		return "", nil, fmt.Errorf("invalid path")
	}
	clean := filepath.Clean(rel)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", nil, fmt.Errorf("invalid path")
	}
	root, e := filepath.EvalSymlinks(lib.Path)
	if e != nil {
		return "", nil, e
	}
	p, e := filepath.EvalSymlinks(filepath.Join(root, clean))
	if e != nil {
		return "", nil, e
	}
	if p != root && !strings.HasPrefix(p, root+string(os.PathSeparator)) {
		return "", nil, fmt.Errorf("path outside media root")
	}
	st, e := os.Stat(p)
	if e != nil || st.IsDir() {
		return "", nil, fmt.Errorf("file not found")
	}
	return p, st, nil
}
func (a *App) libraries(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		a.mu.RLock()
		v := append([]Library(nil), a.libs...)
		a.mu.RUnlock()
		writeJSON(w, 200, map[string]any{"libraries": v})
		return
	}
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method == "POST" {
		var l Library
		if json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&l) != nil || !validID(l.ID) || l.Name == "" || !map[string]bool{"audio": true, "musicvideo": true, "comic": true, "book": true, "movie": true, "series": true}[l.Type] {
			errJSON(w, 400, "invalid id, name or type")
			return
		}
		p, e := filepath.Abs(l.Path)
		if e != nil || !strings.HasPrefix(p, string(filepath.Separator)) {
			errJSON(w, 400, "path must be an existing absolute directory")
			return
		}
		st, e := os.Stat(p)
		if e != nil || !st.IsDir() {
			errJSON(w, 400, "path must be an existing absolute directory")
			return
		}
		l.Path, _ = filepath.EvalSymlinks(p)
		a.mu.Lock()
		for _, x := range a.libs {
			if x.ID == l.ID {
				a.mu.Unlock()
				if x.Name == l.Name && x.Type == l.Type && x.Path == l.Path {
					a.start(l)
					writeJSON(w, 200, map[string]any{"ok": true, "existing": true, "status": "indexing"})
				} else {
					errJSON(w, 409, "id already exists with different library data")
				}
				return
			}
		}
		a.libs = append(a.libs, l)
		e = a.save()
		a.mu.Unlock()
		if e != nil {
			errJSON(w, 500, "configuration write failed")
			return
		}
		a.start(l)
		writeJSON(w, 201, map[string]any{"ok": true, "status": "indexing"})
		return
	}
	if r.Method == "DELETE" {
		id := r.URL.Query().Get("id")
		a.mu.Lock()
		n := -1
		for i, x := range a.libs {
			if x.ID == id {
				n = i
			}
		}
		if n < 0 {
			a.mu.Unlock()
			errJSON(w, 404, "library not found")
			return
		}
		a.libs = append(a.libs[:n], a.libs[n+1:]...)
		e := a.save()
		a.mu.Unlock()
		if e != nil {
			errJSON(w, 500, "configuration write failed")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	errJSON(w, 405, "method not allowed")
}
func (a *App) start(l Library) {
	a.mu.Lock()
	if a.jobs[l.ID] {
		a.mu.Unlock()
		return
	}
	a.jobs[l.ID] = true
	a.mu.Unlock()
	go func() {
		var out []FileEntry
		filepath.Walk(l.Path, func(p string, st os.FileInfo, e error) error {
			if e == nil && st.Mode().IsRegular() {
				rel, _ := filepath.Rel(l.Path, p)
				out = append(out, FileEntry{rel, st.Size(), st.ModTime().Unix()})
			}
			return nil
		})
		_ = os.MkdirAll(a.indexDir, 0755)
		if b, e := json.Marshal(out); e == nil {
			_ = os.WriteFile(filepath.Join(a.indexDir, l.ID+".json"), b, 0644)
		}
		a.mu.Lock()
		a.indexes[l.ID] = out
		a.jobs[l.ID] = false
		a.mu.Unlock()
	}()
}
func (a *App) files(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	l, ok := a.find(id)
	if !ok || !validID(id) {
		errJSON(w, 400, "invalid id")
		return
	}
	a.mu.RLock()
	xs, ready := a.indexes[id]
	busy := a.jobs[id]
	a.mu.RUnlock()
	if !ready && !busy {
		a.start(l)
		writeJSON(w, 200, map[string]any{"status": "indexing", "total": 0, "offset": 0, "limit": 100, "has_more": false, "files": []FileEntry{}})
		return
	}
	off, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	lim, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if lim <= 0 || lim > 500 {
		lim = 100
	}
	if off < 0 {
		off = 0
	}
	end := off + lim
	if end > len(xs) {
		end = len(xs)
	}
	if off > len(xs) {
		off = len(xs)
	}
	writeJSON(w, 200, map[string]any{"status": map[bool]string{true: "indexing", false: "ready"}[busy], "total": len(xs), "offset": off, "limit": lim, "has_more": end < len(xs), "files": xs[off:end]})
}

func (a *App) serve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	l, ok := a.find(q.Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	p, st, e := safeFile(l, q.Get("path"))
	if e != nil {
		errJSON(w, 404, "file not found")
		return
	}
	f, e := os.Open(p)
	if e != nil {
		errJSON(w, 404, "file not found")
		return
	}
	defer f.Close()
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

func (a *App) serveLegacy(w http.ResponseWriter, r *http.Request) {
	const prefix = "/api/media/file/"
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	slash := strings.IndexByte(rest, '/')
	if slash <= 0 || slash == len(rest)-1 {
		errJSON(w, http.StatusBadRequest, "file path required")
		return
	}
	query := r.URL.Query()
	query.Set("id", rest[:slash])
	query.Set("path", rest[slash+1:])
	r.URL.RawQuery = query.Encode()
	a.serve(w, r)
}
func imageEntry(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff":
		return true
	}
	return false
}

// decodeZipNames turns legacy non-UTF-8 ZIP entry names (GBK/Shift-JIS, produced
// by Windows archivers) into readable UTF-8 display names. The archive itself is
// still addressed by its raw name, so lookups stay byte-exact.
func decodeZipNames(raw []string) []string {
	out := make([]string, len(raw))
	copy(out, raw)
	var pending []int
	for i, s := range raw {
		if !utf8.ValidString(s) {
			pending = append(pending, i)
		}
	}
	if len(pending) == 0 {
		return out
	}
	for _, enc := range []string{"GBK", "SHIFT-JIS"} {
		var left []int
		for _, i := range pending {
			if d, ok := iconvTo(raw[i], enc); ok {
				out[i] = d
			} else {
				left = append(left, i)
			}
		}
		pending = left
		if len(pending) == 0 {
			break
		}
	}
	for _, i := range pending {
		out[i] = strings.ToValidUTF8(raw[i], "\uFFFD")
	}
	return out
}

func iconvTo(s, enc string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "iconv", "-f", enc, "-t", "UTF-8")
	cmd.Stdin = strings.NewReader(s)
	b, e := cmd.Output()
	if e != nil {
		return "", false
	}
	d := strings.TrimRight(string(b), "\n")
	if d == "" || !utf8.ValidString(d) {
		return "", false
	}
	return d, true
}

func (a *App) archive(w http.ResponseWriter, r *http.Request) {
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	p, _, e := safeFile(l, r.URL.Query().Get("path"))
	if e != nil {
		errJSON(w, 404, "file not found")
		return
	}
	z, e := zip.OpenReader(p)
	if e != nil {
		errJSON(w, 400, "not a ZIP/CBZ archive")
		return
	}
	defer z.Close()

	files := make([]*zip.File, 0, len(z.File))
	rawNames := make([]string, 0, len(z.File))
	for _, x := range z.File {
		if x.FileInfo().IsDir() {
			continue
		}
		files = append(files, x)
		rawNames = append(rawNames, x.Name)
	}
	display := decodeZipNames(rawNames)

	if want := r.URL.Query().Get("entry"); want != "" {
		for i, x := range files {
			// Accept the raw ZIP name and the decoded display name so links
			// generated by older frontends keep working.
			if x.Name != want && display[i] != want {
				continue
			}
			rc, e := x.Open()
			if e != nil {
				break
			}
			defer rc.Close()
			w.Header().Set("Content-Type", mime(display[i]))
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "private, max-age=3600")
			io.Copy(w, rc)
			return
		}
		errJSON(w, 404, "archive entry not found")
		return
	}

	type ent struct {
		Name string `json:"name"`
		Raw  string `json:"raw"`
		Size int64  `json:"size"`
		URL  string `json:"url"`
	}
	id := r.URL.Query().Get("id")
	archivePath := r.URL.Query().Get("path")
	idx := make([]int, 0, len(files))
	for i, x := range files {
		if imageEntry(display[i]) || imageEntry(x.Name) {
			idx = append(idx, i)
		}
	}
	// Comic pages are numbered, so order them naturally (2 before 10).
	sort.SliceStable(idx, func(x, y int) bool { return naturalLess(display[idx[x]], display[idx[y]]) })
	out := make([]ent, 0, len(idx))
	for _, i := range idx {
		u := "/api/media/archive/zip/register?id=" + url.QueryEscape(id) + "&path=" + url.QueryEscape(archivePath) + "&entry=" + url.QueryEscape(files[i].Name)
		out = append(out, ent{Name: display[i], Raw: files[i].Name, Size: files[i].FileInfo().Size(), URL: u})
	}
	writeJSON(w, 200, map[string]any{"entries": out, "total": len(out)})
}

// naturalLess compares strings so embedded numbers sort numerically.
func naturalLess(a, b string) bool {
	for a != "" && b != "" {
		ad, bd := a[0] >= '0' && a[0] <= '9', b[0] >= '0' && b[0] <= '9'
		if ad && bd {
			i, j := 0, 0
			for i < len(a) && a[i] >= '0' && a[i] <= '9' {
				i++
			}
			for j < len(b) && b[j] >= '0' && b[j] <= '9' {
				j++
			}
			x, _ := strconv.Atoi(a[:i])
			y, _ := strconv.Atoi(b[:j])
			if x != y {
				return x < y
			}
			a, b = a[i:], b[j:]
			continue
		}
		if a[0] != b[0] {
			return a[0] < b[0]
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}

func mime(p string) string {
	e := strings.ToLower(filepath.Ext(p))
	m := map[string]string{".mkv": "video/x-matroska", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".srt": "application/x-subrip", ".vtt": "text/vtt"}
	if x := m[e]; x != "" {
		return x
	}
	return "application/octet-stream"
}

func cacheKey(path string) string {
	h := sha256.Sum256([]byte(path))
	return filepath.Join("/data/transcode-cache", hex.EncodeToString(h[:])+".mp4")
}
func commandJSON(w http.ResponseWriter, r *http.Request, name string, args ...string) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out, e := cmd.Output()
	if e != nil {
		errJSON(w, 500, name+" unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(out)
}
func systemMetrics(w http.ResponseWriter, r *http.Request) {
	if v := strings.ToLower(os.Getenv("SYSTEM_MONITOR_ENABLED")); v == "0" || v == "false" {
		writeJSON(w, 200, map[string]any{"enabled": false})
		return
	}
	proc := env("SYSTEM_MONITOR_PROC_ROOT", "/host/proc")
	load := 0.0
	if b, e := os.ReadFile(filepath.Join(proc, "loadavg")); e == nil {
		fmt.Sscanf(string(b), "%f", &load)
	}
	var total, avail uint64
	if b, e := os.ReadFile(filepath.Join(proc, "meminfo")); e == nil {
		for _, line := range strings.Split(string(b), "\n") {
			fmt.Sscanf(line, "MemTotal: %d kB", &total)
			fmt.Sscanf(line, "MemAvailable: %d kB", &avail)
		}
	}
	writeJSON(w, 200, map[string]any{"enabled": true, "cpu": map[string]any{"percent": 0, "load1": load}, "memory": map[string]uint64{"total": total * 1024, "used": (total - avail) * 1024, "available": avail * 1024}, "network": map[string]int{"rx_bytes": 0, "tx_bytes": 0}, "filesystems": []any{}})
}
func probe(w http.ResponseWriter, r *http.Request, a *App) {
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	p, _, e := safeFile(l, r.URL.Query().Get("path"))
	if e != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	b, e := exec.CommandContext(ctx, "ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", p).Output()
	if e != nil {
		writeJSON(w, 200, map[string]any{"audio_codec": "", "video_codec": "", "container_likely_supported": false, "audio_likely_supported": true, "compat_recommended": true})
		return
	}
	var x struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
		} `json:"streams"`
	}
	_ = json.Unmarshal(b, &x)
	ac, vc := "", ""
	for _, s := range x.Streams {
		if s.CodecType == "audio" && ac == "" {
			ac = s.CodecName
		}
		if s.CodecType == "video" && vc == "" {
			vc = s.CodecName
		}
	}
	ext := strings.ToLower(filepath.Ext(p))
	container := ext == ".mp4" || ext == ".m4v" || ext == ".webm" || ext == ".ogv" || ext == ".ogg"
	audio := ac == "" || map[string]bool{"aac": true, "mp3": true, "opus": true, "vorbis": true, "flac": true}[ac]
	writeJSON(w, 200, map[string]any{"audio_codec": ac, "video_codec": vc, "container_likely_supported": container, "audio_likely_supported": audio, "compat_recommended": !container || !audio})
}
func streams(w http.ResponseWriter, r *http.Request, a *App) {
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	p, _, e := safeFile(l, r.URL.Query().Get("path"))
	if e != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	b, e := exec.CommandContext(r.Context(), "ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index:stream_tags=language,title", "-of", "json", p).Output()
	if e != nil {
		writeJSON(w, 200, map[string]any{"audio_tracks": []any{}})
		return
	}
	var x struct {
		Streams []struct {
			Index int               `json:"index"`
			Tags  map[string]string `json:"tags"`
		} `json:"streams"`
	}
	_ = json.Unmarshal(b, &x)
	tracks := make([]map[string]any, 0, len(x.Streams))
	for i, s := range x.Streams {
		label := s.Tags["title"]
		if label == "" {
			label = fmt.Sprintf("音源 %d", i+1)
		}
		if lang := s.Tags["language"]; lang != "" {
			label += " · " + lang
		}
		tracks = append(tracks, map[string]any{"index": i, "stream_index": s.Index, "label": label})
	}
	writeJSON(w, 200, map[string]any{"audio_tracks": tracks})
}
func cancelTask(w http.ResponseWriter, r *http.Request, a *App) {
	id := r.URL.Query().Get("id")
	a.mu.Lock()
	f, ok := a.tasks[id]
	if ok {
		delete(a.tasks, id)
	}
	a.mu.Unlock()
	if ok {
		f()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "cancelled": ok})
}
func main() {
	a := &App{}
	a.load()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") })
	mux.HandleFunc("/api/system/metrics", systemMetrics)
	mux.HandleFunc("/api/media/libraries", a.libraries)
	mux.HandleFunc("/api/media/files", a.files)
	mux.HandleFunc("/api/media/file", a.serve)
	mux.HandleFunc("/api/media/file/", a.serveLegacy)
	mux.HandleFunc("/api/media/archive/zip", a.archive)
	mux.HandleFunc("/api/media/archive/zip/register", a.archive)
	mux.HandleFunc("/api/media/archive", a.archive)
	mux.HandleFunc("/api/media/zip", a.archive)
	mux.HandleFunc("/api/media/scrapers", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"default":         "douban",
			"tmdb_enabled":    os.Getenv("TMDB_API_KEY") != "",
			"tmdb_image_base": strings.TrimRight(env("TMDB_IMAGE_BASE", "https://image.tmdb.org/t/p"), "/"),
			"types":           []string{"movie", "series"},
		})
	})
	mux.HandleFunc("/api/media/hardware", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"configured": env("FFMPEG_HWACCEL", "auto"), "selected": "cpu", "available": map[string]bool{"cpu": true, "vaapi": false, "qsv": false, "cuda": false}})
	})
	mux.HandleFunc("/api/media/probe", func(w http.ResponseWriter, r *http.Request) { probe(w, r, a) })
	mux.HandleFunc("/api/media/streams", func(w http.ResponseWriter, r *http.Request) { streams(w, r, a) })
	mux.HandleFunc("/api/media/tasks/cancel", func(w http.ResponseWriter, r *http.Request) { cancelTask(w, r, a) })
	mux.HandleFunc("/api/media/subtitles/search", a.subtitle)
	mux.HandleFunc("/api/media/subtitles/proxy", a.serve)
	mux.HandleFunc("/api/media/tmdb", a.tmdb)
	mux.HandleFunc("/api/media/compat", a.compat)
	fmt.Println("VaultHub media API listening on 127.0.0.1:9100")
	http.ListenAndServe("127.0.0.1:9100", mux)
}
func (a *App) subtitle(w http.ResponseWriter, r *http.Request) {
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	p, _, e := safeFile(l, r.URL.Query().Get("path"))
	if e != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	d := filepath.Dir(p)
	stem := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
	ents, _ := os.ReadDir(d)
	items := []map[string]string{}
	for _, x := range ents {
		if strings.HasPrefix(strings.ToLower(x.Name()), strings.ToLower(stem)) && strings.Contains(".srt .vtt .ass .ssa", strings.ToLower(filepath.Ext(x.Name()))) {
			rel, _ := filepath.Rel(l.Path, filepath.Join(d, x.Name()))
			items = append(items, map[string]string{"label": "本地 · " + x.Name(), "url": "/api/media/subtitles/proxy?id=" + url.QueryEscape(l.ID) + "&path=" + url.QueryEscape(rel)})
		}
	}
	writeJSON(w, 200, map[string]any{"items": items})
}
func (a *App) tmdb(w http.ResponseWriter, r *http.Request) {
	key := os.Getenv("TMDB_API_KEY")
	if key == "" {
		errJSON(w, 400, "TMDB_API_KEY is not configured")
		return
	}
	typ := r.URL.Query().Get("type")
	endpoint := "search/movie"
	if typ == "series" || typ == "tv" {
		endpoint = "search/tv"
	}
	base := strings.TrimRight(env("TMDB_API_BASE", "https://api.themoviedb.org/3"), "/")
	u := base + "/" + endpoint + "?api_key=" + url.QueryEscape(key) + "&language=zh-CN&query=" + url.QueryEscape(r.URL.Query().Get("query"))
	req, _ := http.NewRequestWithContext(r.Context(), "GET", u, nil)
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		errJSON(w, 502, "tmdb scrape failed")
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.StatusCode)
	io.Copy(w, res.Body)
}
func (a *App) compat(w http.ResponseWriter, r *http.Request) {
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	p, st, e := safeFile(l, r.URL.Query().Get("path"))
	if e != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	cache := cacheKey(fmt.Sprintf("%s:%d:%d:%s", p, st.Size(), st.ModTime().UnixNano(), r.URL.Query().Get("hw")))
	if f, e := os.Open(cache); e == nil {
		defer f.Close()
		info, _ := f.Stat()
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Accept-Ranges", "bytes")
		http.ServeContent(w, r, info.Name(), info.ModTime(), f)
		return
	}
	if e := os.MkdirAll(filepath.Dir(cache), 0755); e != nil {
		errJSON(w, 500, "cache unavailable")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	taskID := r.URL.Query().Get("task")
	if taskID != "" {
		a.mu.Lock()
		a.tasks[taskID] = cancel
		a.mu.Unlock()
		defer func() { a.mu.Lock(); delete(a.tasks, taskID); a.mu.Unlock() }()
	} else {
		defer cancel()
	}
	tmp := cache + fmt.Sprintf(".tmp-%d", os.Getpid())
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", p, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", "-f", "mp4", tmp)
	if out, e := cmd.CombinedOutput(); e != nil {
		_ = os.Remove(tmp)
		if ctx.Err() != nil {
			return
		}
		errJSON(w, 500, "compat playback unavailable: "+strings.TrimSpace(string(out)))
		return
	}
	if e := os.Rename(tmp, cache); e != nil {
		_ = os.Remove(tmp)
		errJSON(w, 500, "cache write failed")
		return
	}
	f, e := os.Open(cache)
	if e != nil {
		errJSON(w, 500, "cache read failed")
		return
	}
	defer f.Close()
	info, _ := f.Stat()
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

var _ = time.Now
