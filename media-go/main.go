package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
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
	"syscall"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// VaultHub media API replacement. Beyond the standard library it uses only the
// pure-Go SQLite driver modernc.org/sqlite (no cgo), keeping static builds.
type Library struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	Path string `json:"path"`
}
type App struct {
	mu               sync.RWMutex
	libs             []Library
	jobs             map[string]bool               // library id -> scan in progress
	scanCancel       map[string]context.CancelFunc // library id -> cancel its running scan
	tasks            map[string]context.CancelFunc // transcode task id -> cancel
	db               *sql.DB
	scanGate         chan struct{} // size-1 semaphore: only one scan writes at a time
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
	a.jobs = map[string]bool{}
	a.scanCancel = map[string]context.CancelFunc{}
	a.tasks = map[string]context.CancelFunc{}
	a.scanGate = make(chan struct{}, 1)
	a.openDB()
}

// openDB opens (creating if needed) the SQLite index database and applies the
// schema. Pragmas are set in the DSN so every pooled connection inherits WAL
// mode and a busy timeout, which lets read queries proceed while a rebuild
// writes in the background.
func (a *App) openDB() {
	_ = os.MkdirAll(a.indexDir, 0755)
	path := filepath.Join(a.indexDir, "index.db")
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)"
	db, e := sql.Open("sqlite", dsn)
	if e != nil {
		fmt.Println("index db open failed:", e)
		return
	}
	db.SetMaxOpenConns(4)
	if _, e := db.Exec(`
CREATE TABLE IF NOT EXISTS files(
  lib   TEXT NOT NULL,
  path  TEXT NOT NULL,
  size  INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  PRIMARY KEY(lib, path)
);
CREATE INDEX IF NOT EXISTS idx_files_lib ON files(lib);
CREATE TABLE IF NOT EXISTS index_status(
  lib        TEXT PRIMARY KEY,
  state      TEXT NOT NULL,   -- idle | scanning | ready | error | cancelled
  scanned    INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT 0,
  ended_at   INTEGER NOT NULL DEFAULT 0,
  message    TEXT NOT NULL DEFAULT ''
);`); e != nil {
		fmt.Println("index db schema failed:", e)
		return
	}
	a.db = db
	a.migrateLegacyIndexes()
}

