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
	"net"
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
	mu                sync.RWMutex
	configMu          sync.Mutex // serializes runtime config read-modify-write transactions
	audioScrapeMu     sync.Mutex // MusicBrainz public API: globally serialize to <= 1 request/second
	audioScrapeLast   time.Time
	libs              []Library
	jobs              map[string]uint64             // library id -> running generation
	generations       map[string]uint64             // invalidates stale scans after delete/recreate
	deleting          map[string]bool               // blocks ID reuse until DB cleanup completes
	scanCancel        map[string]context.CancelFunc // library id -> cancel its running scan
	tasks             map[string]context.CancelFunc // transcode task id -> cancel
	db                *sql.DB
	scanGate          chan struct{} // size-1 semaphore: only one scan writes at a time
	config, indexDir  string
	cacheDir          string
	cacheMaxBytes     int64
	cacheMaxAge       time.Duration
	cacheCleanup      time.Duration
	cacheWake         chan struct{}
	runtimeConfig     string
	metadataOverrides string
	scraperMode       string
	tmdbAPIKey        string
	tmdbAPIBase       string
	tmdbImageBase     string
	tvdbAPIKey        string
	tvdbAPIBase       string
	scraperProxy      string
	configTrusted     bool // false when config exists but cannot be read/decoded
	// Hooks are test-only fault/interleaving instrumentation, nil in production.
	scanWriteHook     func(string, int)
	removeHook        func(string)
	removeDBHook      func(string) error
	saveLibrariesHook func([]Library) error

	// playbackSessions tracks active browser playback heartbeats. Sessions are
	// deliberately in-memory: persistent resume progress remains client-owned in
	// v0.8.8, while this lifecycle map lets abandoned FFmpeg tasks be reclaimed.
	playbackSessions map[string]playbackSession
}
type FileEntry struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}
type RuntimeConfig struct {
	ScraperMode               string `json:"scraper_mode"`
	TMDBAPIKey                string `json:"tmdb_api_key,omitempty"`
	TMDBAPIBase               string `json:"tmdb_api_base"`
	TMDBImageBase             string `json:"tmdb_image_base"`
	TVDBAPIKey                string `json:"tvdb_api_key,omitempty"`
	TVDBAPIBase               string `json:"tvdb_api_base"`
	ScraperProxy              string `json:"scraper_proxy,omitempty"`
	ScraperProxySet           bool   `json:"scraper_proxy_set,omitempty"`
	CacheDir                  string `json:"cache_dir"`
	CacheMaxBytes             int64  `json:"cache_max_bytes"`
	CacheMaxAgeHours          int64  `json:"cache_max_age_hours"`
	CacheCleanupIntervalHours int64  `json:"cache_cleanup_interval_hours"`
}

type playbackClient struct {
	MP4  bool `json:"mp4"`
	MSE  bool `json:"mse"`
	H264 bool `json:"h264"`
	HEVC bool `json:"hevc"`
	VP9  bool `json:"vp9"`
	AAC  bool `json:"aac"`
	Opus bool `json:"opus"`
}

type playbackMedia struct {
	Container  string `json:"container"`
	VideoCodec string `json:"video_codec"`
	AudioCodec string `json:"audio_codec"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	BitRate    string `json:"bit_rate"`
	Duration   string `json:"duration"`
}

type playbackPlan struct {
	Layer       string        `json:"layer"`
	Mode        string        `json:"mode"`
	Reason      string        `json:"reason"`
	URL         string        `json:"url"`
	VideoAction string        `json:"video_action"`
	AudioAction string        `json:"audio_action"`
	Hardware    string        `json:"hardware"`
	// MaxHeight caps the output height when the caller asked for an explicit
	// transcode quality (v0.9.41 播放器设置 → 转码质量). 0 means "no cap".
	MaxHeight   int           `json:"max_height,omitempty"`
	Media       playbackMedia `json:"media"`
}

type playbackSession struct {
	ID         string `json:"id"`
	LibraryID  string `json:"library_id"`
	Path       string `json:"path"`
	Mode       string `json:"mode"`
	State      string `json:"state"`
	PositionMS int64  `json:"position_ms"`
	DurationMS int64  `json:"duration_ms"`
	UpdatedAt  int64  `json:"updated_at"`
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func envInt64(k string, d int64) int64 {
	v, e := strconv.ParseInt(os.Getenv(k), 10, 64)
	if e != nil || v < 0 {
		return d
	}
	return v
}
func (a *App) load() {
	a.config = env("MEDIA_CONFIG", "/data/media-libraries.json")
	a.indexDir = env("MEDIA_INDEX_DIR", "/data/media-index")
	a.cacheDir = env("MEDIA_CACHE_DIR", "/data/transcode-cache")
	a.cacheMaxBytes = envInt64("MEDIA_CACHE_MAX_BYTES", 10*1024*1024*1024)
	a.cacheMaxAge = time.Duration(envInt64("MEDIA_CACHE_MAX_AGE_HOURS", 168)) * time.Hour
	a.cacheCleanup = time.Duration(envInt64("MEDIA_CACHE_CLEANUP_INTERVAL_HOURS", 24)) * time.Hour
	a.cacheWake = make(chan struct{}, 1)
	a.runtimeConfig = env("MEDIA_RUNTIME_CONFIG", "/data/media-runtime.json")
	a.metadataOverrides = env("MEDIA_METADATA_OVERRIDES", "/data/media-metadata-overrides.json")
	a.scraperMode = env("MEDIA_SCRAPER_MODE", "auto")
	a.tmdbAPIKey = os.Getenv("TMDB_API_KEY")
	a.tmdbAPIBase = strings.TrimRight(env("TMDB_API_BASE", "https://api.themoviedb.org/3"), "/")
	a.tmdbImageBase = strings.TrimRight(env("TMDB_IMAGE_BASE", "https://image.tmdb.org/t/p"), "/")
	a.tvdbAPIKey = os.Getenv("TVDB_API_KEY")
	a.tvdbAPIBase = strings.TrimRight(env("TVDB_API_BASE", "https://api4.thetvdb.com/v4"), "/")
	a.scraperProxy = os.Getenv("SCRAPER_PROXY")
	/* v0.9.30：符号链接边界 = MEDIA_ROOT 挂载点，媒体卷之间互链可用，系统路径仍禁止。 */
	mediaRootPath = env("MEDIA_ROOT", "/media")
	a.loadRuntimeConfig()
	b, e := os.ReadFile(a.config)
	if e == nil {
		a.configTrusted = json.Unmarshal(b, &a.libs) == nil
	} else {
		a.configTrusted = os.IsNotExist(e)
	}
	a.jobs = map[string]uint64{}
	a.generations = map[string]uint64{}
	a.deleting = map[string]bool{}
	a.scanCancel = map[string]context.CancelFunc{}
	a.tasks = map[string]context.CancelFunc{}
	a.playbackSessions = map[string]playbackSession{}
	a.scanGate = make(chan struct{}, 1)
	a.openDB()
	go a.cacheJanitor()
}

// cacheJanitor bounds the optional FFmpeg compatibility cache by both age and
// total bytes. Files are sorted oldest-first, so active/newer transcodes survive
// until the configured quota is reached. A dedicated directory can be mounted
// to a large data volume instead of consuming the system disk.
func (a *App) cacheJanitor() {
	a.cleanCache()
	for {
		a.mu.RLock()
		interval := a.cacheCleanup
		wake := a.cacheWake
		a.mu.RUnlock()
		if interval <= 0 {
			interval = 24 * time.Hour
		}
		timer := time.NewTimer(interval)
		select {
		case <-timer.C:
		case <-wake:
			if !timer.Stop() {
				<-timer.C
			}
		}
		a.cleanCache()
	}
}
func (a *App) cleanCache() {
	a.mu.RLock()
	cacheDir, cacheMaxBytes, cacheMaxAge := a.cacheDir, a.cacheMaxBytes, a.cacheMaxAge
	a.mu.RUnlock()
	if cacheMaxBytes <= 0 && cacheMaxAge <= 0 {
		return
	}
	ents, e := os.ReadDir(cacheDir)
	if e != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	items := make([]item, 0, len(ents))
	var total int64
	now := time.Now()
	for _, ent := range ents {
		if ent.IsDir() || filepath.Ext(ent.Name()) != ".mp4" {
			continue
		}
		info, e := ent.Info()
		if e != nil {
			continue
		}
		p := filepath.Join(cacheDir, ent.Name())
		if cacheMaxAge > 0 && now.Sub(info.ModTime()) > cacheMaxAge {
			_ = os.Remove(p)
			continue
		}
		items = append(items, item{p, info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items {
		if cacheMaxBytes <= 0 || total <= cacheMaxBytes {
			break
		}
		if os.Remove(it.path) == nil {
			total -= it.size
		}
	}
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
CREATE TABLE IF NOT EXISTS scan_staging(
  lib        TEXT NOT NULL,
  generation INTEGER NOT NULL,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  PRIMARY KEY(lib, generation, path)
);
CREATE INDEX IF NOT EXISTS idx_scan_staging_job ON scan_staging(lib, generation);
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
	a.cleanupOrphanIndexes()
	a.migrateLegacyIndexes()
}

// cleanupOrphanIndexes removes crash-only staging rows and index rows whose
// library is no longer present in the persisted configuration. This also makes
// a prior delete safe after a process restart during a double storage failure.
func (a *App) cleanupOrphanIndexes() {
	configured := map[string]bool{}
	for _, l := range a.libs {
		configured[l.ID] = true
	}
	_, _ = a.db.Exec(`DELETE FROM scan_staging`)
	if !a.configTrusted {
		return
	}
	for _, table := range []string{"files", "index_status"} {
		rs, e := a.db.Query(`SELECT DISTINCT lib FROM ` + table)
		if e != nil {
			continue
		}
		var orphaned []string
		for rs.Next() {
			var id string
			if rs.Scan(&id) == nil && !configured[id] {
				orphaned = append(orphaned, id)
			}
		}
		_ = rs.Close()
		for _, id := range orphaned {
			_, _ = a.db.Exec(`DELETE FROM `+table+` WHERE lib=?`, id)
		}
	}
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

// managerSessionOK asks the co-located Go manager whether the caller's session
// cookie is still valid. The manager owns the session store and idle timeout.
var managerSessionOK = func(r *http.Request) bool {
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

// writeAuth guards every mutating media endpoint through the manager-owned
// HttpOnly session cookie. Password login is the only write authority.
func writeAuth(r *http.Request) bool {
	return managerSessionOK(r)
}

func (a *App) runtimeConfigSnapshot(includeSecret bool) map[string]any {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := map[string]any{
		"scraper_mode": a.scraperMode, "tmdb_enabled": a.tmdbAPIKey != "",
		"tmdb_api_key_masked": a.tmdbAPIKey != "", "tmdb_api_base": a.tmdbAPIBase,
		"tmdb_image_base": a.tmdbImageBase, "cache_dir": a.cacheDir,
		"tvdb_enabled": a.tvdbAPIKey != "", "tvdb_api_key_masked": a.tvdbAPIKey != "", "tvdb_api_base": a.tvdbAPIBase,
		"scraper_proxy": "", "scraper_proxy_display": maskedProxyURL(a.scraperProxy), "scraper_proxy_configured": a.scraperProxy != "",
		"cache_max_bytes": a.cacheMaxBytes, "cache_max_age_hours": int64(a.cacheMaxAge / time.Hour),
		"cache_cleanup_interval_hours": int64(a.cacheCleanup / time.Hour),
	}
	if includeSecret {
		out["tmdb_api_key"] = a.tmdbAPIKey
		out["tvdb_api_key"] = a.tvdbAPIKey
	}
	return out
}
func (a *App) loadRuntimeConfig() {
	b, err := os.ReadFile(a.runtimeConfig)
	if err != nil {
		return
	}
	var c RuntimeConfig
	if json.Unmarshal(b, &c) != nil {
		return
	}
	if c.ScraperMode != "" {
		a.scraperMode = c.ScraperMode
	}
	if c.TMDBAPIKey != "" {
		a.tmdbAPIKey = c.TMDBAPIKey
	}
	if c.TMDBAPIBase != "" {
		a.tmdbAPIBase = strings.TrimRight(c.TMDBAPIBase, "/")
	}
	if c.TMDBImageBase != "" {
		a.tmdbImageBase = strings.TrimRight(c.TMDBImageBase, "/")
	}
	if c.TVDBAPIKey != "" {
		a.tvdbAPIKey = c.TVDBAPIKey
	}
	if c.TVDBAPIBase != "" {
		a.tvdbAPIBase = strings.TrimRight(c.TVDBAPIBase, "/")
	}
	if c.ScraperProxy != "" || c.ScraperProxySet {
		a.scraperProxy = c.ScraperProxy
	}
	if c.CacheDir != "" {
		a.cacheDir = c.CacheDir
	}
	if c.CacheMaxBytes >= 0 {
		a.cacheMaxBytes = c.CacheMaxBytes
	}
	if c.CacheMaxAgeHours >= 0 {
		a.cacheMaxAge = time.Duration(c.CacheMaxAgeHours) * time.Hour
	}
	if c.CacheCleanupIntervalHours > 0 {
		a.cacheCleanup = time.Duration(c.CacheCleanupIntervalHours) * time.Hour
	}
}
func validHTTPBase(v string) bool {
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" || host == "localhost" {
		return false
	}
	if host == "api.themoviedb.org" || host == "image.tmdb.org" || host == "api4.thetvdb.com" || host == "api.thetvdb.com" {
		return u.Scheme == "https"
	}
	if ip := net.ParseIP(host); ip != nil {
		return publicIP(ip)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(addrs) == 0 {
		return false
	}
	for _, addr := range addrs {
		if !publicIP(addr.IP) {
			return false
		}
	}
	return true
}
func publicIP(ip net.IP) bool {
	return ip != nil && !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsUnspecified() && !ip.IsMulticast()
}
func safeHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(ips) == 0 {
			return nil, fmt.Errorf("target resolution failed")
		}
		for _, item := range ips {
			if !publicIP(item.IP) {
				return nil, fmt.Errorf("private target rejected")
			}
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}}
	client := &http.Client{Timeout: 12 * time.Second, Transport: transport}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !validHTTPBase(req.URL.Scheme+"://"+req.URL.Host) {
			return http.ErrUseLastResponse
		}
		return nil
	}
	return client
}
func (a *App) saveRuntimeConfig(c RuntimeConfig) error {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	if c.ScraperMode != "auto" && c.ScraperMode != "tmdb" && c.ScraperMode != "douban" && c.ScraperMode != "filename" {
		return fmt.Errorf("invalid scraper mode")
	}
	if !validHTTPBase(c.TMDBAPIBase) || !validHTTPBase(c.TMDBImageBase) {
		return fmt.Errorf("invalid TMDB URL")
	}
	if c.TVDBAPIBase == "" {
		a.mu.RLock()
		c.TVDBAPIBase = a.tvdbAPIBase
		a.mu.RUnlock()
		if c.TVDBAPIBase == "" {
			c.TVDBAPIBase = "https://api4.thetvdb.com/v4"
		}
	}
	if !validHTTPBase(c.TVDBAPIBase) {
		return fmt.Errorf("invalid TVDB URL")
	}
	if _, err := validateProxyURL(c.ScraperProxy); err != nil {
		return err
	}
	if !filepath.IsAbs(c.CacheDir) || c.CacheMaxBytes < 0 || c.CacheMaxAgeHours < 0 || c.CacheCleanupIntervalHours <= 0 {
		return fmt.Errorf("invalid cache settings")
	}
	if err := os.MkdirAll(c.CacheDir, 0755); err != nil {
		return fmt.Errorf("cache directory: %w", err)
	}
	if c.TMDBAPIKey == "" {
		a.mu.RLock()
		c.TMDBAPIKey = a.tmdbAPIKey
		a.mu.RUnlock()
	}
	if c.TVDBAPIKey == "" {
		a.mu.RLock()
		c.TVDBAPIKey = a.tvdbAPIKey
		a.mu.RUnlock()
	}
	if c.ScraperProxy == "" && !c.ScraperProxySet {
		a.mu.RLock()
		c.ScraperProxy = a.scraperProxy
		a.mu.RUnlock()
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := os.MkdirAll(filepath.Dir(a.runtimeConfig), 0755); err != nil {
		return err
	}
	tmpFile, err := os.CreateTemp(filepath.Dir(a.runtimeConfig), ".media-runtime-*.tmp")
	if err != nil {
		return err
	}
	tmp := tmpFile.Name()
	defer os.Remove(tmp)
	if err := tmpFile.Chmod(0600); err != nil {
		tmpFile.Close()
		return err
	}
	if _, err := tmpFile.Write(b); err != nil {
		tmpFile.Close()
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, a.runtimeConfig); err != nil {
		return err
	}
	a.mu.Lock()
	a.scraperMode, a.tmdbAPIKey = c.ScraperMode, c.TMDBAPIKey
	a.tmdbAPIBase, a.tmdbImageBase = strings.TrimRight(c.TMDBAPIBase, "/"), strings.TrimRight(c.TMDBImageBase, "/")
	a.tvdbAPIKey, a.tvdbAPIBase, a.scraperProxy = c.TVDBAPIKey, strings.TrimRight(c.TVDBAPIBase, "/"), c.ScraperProxy
	a.cacheDir, a.cacheMaxBytes = c.CacheDir, c.CacheMaxBytes
	a.cacheMaxAge, a.cacheCleanup = time.Duration(c.CacheMaxAgeHours)*time.Hour, time.Duration(c.CacheCleanupIntervalHours)*time.Hour
	a.mu.Unlock()
	select {
	case a.cacheWake <- struct{}{}:
	default:
	}
	return nil
}
func (a *App) runtimeSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		if !writeAuth(r) {
			errJSON(w, 401, "login required")
			return
		}
		writeJSON(w, 200, a.runtimeConfigSnapshot(false))
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		errJSON(w, 405, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	var c RuntimeConfig
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&c) != nil {
		errJSON(w, 400, "invalid JSON")
		return
	}
	if err := a.saveRuntimeConfig(c); err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, a.runtimeConfigSnapshot(false))
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

// sqliteLikeEscape neutralises LIKE wildcards so a search for "100%" or "a_b"
// matches those literal characters instead of turning into a wildcard query.
// Callers must pair it with ESCAPE '\' in the SQL statement.
func sqliteLikeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}
func (a *App) saveLibrariesLocked(libs []Library) error {
	if a.saveLibrariesHook != nil {
		if e := a.saveLibrariesHook(libs); e != nil {
			return e
		}
	}
	_ = os.MkdirAll(filepath.Dir(a.config), 0755)
	b, e := json.MarshalIndent(libs, "", "  ")
	if e != nil {
		return e
	}
	tmp, e := os.CreateTemp(filepath.Dir(a.config), ".media-libraries-*.tmp")
	if e != nil {
		return e
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if e = tmp.Chmod(0644); e == nil {
		_, e = tmp.Write(b)
	}
	if closeErr := tmp.Close(); e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	return os.Rename(tmpName, a.config)
}

func (a *App) save() error {
	return a.saveLibrariesLocked(a.libs)
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
	// v0.9.30: the resolved path may stay inside the library root or inside the
	// media mount point (MEDIA_ROOT). Libraries routinely link folders from a
	// second media volume, and the old library-only rule made those items both
	// unscannable and unservable. System paths outside MEDIA_ROOT remain denied,
	// and the request itself still cannot contain "..", an absolute path or a
	// backslash, so only links placed inside the library can reach the boundary.
	if !allowedRealPath(root, p) {
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
		if a.deleting[l.ID] {
			a.mu.Unlock()
			errJSON(w, 409, "library id is being deleted")
			return
		}
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
		next := append(append([]Library(nil), a.libs...), l)
		e = a.saveLibrariesLocked(next)
		if e == nil {
			a.libs = next
		}
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
		found, e := a.removeLibrary(id)
		if !found {
			errJSON(w, 404, "library not found")
			return
		}
		if e != nil {
			errJSON(w, 500, "configuration write failed")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	errJSON(w, 405, "method not allowed")
}

// removeLibrary persists configuration first, then invalidates/cancels the
// running generation and clears all index state under the scan writer gate.
func (a *App) removeLibrary(id string) (bool, error) {
	a.mu.Lock()
	n := -1
	for i, x := range a.libs {
		if x.ID == id {
			n = i
			break
		}
	}
	if n < 0 {
		a.mu.Unlock()
		return false, nil
	}
	previous := append([]Library(nil), a.libs...)
	next := append([]Library(nil), a.libs[:n]...)
	next = append(next, a.libs[n+1:]...)
	if e := a.saveLibrariesLocked(next); e != nil {
		a.mu.Unlock()
		return true, e
	}
	a.libs = next
	a.generations[id]++
	a.deleting[id] = true
	if cancel := a.scanCancel[id]; cancel != nil {
		cancel()
	}
	delete(a.scanCancel, id)
	delete(a.jobs, id)
	a.mu.Unlock()
	if a.removeHook != nil {
		a.removeHook(id)
	}

	a.scanGate <- struct{}{}
	if a.removeDBHook != nil {
		if e := a.removeDBHook(id); e != nil {
			<-a.scanGate
			return true, a.rollbackLibraryRemoval(id, previous, e)
		}
	}
	tx, e := a.db.Begin()
	if e != nil {
		<-a.scanGate
		return true, a.rollbackLibraryRemoval(id, previous, e)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for _, q := range []string{
		`DELETE FROM files WHERE lib=?`,
		`DELETE FROM index_status WHERE lib=?`,
		`DELETE FROM scan_staging WHERE lib=?`,
	} {
		if _, e = tx.Exec(q, id); e != nil {
			_ = tx.Rollback()
			<-a.scanGate
			return true, a.rollbackLibraryRemoval(id, previous, e)
		}
	}
	if e = tx.Commit(); e != nil {
		<-a.scanGate
		return true, a.rollbackLibraryRemoval(id, previous, e)
	}
	committed = true
	<-a.scanGate
	a.mu.Lock()
	delete(a.deleting, id)
	a.mu.Unlock()
	return true, nil
}

// rollbackLibraryRemoval restores the prior configuration if DB cleanup could
// not be committed. Callers have already released scanGate before entering.
func (a *App) rollbackLibraryRemoval(id string, previous []Library, cause error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	// The ID is protected by deleting, so no concurrent POST can have reused it.
	if e := a.saveLibrariesLocked(previous); e != nil {
		// Keep deleting[id] set: the on-disk config already removed this ID but
		// stale DB rows may remain. Blocking reuse is safer than exposing those
		// rows under a newly created library. A process restart resets the guard
		// after the operator has resolved the underlying storage failure.
		return fmt.Errorf("index cleanup failed: %v; configuration rollback failed (id remains blocked): %w", cause, e)
	}
	a.libs = previous
	delete(a.deleting, id)
	return cause
}

// start launches a background rescan for a library unless one is already
// running. The scan streams results into SQLite in batches so /api/media/files
// stays responsive, and it honours a per-library cancel func.
func (a *App) start(l Library) {
	a.mu.Lock()
	if a.jobs[l.ID] != 0 {
		a.mu.Unlock()
		return
	}
	a.generations[l.ID]++
	generation := a.generations[l.ID]
	ctx, cancel := context.WithCancel(context.Background())
	a.jobs[l.ID] = generation
	a.scanCancel[l.ID] = cancel
	a.mu.Unlock()

	go func() {
		start := time.Now().Unix()
		a.setStatusIfCurrent(l.ID, generation, "scanning", 0, 0, start, 0, "")

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
		// v0.9.30: 深度扫描。filepath.Walk 用 lstat 判断类型，符号链接目录不会
		// 被递归、符号链接文件被当成非普通文件跳过，NAS 上常见的「季目录/合集
		// 指向别处」于是整块缺失。walkLibraryFiles 改用 stat 穿透链接，并保留
		// 「解析后必须仍在媒体根内」和「访问过的真实目录去重防环」两条约束。
		walkErr := walkLibraryFiles(ctx, l.Path, scanMaxDepth(), func(f scannedFile) {
			rows = append(rows, row{f.Rel, f.Size, f.MTime})
			if len(rows)%5000 == 0 {
				a.setStatusIfCurrent(l.ID, generation, "scanning", len(rows), 0, start, 0, "")
			}
		})
		if ctx.Err() != nil {
			cancelled = true
		}
		if cancelled {
			a.finishScan(l.ID, generation, "cancelled", len(rows), "scan cancelled")
			return
		}
		if walkErr != nil && walkErr != io.EOF {
			a.finishScan(l.ID, generation, "error", len(rows), walkErr.Error())
			return
		}

		// Phase 2 writes into a generation-scoped staging table in bounded
		// transactions. Readers keep serving the complete old index throughout.
		// Only a fully staged, still-current generation is atomically published.
		a.scanGate <- struct{}{}
		defer func() { <-a.scanGate }()
		cleanupStage := func() {
			_, _ = a.db.Exec(`DELETE FROM scan_staging WHERE lib=? AND generation=?`, l.ID, generation)
		}
		if ctx.Err() != nil || !a.scanCurrent(l.ID, generation) {
			cleanupStage()
			a.finishScan(l.ID, generation, "cancelled", 0, "scan cancelled")
			return
		}
		cleanupStage()
		const batch = 2000
		written := 0
		for off := 0; off < len(rows); off += batch {
			if ctx.Err() != nil || !a.scanCurrent(l.ID, generation) {
				cleanupStage()
				a.finishScan(l.ID, generation, "cancelled", written, "scan cancelled")
				return
			}
			end := off + batch
			if end > len(rows) {
				end = len(rows)
			}
			tx, e := a.db.Begin()
			if e != nil {
				cleanupStage()
				a.finishScan(l.ID, generation, "error", written, e.Error())
				return
			}
			st, e := tx.Prepare(`INSERT OR REPLACE INTO scan_staging(lib,generation,path,size,mtime) VALUES(?,?,?,?,?)`)
			if e != nil {
				tx.Rollback()
				cleanupStage()
				a.finishScan(l.ID, generation, "error", written, e.Error())
				return
			}
			for _, x := range rows[off:end] {
				if _, e = st.Exec(l.ID, generation, x.path, x.size, x.mtime); e != nil {
					break
				}
			}
			_ = st.Close()
			if e != nil {
				tx.Rollback()
				cleanupStage()
				a.finishScan(l.ID, generation, "error", written, e.Error())
				return
			}
			if e = tx.Commit(); e != nil {
				cleanupStage()
				a.finishScan(l.ID, generation, "error", written, e.Error())
				return
			}
			written = end
			a.setStatusIfCurrent(l.ID, generation, "scanning", written, len(rows), start, 0, "")
			if a.scanWriteHook != nil {
				a.scanWriteHook(l.ID, written)
			}
		}
		a.mu.Lock()
		if ctx.Err() != nil || a.generations[l.ID] != generation || a.jobs[l.ID] != generation {
			a.mu.Unlock()
			cleanupStage()
			a.finishScan(l.ID, generation, "cancelled", written, "scan cancelled")
			return
		}
		tx, e := a.db.Begin()
		if e == nil {
			_, e = tx.Exec(`DELETE FROM files WHERE lib=?`, l.ID)
		}
		if e == nil {
			_, e = tx.Exec(`INSERT INTO files(lib,path,size,mtime) SELECT lib,path,size,mtime FROM scan_staging WHERE lib=? AND generation=?`, l.ID, generation)
		}
		if e == nil {
			_, e = tx.Exec(`DELETE FROM scan_staging WHERE lib=? AND generation=?`, l.ID, generation)
		}
		if e == nil {
			e = tx.Commit()
		} else if tx != nil {
			_ = tx.Rollback()
		}
		if e != nil {
			a.mu.Unlock()
			cleanupStage()
			a.finishScan(l.ID, generation, "error", written, e.Error())
			return
		}
		a.setStatus(l.ID, "ready", len(rows), len(rows), 0, time.Now().Unix(), "")
		delete(a.jobs, l.ID)
		delete(a.scanCancel, l.ID)
		a.mu.Unlock()
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

func (a *App) scanCurrent(lib string, generation uint64) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.generations[lib] == generation && a.jobs[lib] == generation
}

func (a *App) setStatusIfCurrent(lib string, generation uint64, state string, scanned, total int, started, ended int64, msg string) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.generations[lib] != generation || a.jobs[lib] != generation {
		return
	}
	a.setStatus(lib, state, scanned, total, started, ended, msg)
}

func (a *App) finishScan(lib string, generation uint64, state string, scanned int, msg string) {
	a.mu.RLock()
	if a.generations[lib] != generation || a.jobs[lib] != generation {
		a.mu.RUnlock()
		return
	}
	a.setStatus(lib, state, scanned, scanned, 0, time.Now().Unix(), msg)
	a.mu.RUnlock()
	a.mu.Lock()
	if a.jobs[lib] == generation {
		delete(a.jobs, lib)
		delete(a.scanCancel, lib)
	}
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
	for k, generation := range a.jobs {
		jobs[k] = generation != 0
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
		// Percent and Elapsed let the UI show a live build progress bar instead
		// of a static "please refresh later" placeholder.
		Percent int   `json:"percent"`
		Elapsed int64 `json:"elapsed"`
		Now     int64 `json:"now"`
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
	now := time.Now().Unix()
	for id, s := range rows {
		s.Running = jobs[id]
		if s.Running {
			anyRunning = true
			if s.State != "scanning" {
				s.State = "scanning"
			}
		}
		// Percent is only meaningful once phase 2 knows the row total. During
		// phase 1 (filesystem walk) Total is still 0, so the UI falls back to
		// showing the scanned counter plus elapsed time.
		if s.Total > 0 {
			p := s.Scanned * 100 / s.Total
			if p > 100 {
				p = 100
			}
			if s.Running && p >= 100 {
				p = 99
			}
			s.Percent = p
		} else if !s.Running && s.State == "ready" {
			s.Percent = 100
		}
		s.Now = now
		if s.StartedAt > 0 {
			end := s.EndedAt
			if s.Running || end <= 0 {
				end = now
			}
			if end > s.StartedAt {
				s.Elapsed = end - s.StartedAt
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
	busy := a.jobs[id] != 0
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
		writeJSON(w, 200, map[string]any{"status": "indexing", "total": 0, "offset": 0, "limit": 100, "has_more": false, "files": []FileEntry{}, "scanning": true})
		return
	}
	// A scan is in flight and has not written any rows yet: report indexing so
	// the UI can show a live progress bar polled from /api/media/index/status.
	if total == 0 && busy {
		writeJSON(w, 200, map[string]any{"status": "indexing", "total": 0, "offset": 0, "limit": 100, "has_more": false, "files": []FileEntry{}, "scanning": true})
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
	// sort=mtime powers the home page "recently added" rails; default stays
	// path order so the file browser keeps its stable alphabetical listing.
	order := "path"
	if r.URL.Query().Get("sort") == "mtime" {
		order = "mtime DESC, path"
	}
	// q filters by path substring (case-insensitive) so the 媒体搜索 page can
	// query the index directly instead of downloading every library page.
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q != "" {
		if len(q) > 200 {
			q = q[:200]
		}
		like := "%" + strings.ToLower(sqliteLikeEscape(q)) + "%"
		if e := a.db.QueryRow(`SELECT count(*) FROM files WHERE lib=? AND lower(path) LIKE ? ESCAPE '\'`, id, like).Scan(&total); e != nil {
			total = 0
		}
		rows, e := a.db.Query(`SELECT path,size,mtime FROM files WHERE lib=? AND lower(path) LIKE ? ESCAPE '\' ORDER BY `+order+` LIMIT ? OFFSET ?`, id, like, lim, off)
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
		writeJSON(w, 200, map[string]any{"status": status, "total": total, "offset": off, "limit": lim, "query": q, "has_more": off+len(files) < total, "files": files})
		return
	}
	rows, e := a.db.Query(`SELECT path,size,mtime FROM files WHERE lib=? ORDER BY `+order+` LIMIT ? OFFSET ?`, id, lim, off)
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