// migrateLegacyIndexes imports pre-SQLite per-library JSON snapshots so an
// upgraded container serves cached listings immediately, before any rescan.
func (a *App) migrateLegacyIndexes() {
	for _, l := range a.libs {
		var n int
		a.db.QueryRow(`SELECT count(*) FROM files WHERE lib=?`, l.ID).Scan(&n)
		if n > 0 {
			continue
		}
		b, e := os.ReadFile(filepath.Join(a.indexDir, l.ID+".json"))
		if e != nil {
			continue
		}
		var xs []FileEntry
		if json.Unmarshal(b, &xs) != nil || len(xs) == 0 {
			continue
		}
		tx, e := a.db.Begin()
		if e != nil {
			continue
		}
		st, e := tx.Prepare(`INSERT OR REPLACE INTO files(lib,path,size,mtime) VALUES(?,?,?,?)`)
		if e != nil {
			tx.Rollback()
			continue
		}
		for _, x := range xs {
			st.Exec(l.ID, x.Path, x.Size, x.Mtime)
		}
		st.Close()
		tx.Commit()
		a.db.Exec(`INSERT OR REPLACE INTO index_status(lib,state,scanned,total,started_at,ended_at,message) VALUES(?,?,?,?,?,?,?)`,
			l.ID, "ready", len(xs), len(xs), time.Now().Unix(), time.Now().Unix(), "migrated from legacy json")
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

// start launches a background rescan for a library unless one is already
// running. The scan streams results into SQLite in batches so /api/media/files
// stays responsive, and it honours a per-library cancel func.
func (a *App) start(l Library) {
	a.mu.Lock()
	if a.jobs[l.ID] {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.jobs[l.ID] = true
	a.scanCancel[l.ID] = cancel
	a.mu.Unlock()

	go func() {
		start := time.Now().Unix()
		a.setStatus(l.ID, "scanning", 0, 0, start, 0, "")

		// Phase 1: walk the filesystem WITHOUT holding a DB write lock, so a
		// long scan of one library never blocks scans/writes for another. The
		// path strings are cheap to hold in memory even for large libraries.
		type row struct {
			path  string
			size  int64
			mtime int64
		}
		var rows []row
		cancelled := false
		walkErr := filepath.Walk(l.Path, func(p string, fi os.FileInfo, e error) error {
			if ctx.Err() != nil {
				cancelled = true
				return io.EOF
			}
			if e == nil && fi.Mode().IsRegular() {
				rel, _ := filepath.Rel(l.Path, p)
				rows = append(rows, row{rel, fi.Size(), fi.ModTime().Unix()})
				if len(rows)%5000 == 0 {
					a.setStatus(l.ID, "scanning", len(rows), 0, start, 0, "")
				}
			}
			return nil
		})
		if cancelled {
			a.finishScan(l.ID, "cancelled", len(rows), "scan cancelled")
			return
		}
		if walkErr != nil && walkErr != io.EOF {
			a.finishScan(l.ID, "error", len(rows), walkErr.Error())
			return
		}

		// Phase 2: swap the index under a single-writer gate, committing in
		// bounded batches so the write lock is released frequently and other
		// libraries' scans can interleave. Readers keep serving old rows via
		// WAL until each batch commits.
		a.scanGate <- struct{}{}
		defer func() { <-a.scanGate }()
		if ctx.Err() != nil {
			a.finishScan(l.ID, "cancelled", 0, "scan cancelled")
			return
		}
		if _, e := a.db.Exec(`DELETE FROM files WHERE lib=?`, l.ID); e != nil {
			a.finishScan(l.ID, "error", 0, e.Error())
			return
		}
		const batch = 2000
		written := 0
		for off := 0; off < len(rows); off += batch {
			if ctx.Err() != nil {
				a.finishScan(l.ID, "cancelled", written, "scan cancelled")
				return
			}
			end := off + batch
			if end > len(rows) {
				end = len(rows)
			}
			tx, e := a.db.Begin()
			if e != nil {
				a.finishScan(l.ID, "error", written, e.Error())
				return
			}
			st, e := tx.Prepare(`INSERT OR REPLACE INTO files(lib,path,size,mtime) VALUES(?,?,?,?)`)
			if e != nil {
				tx.Rollback()
				a.finishScan(l.ID, "error", written, e.Error())
				return
			}
			for _, x := range rows[off:end] {
				st.Exec(l.ID, x.path, x.size, x.mtime)
			}
			st.Close()
			if e := tx.Commit(); e != nil {
				a.finishScan(l.ID, "error", written, e.Error())
				return
			}
			written = end
			a.setStatus(l.ID, "scanning", written, len(rows), start, 0, "")
		}
		a.finishScan(l.ID, "ready", len(rows), "")
	}()
}

func (a *App) setStatus(lib, state string, scanned, total int, started, ended int64, msg string) {
	if a.db == nil {
		return
	}
	a.db.Exec(`INSERT INTO index_status(lib,state,scanned,total,started_at,ended_at,message)
VALUES(?,?,?,?,?,?,?)
ON CONFLICT(lib) DO UPDATE SET state=excluded.state, scanned=excluded.scanned,
  total=CASE WHEN excluded.total>0 THEN excluded.total ELSE index_status.total END,
  started_at=CASE WHEN excluded.started_at>0 THEN excluded.started_at ELSE index_status.started_at END,
  ended_at=excluded.ended_at, message=excluded.message`,
		lib, state, scanned, total, started, ended, msg)
}

func (a *App) finishScan(lib, state string, scanned int, msg string) {
	a.setStatus(lib, state, scanned, scanned, 0, time.Now().Unix(), msg)
	a.mu.Lock()
	a.jobs[lib] = false
	delete(a.scanCancel, lib)
	a.mu.Unlock()
}

// rebuild handles POST /api/media/index/rebuild. It creates (or restarts) scan
// jobs and returns immediately; the heavy walk runs in the background.
func (a *App) rebuild(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errJSON(w, 405, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	id := r.URL.Query().Get("id")
	started := []string{}
	if id != "" {
		l, ok := a.find(id)
		if !ok {
			errJSON(w, 404, "library not found")
			return
		}
		a.start(l)
		started = append(started, l.ID)
	} else {
		a.mu.RLock()
		libs := append([]Library(nil), a.libs...)
		a.mu.RUnlock()
		for _, l := range libs {
			a.start(l)
			started = append(started, l.ID)
		}
	}
	writeJSON(w, 202, map[string]any{"ok": true, "status": "scheduled", "libraries": started})
}

// indexCancel handles POST /api/media/index/cancel[?id=], stopping in-flight
// scans. Without id it cancels every running scan.
func (a *App) indexCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		errJSON(w, 405, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	id := r.URL.Query().Get("id")
	cancelled := []string{}
	a.mu.Lock()
	for lib, cancel := range a.scanCancel {
		if id == "" || lib == id {
			cancel()
			cancelled = append(cancelled, lib)
		}
	}
	a.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true, "cancelled": cancelled})
}

// indexStatus handles GET /api/media/index/status, reporting per-library scan
// progress straight from SQLite without touching the filesystem.
func (a *App) indexStatus(w http.ResponseWriter, r *http.Request) {
	if a.db == nil {
		errJSON(w, 503, "index database unavailable")
		return
	}
	a.mu.RLock()
	jobs := map[string]bool{}
	for k, v := range a.jobs {
		jobs[k] = v
	}
	libs := append([]Library(nil), a.libs...)
	a.mu.RUnlock()

	type st struct {
		Lib       string `json:"lib"`
		Name      string `json:"name"`
		State     string `json:"state"`
		Scanned   int    `json:"scanned"`
		Total     int    `json:"total"`
		StartedAt int64  `json:"started_at"`
		EndedAt   int64  `json:"ended_at"`
		Message   string `json:"message"`
		Running   bool   `json:"running"`
	}
	rows := map[string]*st{}
	for _, l := range libs {
		rows[l.ID] = &st{Lib: l.ID, Name: l.Name, State: "idle"}
	}
	rs, e := a.db.Query(`SELECT lib,state,scanned,total,started_at,ended_at,message FROM index_status`)
	if e == nil {
		for rs.Next() {
			var s st
			rs.Scan(&s.Lib, &s.State, &s.Scanned, &s.Total, &s.StartedAt, &s.EndedAt, &s.Message)
			if r0, ok := rows[s.Lib]; ok {
				name := r0.Name
				*r0 = s
				r0.Name = name
			}
		}
		rs.Close()
	}
	out := make([]st, 0, len(rows))
	anyRunning := false
	for id, s := range rows {
		s.Running = jobs[id]
		if s.Running {
			anyRunning = true
			if s.State != "scanning" {
				s.State = "scanning"
			}
		}
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Lib < out[j].Lib })
	writeJSON(w, 200, map[string]any{"ok": true, "running": anyRunning, "libraries": out})
}

// files serves paginated listings straight from SQLite. It never walks the
// filesystem, so it stays fast even during a rebuild. If a library has never
// been indexed it kicks off a background scan and returns an empty page.
func (a *App) files(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	l, ok := a.find(id)
	if !ok || !validID(id) {
		errJSON(w, 400, "invalid id")
		return
	}
	if a.db == nil {
		errJSON(w, 503, "index database unavailable")
		return
	}
	a.mu.RLock()
	busy := a.jobs[id]
	a.mu.RUnlock()

	var total int
	a.db.QueryRow(`SELECT count(*) FROM files WHERE lib=?`, id).Scan(&total)

	var state string
	if e := a.db.QueryRow(`SELECT state FROM index_status WHERE lib=?`, id).Scan(&state); e != nil {
		state = ""
	}
	// Never indexed and nothing running: schedule a scan and report indexing.
	if total == 0 && !busy && state == "" {
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
	files := make([]FileEntry, 0, lim)
	rows, e := a.db.Query(`SELECT path,size,mtime FROM files WHERE lib=? ORDER BY path LIMIT ? OFFSET ?`, id, lim, off)
	if e == nil {
		for rows.Next() {
			var fe FileEntry
			rows.Scan(&fe.Path, &fe.Size, &fe.Mtime)
			files = append(files, fe)
		}
		rows.Close()
	}
	status := "ready"
	if busy {
		status = "indexing"
	}
	writeJSON(w, 200, map[string]any{"status": status, "total": total, "offset": off, "limit": lim, "has_more": off+len(files) < total, "files": files})
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
// cpuSample is the last /proc/stat total/idle snapshot, used to compute the
// busy percentage between two scrapes (the front-end polls every 5s).
type cpuSample struct {
	total, idle uint64
}

var (
	metricsMu    sync.Mutex
	lastCPU      cpuSample
	lastCPUValid bool
)

// readCPU parses the aggregate "cpu" line of /proc/stat into total and idle
// jiffies. idle = idle + iowait.
func readCPU(proc string) (cpuSample, int, bool) {
	b, e := os.ReadFile(filepath.Join(proc, "stat"))
	if e != nil {
		return cpuSample{}, 0, false
	}
	cores := 0
	var s cpuSample
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)[1:]
			for i, f := range fields {
				v, _ := strconv.ParseUint(f, 10, 64)
				s.total += v
				if i == 3 || i == 4 { // idle + iowait
					s.idle += v
				}
			}
		} else if len(line) > 3 && strings.HasPrefix(line, "cpu") && line[3] >= '0' && line[3] <= '9' {
			cores++
		}
	}
	return s, cores, true
}