func (a *App) cacheKey(path string) string {
	h := sha256.Sum256([]byte(path))
	a.mu.RLock()
	dir := a.cacheDir
	a.mu.RUnlock()
	return filepath.Join(dir, hex.EncodeToString(h[:])+".mp4")
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
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	b, e := exec.CommandContext(ctx, "ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", p).Output()
	if e != nil {
		writeJSON(w, 200, map[string]any{"audio_codec": "", "video_codec": "", "container_likely_supported": false, "audio_likely_supported": true, "compat_recommended": true})
		return
	}
	var x struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		} `json:"streams"`
		Format struct {
			FormatName string `json:"format_name"`
			BitRate    string `json:"bit_rate"`
			Duration   string `json:"duration"`
		} `json:"format"`
	}
	_ = json.Unmarshal(b, &x)
	ac, vc := "", ""
	width, height := 0, 0
	for _, s := range x.Streams {
		if s.CodecType == "audio" && ac == "" {
			ac = s.CodecName
		}
		if s.CodecType == "video" && vc == "" {
			vc, width, height = s.CodecName, s.Width, s.Height
		}
	}
	ext := strings.ToLower(filepath.Ext(p))
	container := ext == ".mp4" || ext == ".m4v" || ext == ".webm" || ext == ".ogv" || ext == ".ogg"
	audio := ac == "" || map[string]bool{"aac": true, "mp3": true, "opus": true, "vorbis": true, "flac": true}[ac]
	writeJSON(w, 200, map[string]any{"audio_codec": ac, "video_codec": vc, "width": width, "height": height, "format_name": x.Format.FormatName, "container": strings.TrimPrefix(ext, "."), "bit_rate": x.Format.BitRate, "duration": x.Format.Duration, "video_metadata": true, "container_likely_supported": container, "audio_likely_supported": audio, "compat_recommended": !container || !audio})
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
var probeVideoCodec = func(ctx context.Context, p string) (string, error) {
	b, e := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nk=1:nw=1", p).Output()
	if e != nil {
		return "", e
	}
	return strings.TrimSpace(string(b)), nil
}