// hwmonTemps walks /host/sys/class/hwmon and returns every tempN_input reading
// (in °C), grouped by sensor name. Drive/NVMe sensors are separated so the
// front-end can show real disk temperatures when they exist.
func hwmonTemps(sysRoot string) (cpuTemp float64, disks []map[string]any, sensors []map[string]any) {
	dirs, _ := filepath.Glob(filepath.Join(sysRoot, "class/hwmon/hwmon*"))
	for _, d := range dirs {
		nb, _ := os.ReadFile(filepath.Join(d, "name"))
		name := strings.TrimSpace(string(nb))
		inputs, _ := filepath.Glob(filepath.Join(d, "temp*_input"))
		sort.Strings(inputs)
		isDrive := name == "drivetemp" || strings.HasPrefix(name, "nvme")
		for _, in := range inputs {
			vb, e := os.ReadFile(in)
			if e != nil {
				continue
			}
			milli, e := strconv.ParseFloat(strings.TrimSpace(string(vb)), 64)
			if e != nil {
				continue
			}
			c := milli / 1000.0
			label := name
			if lb, e := os.ReadFile(strings.TrimSuffix(in, "_input") + "_label"); e == nil {
				if s := strings.TrimSpace(string(lb)); s != "" {
					label = s
				}
			}
			entry := map[string]any{"name": label, "temp": c}
			sensors = append(sensors, entry)
			if isDrive {
				disks = append(disks, entry)
			}
			// coretemp "Package id 0" (or first coretemp reading) is the CPU temp.
			if cpuTemp == 0 && (name == "coretemp" || name == "k10temp" || name == "cpu_thermal") {
				cpuTemp = c
			}
		}
	}
	return
}

// pickInterface returns the network interface to report. Honours
// SYSTEM_MONITOR_INTERFACE, otherwise picks the physical interface (skipping
// lo/veth/br/docker/ovs) carrying the most received bytes.
func pickInterface(proc, forced string) (name string, rx, tx uint64) {
	b, e := os.ReadFile(filepath.Join(proc, "net/dev"))
	if e != nil {
		return "", 0, 0
	}
	best := uint64(0)
	for _, line := range strings.Split(string(b), "\n") {
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue
		}
		iface := strings.TrimSpace(line[:i])
		fields := strings.Fields(line[i+1:])
		if len(fields) < 16 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		if forced != "" {
			if iface == forced {
				return iface, r, t
			}
			continue
		}
		if iface == "lo" || strings.HasPrefix(iface, "veth") || strings.HasPrefix(iface, "br-") ||
			strings.HasPrefix(iface, "docker") || strings.HasPrefix(iface, "ovs") || strings.HasSuffix(iface, "-ovs") {
			continue
		}
		if r > best {
			best, name, rx, tx = r, iface, r, t
		}
	}
	return name, rx, tx
}

func systemMetrics(w http.ResponseWriter, r *http.Request) {
	if v := strings.ToLower(os.Getenv("SYSTEM_MONITOR_ENABLED")); v == "0" || v == "false" {
		writeJSON(w, 200, map[string]any{"enabled": false})
		return
	}
	proc := env("SYSTEM_MONITOR_PROC_ROOT", "/host/proc")
	sysRoot := env("SYSTEM_MONITOR_SYS_ROOT", "/host/sys")
	volRoot := env("SYSTEM_MONITOR_VOL_ROOT", "/host")

	load := 0.0
	if b, e := os.ReadFile(filepath.Join(proc, "loadavg")); e == nil {
		fmt.Sscanf(string(b), "%f", &load)
	}

	var memTotal, memAvail, swapTotal, swapFree uint64
	if b, e := os.ReadFile(filepath.Join(proc, "meminfo")); e == nil {
		for _, line := range strings.Split(string(b), "\n") {
			fmt.Sscanf(line, "MemTotal: %d kB", &memTotal)
			fmt.Sscanf(line, "MemAvailable: %d kB", &memAvail)
			fmt.Sscanf(line, "SwapTotal: %d kB", &swapTotal)
			fmt.Sscanf(line, "SwapFree: %d kB", &swapFree)
		}
	}

	// CPU busy percentage from the delta between this and the previous scrape.
	cpuPercent := 0.0
	sample, cores, ok := readCPU(proc)
	if ok {
		metricsMu.Lock()
		if lastCPUValid && sample.total > lastCPU.total {
			dTotal := sample.total - lastCPU.total
			dIdle := sample.idle - lastCPU.idle
			if dTotal > 0 {
				cpuPercent = float64(dTotal-dIdle) / float64(dTotal) * 100.0
			}
		}
		lastCPU = sample
		lastCPUValid = true
		metricsMu.Unlock()
	}
	if cpuPercent < 0 {
		cpuPercent = 0
	}

	cpuTemp, diskTemps, allSensors := hwmonTemps(sysRoot)

	iface, rx, tx := pickInterface(proc, os.Getenv("SYSTEM_MONITOR_INTERFACE"))

	// Filesystem capacity: statfs each configured volume, mounted read-only at
	// volRoot/<name> (e.g. /host/vol1). Absolute paths are used verbatim.
	fslist := []map[string]any{}
	for _, name := range strings.Split(env("SYSTEM_MONITOR_FILESYSTEMS", ""), ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		mount := name
		if !filepath.IsAbs(mount) {
			mount = filepath.Join(volRoot, name)
		}
		var st syscall.Statfs_t
		if syscall.Statfs(mount, &st) != nil {
			continue
		}
		bsize := uint64(st.Bsize)
		total := st.Blocks * bsize
		free := st.Bavail * bsize
		used := total - st.Bfree*bsize
		pct := 0
		if total > 0 {
			pct = int(float64(used) / float64(total) * 100.0)
		}
		fslist = append(fslist, map[string]any{"path": name, "total": total, "used": used, "free": free, "percent": pct})
	}

	writeJSON(w, 200, map[string]any{
		"enabled": true,
		"cpu":     map[string]any{"percent": int(cpuPercent + 0.5), "load1": load, "cores": cores, "temp": cpuTemp},
		"memory": map[string]uint64{
			"total": memTotal * 1024, "used": (memTotal - memAvail) * 1024, "available": memAvail * 1024,
			"swap_total": swapTotal * 1024, "swap_used": (swapTotal - swapFree) * 1024,
		},
		"network":           map[string]any{"interface": iface, "rx_bytes": rx, "tx_bytes": tx},
		"filesystems":       fslist,
		"disk_temperatures": diskTemps,
		"temperatures":      allSensors,
	})
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
	b, e := exec.CommandContext(r.Context(), "ffprobe", "-v", "error", "-show_entries", "stream=index,codec_type,codec_name:stream_tags=language,title", "-of", "json", p).Output()
	if e != nil {
		writeJSON(w, 200, map[string]any{"audio_tracks": []any{}, "subtitle_tracks": []any{}})
		return
	}
	var x struct {
		Streams []struct {
			Index     int               `json:"index"`
			CodecType string            `json:"codec_type"`
			CodecName string            `json:"codec_name"`
			Tags      map[string]string `json:"tags"`
		} `json:"streams"`
	}
	_ = json.Unmarshal(b, &x)
	tracks := make([]map[string]any, 0)
	subs := make([]map[string]any, 0)
	ai, si := 0, 0
	for _, s := range x.Streams {
		switch s.CodecType {
		case "audio":
			label := s.Tags["title"]
			if label == "" {
				label = fmt.Sprintf("音源 %d", ai+1)
			}
			if lang := s.Tags["language"]; lang != "" {
				label += " · " + lang
			}
			tracks = append(tracks, map[string]any{"index": ai, "stream_index": s.Index, "label": label})
			ai++
		case "subtitle":
			// Only text-based subtitles can be extracted to WebVTT for the
			// browser. Bitmap subtitles (pgs/dvdsub) are skipped.
			if s.CodecName == "hdmv_pgs_subtitle" || s.CodecName == "dvd_subtitle" || s.CodecName == "dvb_subtitle" {
				si++
				continue
			}
			label := s.Tags["title"]
			if label == "" {
				label = fmt.Sprintf("内嵌字幕 %d", si+1)
			}
			if lang := s.Tags["language"]; lang != "" {
				label += " · " + lang
			}
			subs = append(subs, map[string]any{
				"index": si, "label": label, "codec": s.CodecName,
				"url": "/api/media/subtitles/extract?id=" + url.QueryEscape(l.ID) + "&path=" + url.QueryEscape(r.URL.Query().Get("path")) + "&track=" + strconv.Itoa(si),
			})
			si++
		}
	}
	writeJSON(w, 200, map[string]any{"audio_tracks": tracks, "subtitle_tracks": subs})
}