// hwCache memoises the detection result: probing ffmpeg encoders spawns a
// process, and the settings page polls this endpoint on every open.
var (
	hwMu    sync.Mutex
	hwProbe map[string]bool
)

// ffmpegEncoders returns the set of encoder names ffmpeg was built with.
func ffmpegEncoders(ctx context.Context) map[string]bool {
	hwMu.Lock()
	defer hwMu.Unlock()
	if hwProbe != nil {
		return hwProbe
	}
	found := map[string]bool{}
	if b, e := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-encoders").Output(); e == nil {
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Fields(strings.TrimSpace(line))
			if len(f) >= 2 {
				found[f[1]] = true
			}
		}
		hwProbe = found
	}
	return found
}

// vaapiDevice returns the first usable DRM render node, or "" when the
// container has no /dev/dri passed through.
func vaapiDevice() string {
	if d := os.Getenv("VAAPI_DEVICE"); d != "" {
		if _, e := os.Stat(d); e == nil {
			return d
		}
	}
	ents, e := os.ReadDir("/dev/dri")
	if e != nil {
		return ""
	}
	for _, x := range ents {
		if strings.HasPrefix(x.Name(), "renderD") {
			return "/dev/dri/" + x.Name()
		}
	}
	return ""
}

// nvidiaPresent reports whether an NVIDIA device node is visible, which is what
// the NVIDIA Container Toolkit injects.
func nvidiaPresent() bool {
	for _, p := range []string{"/dev/nvidiactl", "/dev/nvidia0", "/dev/nvidia-uvm"} {
		if _, e := os.Stat(p); e == nil {
			return true
		}
	}
	return false
}

// detectHardware inspects device nodes plus the encoders ffmpeg actually has
// and reports what acceleration is usable. "选择" resolves the requested mode
// (auto/cpu/vaapi/qsv/cuda) against availability, falling back to CPU.
func detectHardware(ctx context.Context, requested string) map[string]any {
	enc := ffmpegEncoders(ctx)
	dev := vaapiDevice()
	nvidia := nvidiaPresent()
	available := map[string]bool{
		"cpu":   true,
		"vaapi": dev != "" && enc["h264_vaapi"],
		"qsv":   dev != "" && enc["h264_qsv"],
		"cuda":  nvidia && enc["h264_nvenc"],
	}
	if requested == "" {
		requested = env("FFMPEG_HWACCEL", "auto")
	}
	selected := "cpu"
	switch requested {
	case "vaapi", "qsv", "cuda":
		if available[requested] {
			selected = requested
		}
	default: // auto: prefer the vendor-specific encoders before generic VAAPI
		for _, c := range []string{"qsv", "cuda", "vaapi"} {
			if available[c] {
				selected = c
				break
			}
		}
	}
	encoders := []string{}
	for _, name := range []string{"h264_vaapi", "h264_qsv", "h264_nvenc", "libx264"} {
		if enc[name] {
			encoders = append(encoders, name)
		}
	}
	return map[string]any{
		"configured":    requested,
		"selected":      selected,
		"available":     available,
		"vaapi_device":  dev,
		"nvidia_device": nvidia,
		"encoders":      encoders,
		"ffmpeg":        len(enc) > 0,
	}
}