// probeVideoCodec returns the codec name of the first video stream (e.g.
// "h264", "hevc"). Used to decide whether the compat stream can copy the video
// instead of re-encoding it.
func probeVideoCodec(ctx context.Context, p string) (string, error) {
	b, e := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nk=1:nw=1", p).Output()
	if e != nil {
		return "", e
	}
	return strings.TrimSpace(string(b)), nil
}

// extractSubtitle pulls one embedded text subtitle track out of a video and
// converts it to WebVTT so the browser <track> element can display it.
func (a *App) extractSubtitle(w http.ResponseWriter, r *http.Request) {
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
	track := 0
	if n, err := strconv.Atoi(r.URL.Query().Get("track")); err == nil && n >= 0 {
		track = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", p, "-map", fmt.Sprintf("0:s:%d", track), "-f", "webvtt", "pipe:1")
	out, e := cmd.Output()
	if e != nil || len(out) == 0 {
		errJSON(w, 500, "subtitle extract failed")
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Write(out)
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
	mux.HandleFunc("/api/media/index/rebuild", a.rebuild)
	mux.HandleFunc("/api/media/index/cancel", a.indexCancel)
	mux.HandleFunc("/api/media/index/status", a.indexStatus)
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
	mux.HandleFunc("/api/media/subtitles/extract", a.extractSubtitle)
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
	// audio_track selects which audio stream to keep (index into the file's
	// audio streams). It is part of the cache key so different tracks cache
	// separately and never collide.
	audioTrack := r.URL.Query().Get("audio_track")
	cache := cacheKey(fmt.Sprintf("%s:%d:%d:%s:a%s", p, st.Size(), st.ModTime().UnixNano(), r.URL.Query().Get("hw"), audioTrack))
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
	// Only remux/transcode what the browser can't play. If the video is
	// already H.264 we copy the stream (fast, no CPU transcode); otherwise we
	// re-encode to H.264. Audio is always transcoded to AAC. The chosen audio
	// track is mapped when audio_track is supplied.
	vcodec := "libx264"
	if vc, _ := probeVideoCodec(ctx, p); vc == "h264" {
		vcodec = "copy"
	}
	args := []string{"-hide_banner", "-loglevel", "error", "-i", p, "-map", "0:v:0"}
	if audioTrack != "" {
		if n, err := strconv.Atoi(audioTrack); err == nil && n >= 0 {
			args = append(args, "-map", fmt.Sprintf("0:a:%d?", n))
		} else {
			args = append(args, "-map", "0:a:0?")
		}
	} else {
		args = append(args, "-map", "0:a:0?")
	}
	args = append(args, "-c:v", vcodec, "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", tmp)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
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