// hwEncodeArgs maps a resolved acceleration mode to the ffmpeg input/output
// flags needed to encode H.264 on that device. CPU falls back to libx264 with
// a fast preset so software transcodes still start quickly.
func hwEncodeArgs(mode, device string) (pre []string, vcodec string, post []string) {
	switch mode {
	case "vaapi":
		if device != "" {
			return []string{"-hwaccel", "vaapi", "-hwaccel_device", device, "-hwaccel_output_format", "vaapi"},
				"h264_vaapi", []string{"-vf", "scale_vaapi=format=nv12"}
		}
	case "qsv":
		if device != "" {
			return []string{"-hwaccel", "qsv", "-qsv_device", device}, "h264_qsv", []string{"-global_quality", "23"}
		}
	case "cuda":
		return []string{"-hwaccel", "cuda"}, "h264_nvenc", []string{"-preset", "p4", "-cq", "23"}
	}
	return nil, "libx264", []string{"-preset", "veryfast", "-crf", "23", "-tune", "zerolatency"}
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
func (a *App) externalSubtitle(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
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
	ext := strings.ToLower(filepath.Ext(p))
	if ext == ".vtt" {
		f, e := os.Open(p)
		if e != nil {
			errJSON(w, 404, "subtitle not found")
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		io.Copy(w, f)
		return
	}
	if !map[string]bool{".srt": true, ".ass": true, ".ssa": true, ".sub": true}[ext] {
		errJSON(w, 400, "unsupported subtitle format")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", p, "-f", "webvtt", "pipe:1")
	pipe, e := cmd.StdoutPipe()
	if e != nil || cmd.Start() != nil {
		errJSON(w, 500, "subtitle convert failed")
		return
	}
	out, e := io.ReadAll(io.LimitReader(pipe, (8<<20)+1))
	if len(out) > 8<<20 {
		cancel()
		_ = cmd.Wait()
		errJSON(w, 413, "subtitle output too large")
		return
	}
	waitErr := cmd.Wait()
	if e != nil || waitErr != nil || len(out) == 0 {
		errJSON(w, 500, "subtitle convert failed")
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Write(out)
}
func cancelTask(w http.ResponseWriter, r *http.Request, a *App) {
	if r.Method != http.MethodPost {
		errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
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
	mux.HandleFunc("/api/media/settings", a.runtimeSettings)
	mux.HandleFunc("/api/media/scrapers", func(w http.ResponseWriter, r *http.Request) {
		out := a.runtimeConfigSnapshot(false)
		out["default"], out["types"] = out["scraper_mode"], []string{"movie", "series"}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("/api/media/hardware", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, detectHardware(r.Context(), r.URL.Query().Get("hw")))
	})
	mux.HandleFunc("/api/media/probe", func(w http.ResponseWriter, r *http.Request) { probe(w, r, a) })
	mux.HandleFunc("/api/media/playback/plan", a.playbackPlan)
	mux.HandleFunc("/api/media/playback/sessions", a.playbackSessionsHandler)
	mux.HandleFunc("/api/media/playback/sessions/", a.playbackSessionAction)
	mux.HandleFunc("/api/media/streams", func(w http.ResponseWriter, r *http.Request) { streams(w, r, a) })
	mux.HandleFunc("/api/media/tasks/cancel", func(w http.ResponseWriter, r *http.Request) { cancelTask(w, r, a) })
	mux.HandleFunc("/api/media/subtitles/search", a.subtitle)
	mux.HandleFunc("/api/media/subtitles/extract", a.extractSubtitle)
	mux.HandleFunc("/api/media/subtitles/proxy", a.externalSubtitle)
	mux.HandleFunc("/api/media/tmdb", a.tmdb)
	mux.HandleFunc("/api/media/tvdb", a.tvdb)
	mux.HandleFunc("/api/media/metadata", a.localMetadata)
	mux.HandleFunc("/api/media/metadata/override", a.metadataOverride)
	mux.HandleFunc("/api/media/metadata/artwork", a.artworkCandidates)
	mux.HandleFunc("/api/media/reading/progress", a.readingProgress)
	mux.HandleFunc("/api/media/audio/metadata", a.audioMetadata)
	mux.HandleFunc("/api/media/network/speed", a.networkSpeed)
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
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	a.mu.RLock()
	key, base, proxy := a.tmdbAPIKey, a.tmdbAPIBase, a.scraperProxy
	a.mu.RUnlock()
	if key == "" {
		errJSON(w, 400, "TMDB_API_KEY is not configured")
		return
	}
	mediaType := r.URL.Query().Get("type")
	endpoint := "search/movie"
	if mediaType == "series" || mediaType == "tv" {
		endpoint = "search/tv"
	}
	if id := r.URL.Query().Get("id"); id != "" {
		if _, err := strconv.ParseInt(id, 10, 64); err != nil {
			errJSON(w, 400, "invalid TMDB id")
			return
		}
		kind := "movie"
		if mediaType == "series" || mediaType == "tv" {
			kind = "tv"
		}
		endpoint = kind + "/" + id
	}
	u := base + "/" + endpoint + "?api_key=" + url.QueryEscape(key) + "&language=zh-CN&append_to_response=credits,recommendations"
	if strings.HasPrefix(endpoint, "search/") {
		u += "&query=" + url.QueryEscape(r.URL.Query().Get("query"))
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	client, clientErr := outboundHTTPClient(proxy)
	if clientErr != nil {
		errJSON(w, 400, clientErr.Error())
		return
	}
	res, e := client.Do(req)
	if e != nil {
		errJSON(w, 502, "tmdb scrape failed")
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(res.Body, 8<<20))
}

// compatBuilds tracks which cache keys already have a background build running
// so a burst of requests never starts the same transcode twice.
var (
	compatMu     sync.Mutex
	compatBuilds = map[string]bool{}
)

// compatArgs assembles the ffmpeg arguments shared by the live stream and the
// background cache build: pick the video codec (copy when the source is already
// H.264), map the requested audio track, and always deliver stereo AAC.
func compatArgs(ctx context.Context, p, audioTrack, hw, mode string) (pre []string, mid []string) {
	return compatArgsScaled(ctx, p, audioTrack, hw, mode, 0)
}

// compatArgsScaled builds the ffmpeg arguments for the compatibility stream.
// maxHeight > 0 caps the output height (v0.9.41 播放器 设置 → 转码质量); a cap
// forces a real re-encode because you cannot scale a copied stream.
func compatArgsScaled(ctx context.Context, p, audioTrack, hw, mode string, maxHeight int) (pre []string, mid []string) {
	vcodec := ""
	var post []string
	if vc, _ := probeVideoCodec(ctx, p); vc == "h264" && mode != "full_transcode" && maxHeight <= 0 {
		vcodec = "copy" // stream copy: no CPU transcode, starts instantly
	} else {
		hwInfo := detectHardware(ctx, hw)
		mode, _ := hwInfo["selected"].(string)
		dev, _ := hwInfo["vaapi_device"].(string)
		pre, vcodec, post = hwEncodeArgs(mode, dev)
		if maxHeight > 0 {
			post = withScaleFilter(post, vcodec, maxHeight)
		}
	}
	mid = []string{"-map", "0:v:0"}
	if n, err := strconv.Atoi(audioTrack); audioTrack != "" && err == nil && n >= 0 {
		mid = append(mid, "-map", fmt.Sprintf("0:a:%d?", n))
	} else {
		mid = append(mid, "-map", "0:a:0?")
	}
	mid = append(mid, "-c:v", vcodec)
	mid = append(mid, post...)
	if mode == "remux" && maxHeight <= 0 {
		mid = append(mid, "-c:a", "copy")
	} else {
		mid = append(mid, "-c:a", "aac", "-ac", "2", "-b:a", "160k")
	}
	return pre, mid
}

// scaleFilterValue returns the downscale filter for the chosen encoder. VAAPI
// frames live in GPU memory and must use scale_vaapi; everything else uses the
// software scaler. -2 keeps the width even, which H.264 requires, and
// min(ih,cap) means a source already below the cap is left alone rather than
// upscaled.
func scaleFilterValue(vcodec string, maxHeight int) string {
	if maxHeight <= 0 {
		return ""
	}
	if strings.HasSuffix(vcodec, "_vaapi") {
		return fmt.Sprintf("scale_vaapi=w=-2:h=min(ih\\,%d):format=nv12", maxHeight)
	}
	return fmt.Sprintf("scale=-2:min(ih\\,%d)", maxHeight)
}

// withScaleFilter installs the downscale filter into an encoder's output args.
// ffmpeg honours only the last -vf, so an existing filter (VAAPI's
// scale_vaapi=format=nv12) must be replaced instead of appended to.
func withScaleFilter(post []string, vcodec string, maxHeight int) []string {
	filter := scaleFilterValue(vcodec, maxHeight)
	if filter == "" {
		return post
	}
	out := make([]string, 0, len(post)+2)
	for i := 0; i < len(post); i++ {
		if post[i] == "-vf" || post[i] == "-filter:v" {
			i++ // drop the flag together with its value
			continue
		}
		out = append(out, post[i])
	}
	return append(out, "-vf", filter)
}

// buildCompatCache produces the seekable (faststart) MP4 in the background so
// the *next* open is a plain cache hit with full Range support. It deliberately
// uses a detached context: the user closing the tab must not abort it.
func (a *App) buildCompatCache(p, cache, audioTrack, hw, mode string, maxHeight int) {
	compatMu.Lock()
	if compatBuilds[cache] {
		compatMu.Unlock()
		return
	}
	compatBuilds[cache] = true
	compatMu.Unlock()
	go func() {
		defer func() { compatMu.Lock(); delete(compatBuilds, cache); compatMu.Unlock() }()
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
		defer cancel()
		tmp := cache + fmt.Sprintf(".bg-%d", os.Getpid())
		pre, mid := compatArgsScaled(ctx, p, audioTrack, hw, mode, maxHeight)
		args := append([]string{"-hide_banner", "-loglevel", "error"}, pre...)
		args = append(args, "-i", p)
		args = append(args, mid...)
		args = append(args, "-movflags", "+faststart", "-f", "mp4", "-y", tmp)
		if e := exec.CommandContext(ctx, "ffmpeg", args...).Run(); e != nil {
			_ = os.Remove(tmp)
			return
		}
		if e := os.Rename(tmp, cache); e != nil {
			_ = os.Remove(tmp)
		}
	}()
}

func (a *App) compat(w http.ResponseWriter, r *http.Request) {
	if !managerSessionOK(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
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
	hw := r.URL.Query().Get("hw")
	mode := r.URL.Query().Get("mode")
	if mode != "remux" && mode != "audio_transcode" && mode != "full_transcode" {
		mode = "audio_transcode"
	}
	// v0.9.41: height caps the output resolution (播放器 设置 → 转码质量). It is part
	// of the cache key so 1080p and 720p renditions never collide on disk.
	maxHeight := 0
	if n, err := strconv.Atoi(r.URL.Query().Get("height")); err == nil && n >= 144 && n <= 4320 {
		maxHeight = n
	}
	cache := a.cacheKey(fmt.Sprintf("%s:%d:%d:%s:%s:a%s:h%d", p, st.Size(), st.ModTime().UnixNano(), hw, mode, audioTrack, maxHeight))
	// Fully built cache: serve it with byte ranges so seeking works.
	if f, e := os.Open(cache); e == nil {
		defer f.Close()
		info, _ := f.Stat()
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("X-VaultHub-Compat", "cache")
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
	// Cache miss: stream a fragmented MP4 straight to the browser instead of
	// waiting for the whole transcode to land on disk. empty_moov+frag_keyframe
	// makes the output playable from the first fragment, so playback starts in
	// about a second even for a multi-gigabyte source. Range is intentionally
	// not honoured here (we answer 200 with the full stream); the seekable copy
	// is produced in the background for the next open.
	pre, mid := compatArgsScaled(ctx, p, audioTrack, hw, mode, maxHeight)
	args := append([]string{"-hide_banner", "-loglevel", "error"}, pre...)
	args = append(args, "-i", p)
	args = append(args, mid...)
	args = append(args, "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1")
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		errJSON(w, 500, "compat playback unavailable")
		return
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if e := cmd.Start(); e != nil {
		errJSON(w, 500, "compat playback unavailable")
		return
	}
	if env("COMPAT_PRECACHE", "1") != "0" {
		a.buildCompatCache(p, cache, audioTrack, hw, mode, maxHeight)
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-VaultHub-Compat", "live")
	w.WriteHeader(200)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 256*1024)
	for {
		n, re := stdout.Read(buf)
		if n > 0 {
			if _, we := w.Write(buf[:n]); we != nil {
				cancel()
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if re != nil {
			break
		}
	}
	_ = cmd.Wait()
}

var _ = time.Now
