package main

import (
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
	"regexp"
	"runtime"
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
	// v0.9.52：多存储路径支持 —— 单个媒体库可以挂载多个存储路径。
	// Paths 与 Path 互为补充：Path 是主路径（兼容旧版配置），Paths 是扩展路径列表。
	// 扫描时会遍历所有路径，文件路径以相对路径形式存储。
	Paths []string `json:"paths,omitempty"`
}
type App struct {
	mu                sync.RWMutex
	configMu          sync.Mutex // serializes runtime config read-modify-write transactions
	audioScrapeMu     sync.Mutex // MusicBrainz public API: globally serialize to <= 1 request/second
	audioScrapeLast   time.Time
	itunesScrapeMu    sync.Mutex // iTunes Search API: ~200ms/request 节流
	itunesScrapeLast  time.Time
	lyricsMu          sync.Mutex // v0.9.67: 歌词源全局节流（LRCLIB 突发会 503）
	lyricsLast        time.Time
	lyricsBatchSem    chan struct{} // v0.9.69: 批量歌词串行闸门（容量 1）
	artistAliasMu     sync.Mutex    // v0.9.71: 歌手别名表（MusicBrainz）缓存锁
	artistAliasCache  map[string]artistAliasEntry
	audioJobsMu       sync.Mutex // v0.9.71: 同键音频转码合并（singleflight）
	audioJobs         map[string]*audioJob
	zipCacheMu        sync.Mutex
	zipCache          *zipArchiveCache // v0.9.56: ZIP/CBZ 中央目录 LRU 缓存（漫画读取提速）
	pageCacheMu       sync.Mutex
	pageCache         *pageCache // v0.9.67: 归档页转码结果磁盘缓存（省流模式）
	pageCacheDirPinned bool      // v0.9.92: MEDIA_PAGE_CACHE_DIR 显式配置，运行时不再跟随 cache_dir
	pageJobsMu        sync.Mutex
	pageJobs          map[string]*pageJob // v0.9.67: 同页并发转码合并
	transcodeSemOnce  sync.Once
	transcodeSem      chan struct{} // v0.9.67: 转码全局并发闸门（防内存打爆）
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
	/* v0.9.91：转码缓存占用快照（由 cleanCache 更新），用于在设置页显示实际用量 ——
	   只看配额看不出「实际已超标」，这次生产事故就是这么来的。 */
	cacheBytes     int64
	cacheFiles     int
	cacheCleanedAt int64
	pageCacheDir      string
	pageCacheMaxBytes int64
	scanMaxDepth      int // v0.9.79: Web「媒体库」可在线改的扫描最大深度；0=默认 32
	cacheMaxAge       time.Duration
	cacheCleanup      time.Duration
	cacheWake         chan struct{}
	runtimeConfig     string
	metadataOverrides string
	scraperMode       string
	/* v0.9.87：刮削地区（auto/cn/jp/us）—— 决定 TMDB 请求 language，
	   让「按地区刮削」覆盖 TMDB 默认语言，避免中文界面下用中文查不到
	   日/美资源的原名而回落到资源名（文件名展示）。 */
	scrapeRegion string
	/* v0.9.88：TMDB 标题匹配的最低识别字符占比（默认 0.7）——
	   无需标题全量一致，70% 字符能对上就算命中；异常的靠手动编辑名称辅助。 */
	scrapeMinMatch float64
	/* v0.9.88：刮削结果服务端持久化（影视 / 电子书），进库先读、刮完写回，
	   避免换浏览器/换设备/多次批量扫描时整库重复联网刮削。 */
	scrapeCachePath   string
	scrapeCacheMu     sync.Mutex
	scrapeCache       scrapeCacheFile
	scrapeCacheLoaded bool
	tmdbAPIKey        string
	tmdbAPIBase       string
	tmdbImageBase     string
	tvdbAPIKey        string
	tvdbAPIBase       string
	scraperProxy      string
	sharePublicBase   string
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
	ScraperMode   string `json:"scraper_mode"`
	TMDBAPIKey    string `json:"tmdb_api_key,omitempty"`
	TMDBAPIBase   string `json:"tmdb_api_base"`
	TMDBImageBase string `json:"tmdb_image_base"`
	TVDBAPIKey    string `json:"tvdb_api_key,omitempty"`
	TVDBAPIBase   string `json:"tvdb_api_base"`
	ScraperProxy  string `json:"scraper_proxy,omitempty"`
	/* v0.9.87：刮削地区 —— auto（跟随界面语言）/ cn（zh-CN）/ jp（ja-JP）/ us（en-US）。 */
	ScrapeRegion string `json:"scrape_region,omitempty"`
	/* v0.9.88：标题匹配阈值（0.3–1.0，默认 0.7）。 */
	ScrapeMinMatch            float64 `json:"scrape_min_match,omitempty"`
	ScraperProxySet           bool    `json:"scraper_proxy_set,omitempty"`
	SharePublicBase           string  `json:"share_public_base,omitempty"`
	SharePublicBaseSet        bool    `json:"share_public_base_set,omitempty"`
	CacheDir                  string  `json:"cache_dir"`
	CacheMaxBytes             int64   `json:"cache_max_bytes"`
	CacheMaxAgeHours          int64   `json:"cache_max_age_hours"`
	CacheCleanupIntervalHours int64   `json:"cache_cleanup_interval_hours"`
	// v0.9.79：下列两项原只能靠环境变量/vaulthub.env，现并入运行时配置，
	// 使「硬件配置」与「转码缓存」都可在 Web 在线编辑，不再依赖 .env。
	PageCacheMaxBytes int64 `json:"page_cache_max_bytes,omitempty"` // 归档页缓存配额（字节），0=沿用 cache_max_bytes/默认 16GiB
	ScanMaxDepth      int   `json:"scan_max_depth,omitempty"`       // 扫描最大深度，0=默认 32
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
	Layer       string `json:"layer"`
	Mode        string `json:"mode"`
	Reason      string `json:"reason"`
	URL         string `json:"url"`
	VideoAction string `json:"video_action"`
	AudioAction string `json:"audio_action"`
	Hardware    string `json:"hardware"`
	// MaxHeight caps the output height when the caller asked for an explicit
	// transcode quality (v0.9.50 播放器设置 → 转码质量). 0 means "no cap".
	MaxHeight int `json:"max_height,omitempty"`
	/* v0.9.88：原盘输入类型（bluray / dvd），普通文件为空。 */
	Disc  string        `json:"disc,omitempty"`
	Media playbackMedia `json:"media"`
	/* v0.9.91：需要提醒用户的播放风险（例如禁用服务端转码后源编码浏览器可能不认识）。 */
	Warn string `json:"warn,omitempty"`
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
	/* v0.9.67：归档页转码缓存独立成目录与配额（默认 4GB），默认放在转码缓存卷下，
	   与 FFmpeg 缓存同卷但不共享配额；上限设 0 即整体关闭转码（请求 w>0 也直出原图）。 */
	a.pageCacheDirPinned = os.Getenv("MEDIA_PAGE_CACHE_DIR") != ""
	a.pageCacheDir = env("MEDIA_PAGE_CACHE_DIR", filepath.Join(a.cacheDir, "page-cache"))
	a.pageCacheMaxBytes = envInt64("MEDIA_PAGE_CACHE_MAX_BYTES", 4*1024*1024*1024)
	/* v0.9.69：批量歌词串行闸门（容量 1）。必须在 load() 内初始化 —— 未初始化时闸门
	   fail-closed，所有批量请求都会 429（测试里直接 new(App) 打端点的行为）。 */
	a.lyricsBatchSem = make(chan struct{}, 1)
	a.cacheMaxAge = time.Duration(envInt64("MEDIA_CACHE_MAX_AGE_HOURS", 168)) * time.Hour
	a.cacheCleanup = time.Duration(envInt64("MEDIA_CACHE_CLEANUP_INTERVAL_HOURS", 24)) * time.Hour
	a.cacheWake = make(chan struct{}, 1)
	a.runtimeConfig = env("MEDIA_RUNTIME_CONFIG", "/data/media-runtime.json")
	a.metadataOverrides = env("MEDIA_METADATA_OVERRIDES", "/data/media-metadata-overrides.json")
	a.scraperMode = env("MEDIA_SCRAPER_MODE", "auto")
	a.scrapeRegion = normalizeScrapeRegion(os.Getenv("SCRAPE_REGION"))
	a.scrapeMinMatch = normalizeScrapeMinMatch(envFloat("SCRAPE_MIN_MATCH", defaultScrapeMinMatch))
	a.scrapeCachePath = env("MEDIA_SCRAPE_CACHE", "/data/media-scrape-cache.json")
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
		/* v0.9.91：兜底间隔不超过 10 分钟。原实现只在启动时 + 每 cache_cleanup_interval_hours
		   （默认/生产配置 24 小时）清一次 —— 期间只要连续看几个 4K 原盘，两次清理之间就能
		   写入几十 GB，把 /data 撑满（生产实测：配额 30.7 GB，实际已到 45 GB，/data 81%），
		   于是 SQLite 索引、转码、接口全部变慢甚至无响应。 */
		if interval > cacheCleanupFallback {
			interval = cacheCleanupFallback
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

const (
	cacheCleanupFallback = 10 * time.Minute /* 转码缓存兜底清理间隔 */
	cacheEntryMaxShare   = 4                /* 单条目最多占配额 1/4，超额条目直接淘汰 */
	cacheFreshGrace      = 5 * time.Minute  /* 刚刚写入的缓存留一个宽限期，避免抖动 */
	cacheActiveWindow    = 30 * time.Minute /* v0.9.92：最近 30 分钟内被播放命中的条目视为「正在使用」，
	/* v0.9.91：兼容流构建的单次上限。cleanCache 回收 .mp4.bg-<pid> 残留分片的
	   「陈旧阈值」必须长于它 —— 否则一次超长转码还在进行，它的分片就被当成残留删掉
	   （审查发现：旧实现是固定 2 小时，短于这里的 6 小时构建上限）。 */
	compatBuildTimeout = 6 * time.Hour
)

/* cacheEntryLimit 返回单条缓存条目的字节上限；配额未设置或过小（上限会算成 0）时返回 0，
   表示不做单条目限制。cleanCache 与 buildCompatCache 共用，避免两处阈值算法漂移
   （审查发现：旧写法 budget/cacheEntryMaxShare 在配额极小时得到 0，会把任何非空产物立即删掉）。 */
func cacheEntryLimit(budget int64) int64 {
	if budget <= 0 {
		return 0
	}
	limit := budget / cacheEntryMaxShare
	if limit <= 0 {
		return 0
	}
	return limit
}

// reportCacheVolume 启动时自检「转码缓存目录是不是独立卷」并打印一行结论。
func (a *App) reportCacheVolume() {
	info := cacheDisk(a.cacheDir, env("SYSTEM_MONITOR_CONTAINER_PATH", "/data"), nil)
	switch {
	case info.Separate:
		fmt.Fprintf(os.Stderr, "[VaultHub] 转码缓存目录 %s 位于独立卷 %s（%s/%s，已用 %d%%）—— 未占用主数据卷 %s\n",
			a.cacheDir, info.Device, humanBytes(info.Used), humanBytes(info.Total), info.Percent, info.DataDevice)
	case info.Device == "":
		fmt.Fprintf(os.Stderr, "[VaultHub] 转码缓存目录 %s 的设备无法识别（overlay/未映射）。建议把独立卷挂到该路径，别写在主 /data 上\n", a.cacheDir)
	default:
		fmt.Fprintf(os.Stderr, "[VaultHub] ⚠️ 转码缓存目录 %s 与主数据卷共用设备 %s（%d%% 已用）—— 缓存会吃掉主卷空间，请把独立卷挂到 %s\n",
			a.cacheDir, info.Device, info.Percent, a.cacheDir)
	}
}

func (a *App) cleanCache() {
	a.mu.RLock()
	cacheDir, cacheMaxBytes, cacheMaxAge := a.cacheDir, a.cacheMaxBytes, a.cacheMaxAge
	a.mu.RUnlock()
	ents, e := os.ReadDir(cacheDir)
	if e != nil {
		/* v0.9.92（发布前审查发现的低危项）：目录不可读时也要落一次用量快照。
		   旧实现在函数入口就 return，cache_bytes / cache_files / cache_cleaned_at
		   永远停在旧值，设置页显示「未清理」，看起来像清理功能失效。 */
		a.mu.Lock()
		a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = 0, 0, time.Now().Unix()
		a.mu.Unlock()
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	items := make([]item, 0, len(ents))
	var total int64
	var kept int
	now := time.Now()
	/* v0.9.91：后台构建中断留下的 <hash>.mp4.bg-<pid> 片段此前永远不被清理
	   （扩展名不是 .mp4），生产实测残留 2 GB 级分片。这里一并回收。
	   陈旧阈值 = 构建上限 + 30 分钟缓冲：正在进行的超长转码（上限 compatBuildTimeout）
	   的分片绝不能被当成残留删除。 */
	staleCutoff := now.Add(-(compatBuildTimeout + 30*time.Minute))
	for _, ent := range ents {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		ext := filepath.Ext(name)
		isParts := strings.Contains(name, ".mp4.") /* .mp4.bg-123 这类未完成分片 */
		if ext != ".mp4" && !isParts {
			continue
		}
		info, e := ent.Info()
		if e != nil {
			continue
		}
		p := filepath.Join(cacheDir, name)
		if isParts {
			if info.ModTime().Before(staleCutoff) {
				_ = os.Remove(p)
			}
			continue
		}
		if cacheMaxAge > 0 && now.Sub(info.ModTime()) > cacheMaxAge {
			_ = os.Remove(p)
			continue
		}
		items = append(items, item{p, info.Size(), info.ModTime()})
		total += info.Size()
	}
	/* v0.9.99：原盘图形字幕抽出的 .sup 放在 burnsub/ 子目录（上面按 .mp4 过滤不会碰到它，
	   也不会被计入配额）。它们是为烧录服务的中间产物，按同样的过期口径回收即可，
	   否则每换一条字幕轨就多留一份整片大小的 PGS。 */
	if subDir := filepath.Join(cacheDir, "burnsub"); true {
		if subEnts, e := os.ReadDir(subDir); e == nil {
			for _, se := range subEnts {
				if se.IsDir() || !strings.HasSuffix(se.Name(), ".sup") {
					continue
				}
				si, e := se.Info()
				if e != nil {
					continue
				}
				sp := filepath.Join(subDir, se.Name())
				if cacheMaxAge > 0 && now.Sub(si.ModTime()) > cacheMaxAge {
					_ = os.Remove(sp)
					continue
				}
				if strings.HasPrefix(se.Name(), ".") || strings.HasSuffix(se.Name(), ".part") {
					continue
				}
				total += si.Size()
			}
		}
	}
	/* v0.9.92：配额与过期都关掉（= 不做自动清理）时仍要写用量快照 ——
	   清理可以不发生，但「当前占用多少」必须一直刷新（同上，审查低危项）。 */
	if cacheMaxBytes <= 0 && cacheMaxAge <= 0 {
		a.mu.Lock()
		a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = total, len(items), now.Unix()
		a.mu.Unlock()
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	/* v0.9.91：单条目上限。一个 9.7 GB 的整片转码缓存会单独击穿配额 —— 旧逻辑只在
	   total > max 时才淘汰，而一个超大条目就足以让 total 长期超标且无处可清。
	   超过配额 1/4 的条目直接淘汰（仍是 LRU 顺序，正在播放的句柄在 Linux 上删除后仍可读）。 */
	entryMax := cacheEntryLimit(cacheMaxBytes)
	for _, it := range items {
		if entryMax <= 0 || it.size <= entryMax {
			continue
		}
		if now.Sub(it.mod) < cacheActiveWindow {
			continue
		}
		if os.Remove(it.path) == nil {
			total -= it.size
		}
	}
	for _, it := range items {
		if cacheMaxBytes <= 0 || total <= cacheMaxBytes {
			break
		}
		if now.Sub(it.mod) < cacheActiveWindow {
			continue
		}
		if os.Remove(it.path) == nil {
			total -= it.size
		}
	}
	for _, it := range items {
		if _, err := os.Stat(it.path); err == nil {
			kept++
		}
	}
	a.mu.Lock()
	a.cacheBytes, a.cacheFiles, a.cacheCleanedAt = total, kept, now.Unix()
	a.mu.Unlock()
}

// openDB opens (creating if needed) the SQLite index database and applies the
// schema. Pragmas are set in the DSN so every pooled connection inherits WAL
// mode and a busy timeout, which lets read queries proceed while a rebuild
// writes in the background.
func (a *App) openDB() {
	_ = os.MkdirAll(a.indexDir, 0755)
	path := filepath.Join(a.indexDir, "index.db")
	// v0.9.79：SQLite 缓存调优。cache_size 是纯内存参数（与磁盘类型无关），
	// 对 1 万+ 行的大库排序/搜索收益明显；mmap_size 用内存映射读取减少系统调用；
	// temp_store=MEMORY 让大排序不落临时文件。cache_size 单位是页（=KiB），16MiB。
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)&_pragma=cache_size(-16384)&_pragma=mmap_size(268435456)&_pragma=temp_store(MEMORY)"
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
-- v0.9.79：为「全库搜索」加前置通配符 LIKE 用的函数索引。搜索走
-- lower(path) LIKE '%kw%'，普通 path 索引用不上；函数索引能让 SQLite 对
-- lower(path) 做范围约束（虽不能直接用前置通配符，但可为到库的候选集预过滤），
-- 且对「按首字母/browse」这类前缀匹配直接可用。开销：写入时多维护一棵索引。
CREATE INDEX IF NOT EXISTS idx_files_lib_lower_path ON files(lib, lower(path));
-- v0.9.90：首页「最近入库」等按 mtime 排序的查询此前走 USING TEMP B-TREE（整库排序）。
-- 复合索引覆盖 (lib, mtime, path)，既满足 WHERE lib=? 又直接给出 ORDER BY mtime DESC, path，
-- 实测查询计划由 TEMP B-TREE 变为走索引扫描。
CREATE INDEX IF NOT EXISTS idx_files_lib_mtime ON files(lib, mtime, path);
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

// readAuth 同样基于 manager 会话（v0.9.56）：文件列表/文件流/归档读取等
// 媒体内容端点也需要登录会话；开放模式下浏览器前端自动登录携带 Cookie，
// 未登录（无 vh_session Cookie）的裸请求一律 401，杜绝未授权读取与下载。
func readAuth(r *http.Request) bool {
	return managerSessionOK(r)
}

func (a *App) runtimeConfigSnapshot(includeSecret bool) map[string]any {
	a.mu.RLock()
	defer a.mu.RUnlock()
	/* v0.9.94（需求8）：缓存卷自检结果（statfs 很便宜，随快照一起现算）。 */
	cacheInfo := cacheDisk(a.cacheDir, env("SYSTEM_MONITOR_CONTAINER_PATH", "/data"), nil)
	out := map[string]any{
		"scraper_mode": a.scraperMode, "tmdb_enabled": a.tmdbAPIKey != "",
		"scrape_region":       a.scrapeRegion,
		"scrape_region_lang":  scrapeRegionLanguage(a.scrapeRegion),
		"scrape_min_match":    a.scrapeMinMatch,
		"scrape_cache":        true,
		"tmdb_api_key_masked": a.tmdbAPIKey != "", "tmdb_api_base": a.tmdbAPIBase,
		"tmdb_image_base": a.tmdbImageBase, "cache_dir": a.cacheDir,
		"tvdb_enabled": a.tvdbAPIKey != "", "tvdb_api_key_masked": a.tvdbAPIKey != "", "tvdb_api_base": a.tvdbAPIBase,
		"scraper_proxy": "", "scraper_proxy_display": maskedProxyURL(a.scraperProxy), "scraper_proxy_configured": a.scraperProxy != "",
		"share_public_base": a.sharePublicBase, "share_public_base_set": a.sharePublicBase != "",
		"cache_max_bytes": a.cacheMaxBytes, "cache_max_age_hours": int64(a.cacheMaxAge / time.Hour),
		/* v0.9.91：实际缓存占用 / 条目数 / 上次清理时间 —— 设置页据此显示真实用量。 */
		"cache_bytes": a.cacheBytes, "cache_files": a.cacheFiles, "cache_cleaned_at": a.cacheCleanedAt,
		/* v0.9.94（需求8）：转码缓存落在哪个设备、是否独立于主数据卷、该卷容量。
		   客户看到的「/data 一直 84%」其实是主数据卷（含 Docker 与索引）的占用，
		   缓存卷另有其人；这里把两者拆开报出来，避免再被误读。 */
		"cache_dir_separate": cacheInfo.Separate, "cache_dir_device": cacheInfo.Device,
		"cache_dir_data_device": cacheInfo.DataDevice,
		"cache_dir_fs_total_bytes": cacheInfo.Total, "cache_dir_fs_used_bytes": cacheInfo.Used,
		"cache_dir_fs_free_bytes": cacheInfo.Free, "cache_dir_fs_percent": cacheInfo.Percent,
		"cache_cleanup_interval_hours": int64(a.cacheCleanup / time.Hour),
		"page_cache_max_bytes":         a.pageCacheMaxBytes, "scan_max_depth": a.scanMaxDepth,
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
	if c.ScrapeRegion != "" {
		a.scrapeRegion = normalizeScrapeRegion(c.ScrapeRegion)
	}
	if c.ScrapeMinMatch > 0 {
		a.scrapeMinMatch = normalizeScrapeMinMatch(c.ScrapeMinMatch)
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
	if c.SharePublicBase != "" {
		a.sharePublicBase = strings.TrimRight(c.SharePublicBase, "/")
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
	if c.PageCacheMaxBytes > 0 {
		a.pageCacheMaxBytes = c.PageCacheMaxBytes
	}
	if c.ScanMaxDepth >= 0 {
		a.scanMaxDepth = c.ScanMaxDepth
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
	if c.SharePublicBase != "" && !validSharePublicBase(c.SharePublicBase) {
		return fmt.Errorf("invalid share public base")
	}
	/* v0.9.75：空值默认「保留原值」，但显式 share_public_base_set=true 时允许清空
	   （表单总是带上该标记，用户清空输入框即可关掉外网分享地址）。 */
	if c.SharePublicBase == "" && !c.SharePublicBaseSet {
		a.mu.RLock()
		c.SharePublicBase = a.sharePublicBase
		a.mu.RUnlock()
	}
	if !filepath.IsAbs(c.CacheDir) || c.CacheMaxBytes < 0 || c.CacheMaxAgeHours < 0 || c.CacheCleanupIntervalHours <= 0 {
		return fmt.Errorf("invalid cache settings")
	}
	if c.PageCacheMaxBytes < 0 || c.ScanMaxDepth < 0 {
		return fmt.Errorf("invalid page cache / scan depth")
	}
	if err := os.MkdirAll(c.CacheDir, 0755); err != nil {
		return fmt.Errorf("cache directory: %w", err)
	}
	/* v0.9.87：刮削地区白名单。空值沿用原值（表单总带值），非法值直接报错，
	   不做静默回落 —— 否则用户以为切了地区而实际没生效。 */
	if strings.TrimSpace(c.ScrapeRegion) == "" {
		a.mu.RLock()
		c.ScrapeRegion = a.scrapeRegion
		a.mu.RUnlock()
		if strings.TrimSpace(c.ScrapeRegion) == "" {
			c.ScrapeRegion = "auto"
		}
	}
	if !validScrapeRegion(c.ScrapeRegion) {
		return fmt.Errorf("invalid scrape region")
	}
	c.ScrapeRegion = normalizeScrapeRegion(c.ScrapeRegion)
	/* v0.9.88：标题匹配阈值。0 = 表单未带值（沿用当前），越界直接报错，
	   不做静默夹紧 —— 阈值被悄悄改成别的值只会让用户以为「没生效」。 */
	if c.ScrapeMinMatch == 0 {
		a.mu.RLock()
		c.ScrapeMinMatch = a.scrapeMinMatch
		a.mu.RUnlock()
		if c.ScrapeMinMatch == 0 {
			c.ScrapeMinMatch = defaultScrapeMinMatch
		}
	}
	if !validScrapeMinMatch(c.ScrapeMinMatch) {
		return fmt.Errorf("invalid scrape match threshold")
	}
	c.ScrapeMinMatch = normalizeScrapeMinMatch(c.ScrapeMinMatch)
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
	a.sharePublicBase = strings.TrimRight(c.SharePublicBase, "/")
	a.scraperMode, a.tmdbAPIKey = c.ScraperMode, c.TMDBAPIKey
	a.tmdbAPIBase, a.tmdbImageBase = strings.TrimRight(c.TMDBAPIBase, "/"), strings.TrimRight(c.TMDBImageBase, "/")
	a.tvdbAPIKey, a.tvdbAPIBase, a.scraperProxy = c.TVDBAPIKey, strings.TrimRight(c.TVDBAPIBase, "/"), c.ScraperProxy
	/* v0.9.87：刮削地区立即生效（前端下次 TMDB 请求即用新语言，无需重启）。 */
	a.scrapeRegion = normalizeScrapeRegion(c.ScrapeRegion)
	/* v0.9.88：标题匹配阈值同样立即生效（下一条刮削即按新阈值判定）。 */
	a.scrapeMinMatch = normalizeScrapeMinMatch(c.ScrapeMinMatch)
	oldCacheDir := a.cacheDir
	a.cacheDir, a.cacheMaxBytes = c.CacheDir, c.CacheMaxBytes
	a.cacheMaxAge, a.cacheCleanup = time.Duration(c.CacheMaxAgeHours)*time.Hour, time.Duration(c.CacheCleanupIntervalHours)*time.Hour
	a.pageCacheMaxBytes = c.PageCacheMaxBytes
	a.scanMaxDepth = c.ScanMaxDepth
	a.mu.Unlock()
	select {
	case a.cacheWake <- struct{}{}:
	default:
	}
	/* v0.9.92（需求：缓存目录映射可测/可换）：换了缓存目录，分页缓存与音频转码缓存
	   必须一起走。音频转码缓存本来就按 a.cacheDir 现算（audio_stream.go），
	   但分页缓存目录只在启动时派生一次 —— 旧行为是「设置里改了目录，磁盘上看不到变化」。
	   MEDIA_PAGE_CACHE_DIR 显式配置时以它为准，不覆盖。 */
	if !a.pageCacheDirPinned && oldCacheDir != c.CacheDir {
		a.pageCacheMu.Lock()
		a.pageCacheDir = filepath.Join(c.CacheDir, "page-cache")
		a.pageCache = nil // 下一次取用时按新目录重建（旧目录里的分页缓存不迁移）
		a.pageCacheMu.Unlock()
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

// validSharePublicBase 校验分享外网基址：必须 http(s)://host[:port]，不允许带路径/查询。
func validSharePublicBase(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" {
		return false
	}
	return u.Path == "" || u.Path == "/"
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
	// v0.9.52：多存储路径。多路径库的索引 path 形如 <root-base>/<rest>
	// （见 walkMultiLibraryFiles），请求端原样带回；单路径库（存量）path
	// 无前缀。对每个 root：
	//   1) 多路径库：若 clean 以该 root 目录名开头 → 剥离前缀后解析；
	//   2) 否则（单路径库 / 不带前缀的旧请求）→ 原样 join。
	// 每个 root 都是独立边界：EvalSymlinks 后必须留在该 root 或 MEDIA_ROOT
	// 内，与 v0.9.30 单根规则一致 —— 库内链接指向系统路径仍然不可服务。
	roots := lib.AllPaths()
	if len(roots) == 0 {
		return "", nil, fmt.Errorf("library has no path")
	}
	for _, root := range roots {
		rootReal, er := filepath.EvalSymlinks(root)
		if er != nil {
			continue
		}
		try := clean
		if len(roots) > 1 {
			if rest, ok := strings.CutPrefix(clean, filepath.Base(rootReal)+"/"); ok {
				try = rest
			} else if clean == filepath.Base(rootReal) {
				continue // 只请求到根目录本身，不可服务
			}
		}
		full := filepath.Join(rootReal, try)
		resolved, er := filepath.EvalSymlinks(full)
		if er != nil || !allowedRealPath(rootReal, resolved) {
			continue
		}
		st, er := os.Stat(resolved)
		if er != nil || st.IsDir() {
			continue
		}
		return full, st, nil
	}
	return "", nil, fmt.Errorf("file not found in any library path")
}
func (l *Library) AllPaths() []string {
	seen := map[string]bool{}
	var out []string
	if l.Path != "" && !seen[l.Path] {
		out = append(out, l.Path)
		seen[l.Path] = true
	}
	for _, p := range l.Paths {
		p = strings.TrimSpace(p)
		if p != "" && !seen[p] {
			out = append(out, p)
			seen[p] = true
		}
	}
	return out
}

// equalStringSlice reports whether two string slices are element-wise equal.
// v0.9.52：用于判断媒体库扩展路径集合是否发生变化。
func equalStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (a *App) libraries(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		/* v1.0.7 契约收紧：库列表含磁盘路径，不再匿名可读（此前是 ROUTE_INVENTORY §4.1 指出的枚举面）。 */
		if !readAuth(r) {
			errJSON(w, 401, "login required")
			return
		}
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
		// v0.9.52：多存储路径 —— 逐条校验扩展路径并归一化（绝对、存在、目录），
		// 与主路径重复的条目剔除，防止 (lib,path) 主键意外冲突。
		extras := make([]string, 0, len(l.Paths))
		for _, raw := range l.Paths {
			x := strings.TrimSpace(raw)
			if x == "" {
				continue
			}
			xa, err := filepath.Abs(x)
			if err != nil || !strings.HasPrefix(xa, string(filepath.Separator)) {
				errJSON(w, 400, "extra path must be an existing absolute directory")
				return
			}
			sx, err := os.Stat(xa)
			if err != nil || !sx.IsDir() {
				errJSON(w, 400, "extra path must be an existing absolute directory")
				return
			}
			xr, _ := filepath.EvalSymlinks(xa)
			if xr == l.Path {
				continue
			}
			dupe := false
			for _, have := range extras {
				if have == xr {
					dupe = true
					break
				}
			}
			if !dupe {
				extras = append(extras, xr)
			}
		}
		l.Paths = extras
		a.mu.Lock()
		if a.deleting[l.ID] {
			a.mu.Unlock()
			errJSON(w, 409, "library id is being deleted")
			return
		}
		for _, x := range a.libs {
			if x.ID == l.ID {
				if x.Name != l.Name || x.Type != l.Type || x.Path != l.Path {
					a.mu.Unlock()
					errJSON(w, 409, "id already exists with different library data")
					return
				}
				// v0.9.52：同一媒体库再次提交（追加存储路径 / 幂等重扫）——
				// 若扩展路径集合有变化则先持久化新配置再触发扫描。
				if !equalStringSlice(x.Paths, l.Paths) {
					next := make([]Library, 0, len(a.libs))
					for _, y := range a.libs {
						if y.ID == l.ID {
							y.Paths = l.Paths
						}
						next = append(next, y)
					}
					if e := a.saveLibrariesLocked(next); e != nil {
						a.mu.Unlock()
						errJSON(w, 500, "configuration write failed")
						return
					}
					a.libs = next
				}
				a.mu.Unlock()
				a.start(l)
				writeJSON(w, 200, map[string]any{"ok": true, "existing": true, "status": "indexing"})
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
		// v0.9.52：多存储路径支持 —— 遍历 l.AllPaths() 全部路径，
		// 相对路径前添加路径前缀（paths/<root-name>/...）以避免不同路径下同名文件冲突。
		scanPaths := l.AllPaths()
		walkErr := walkMultiLibraryFiles(ctx, scanPaths, a.effectiveScanMaxDepth(), func(f scannedFile) {
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
	/* v1.0.7 契约收紧：索引状态暴露库名与文件规模，不再匿名可读。 */
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
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
// v0.9.56: 文件列表读取需要登录会话（readAuth）。
/* v0.9.90：单次列表请求的最大条数（整库索引分块拉取用）。 */
const maxFilesLimit = 5000

func (a *App) files(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
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
	/* v0.9.90：单页上限 500 → maxFilesLimit。
	   前端整库索引用 2000/块拉取，18.4 万条的库从 370 次请求降到 93 次；
	   响应仍是逐行扫描 + 流式写 JSON，内存占用与单页上限无关。 */
	if lim <= 0 || lim > maxFilesLimit {
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
		/* v0.9.82：与默认分支同样下发索引版本 + ETag（带 q 时按命中集计算）。 */
		version := ""
		if !busy {
			var maxMtime int64
			if e := a.db.QueryRow(`SELECT coalesce(max(mtime),0) FROM files WHERE lib=? AND lower(path) LIKE ? ESCAPE '\'`, id, like).Scan(&maxMtime); e != nil {
				maxMtime = 0
			}
			version = libraryIndexVersion(id, order, q, total, maxMtime)
		}
		writeIndexJSON(w, r, version, off, lim, map[string]any{"status": status, "total": total, "offset": off, "limit": lim, "query": q, "has_more": off+len(files) < total, "files": files, "version": version})
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
	/* v0.9.82：索引版本 —— 行数 + 最大 mtime 足以刻画「这库的索引变没变」。
	   扫描进行中（busy）时不下发版本/ETag，强制客户端拿最新结果。 */
	version := ""
	if !busy {
		var maxMtime int64
		if e := a.db.QueryRow(`SELECT coalesce(max(mtime),0) FROM files WHERE lib=?`, id).Scan(&maxMtime); e != nil {
			maxMtime = 0
		}
		version = libraryIndexVersion(id, order, "", total, maxMtime)
	}
	writeIndexJSON(w, r, version, off, lim, map[string]any{"status": status, "total": total, "offset": off, "limit": lim, "has_more": off+len(files) < total, "files": files, "version": version})
}

func (a *App) serve(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
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
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
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
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
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
	/* v0.9.56：归档目录解析结果按 (路径,size,mtime) 缓存（LRU），
	   漫画逐页请求不再反复 OpenReader + 全量 iconv 解码文件名。 */
	a.zipCacheMu.Lock()
	if a.zipCache == nil {
		a.zipCache = newZipArchiveCache(64)
	}
	zc := a.zipCache
	a.zipCacheMu.Unlock()
	ze, e := zc.acquire(p)
	if e != nil {
		errJSON(w, 400, "not a ZIP/CBZ archive")
		return
	}
	defer zc.release(ze)
	files, display := ze.files, ze.display

	if want := r.URL.Query().Get("entry"); want != "" {
		i := ze.indexOf(want)
		// Accept the raw ZIP name and the decoded display name so links
		// generated by older frontends keep working.
		if i < 0 {
			errJSON(w, 404, "archive entry not found")
			return
		}
		x := files[i]
		rc, e := x.Open()
		if e != nil {
			errJSON(w, 404, "archive entry not found")
			return
		}
		defer rc.Close()
		/* v0.9.50：ZIP/CBZ 内图片可能没有可靠扩展名（部分压包工具把小图存成
		   无扩展/大写扩展），且 nosniff 下 octet-stream 会被浏览器直接拒绝渲染。
		   先读前 512 字节做真实内容嗅探：能认出图片类型就用嗅探结果，认不出
		   再回落扩展名映射；两者都给不出图片类型时保持 nosniff + octet-stream。 */
		head := make([]byte, 512)
		n, _ := io.ReadFull(rc, head)
		head = head[:n]
		contentType := http.DetectContentType(head)
		if !strings.HasPrefix(contentType, "image/") {
			if mt := mime(display[i]); strings.HasPrefix(mt, "image/") {
				contentType = mt
			}
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		if n > 0 {
			w.Write(head)
		}
		io.Copy(w, rc)
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
	m := map[string]string{
		".mkv": "video/x-matroska", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
		".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav",
		".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
		".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff",
		".srt": "application/x-subrip", ".vtt": "text/vtt",
	}
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
	/* v1.0.3（审查 S-3）：主机负载/内存/磁盘/网卡信息属于部署内部信息，
	   之前无需登录就能读（公网经反代暴露时会泄露宿主机状况）。 */
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
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
	// volRoot/<name> (e.g. /host/srv). Absolute paths are used verbatim.
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
		/* v0.9.86：容器所在硬盘（容量 + 能对上传感器时的温度）。
		   前端在「没有映射空间」时用它替代温度/容量显示。 */
		"container_disk": containerDisk(env("SYSTEM_MONITOR_CONTAINER_PATH", "/data"), diskTemps),
		/* v0.9.94（需求8）：转码缓存卷（独立映射的那块盘）。容量/占用与主数据卷分开报，
		   设置页据此显示「缓存不在主 /data 上」。 */
		"cache_disk": cacheDisk(env("MEDIA_CACHE_DIR", "/data/transcode-cache"), env("SYSTEM_MONITOR_CONTAINER_PATH", "/data"), diskTemps),
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
	/* v0.9.88：原盘镜像（ISO）与 BDMV 片段先解析成可读输入 —— 蓝光镜像经
	   libbluray(udfread) 直读 UDF，DVD 镜像走 dvdvideo，拿不到才退回裸文件。 */
	disc := a.resolveDiscInputWithPlaylist(ctx, p, discPlaylistArg(r))
	probeArgs := []string{"-v", "quiet", "-print_format", "json", "-show_streams", "-show_format"}
	probeArgs = append(probeArgs, disc.InputArgs()...)
	probeArgs = append(probeArgs, disc.Spec)
	b, e := exec.CommandContext(ctx, "ffprobe", probeArgs...).Output()
	if e != nil {
		out := map[string]any{"audio_codec": "", "video_codec": "", "container_likely_supported": false, "audio_likely_supported": true, "compat_recommended": true}
		out["disc_input"] = string(disc.Kind)
		if hint := discProbeHint(p); hint != "" {
			out["probe_hint"] = hint
		}
		writeJSON(w, 200, out)
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
	writeJSON(w, 200, map[string]any{"audio_codec": ac, "video_codec": vc, "width": width, "height": height, "format_name": x.Format.FormatName, "container": strings.TrimPrefix(ext, "."), "bit_rate": x.Format.BitRate, "duration": x.Format.Duration, "video_metadata": true, "container_likely_supported": container, "audio_likely_supported": audio, "compat_recommended": !container || !audio, "disc_input": string(disc.Kind), "disc": disc.Kind != discInputPlain})
}
func streams(w http.ResponseWriter, r *http.Request, a *App) {
	if !readAuth(r) {
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
	/* v0.9.88：原盘的音轨/字幕轨要按解析后的输入读取（ISO 直接读镜像）。 */
	disc := a.resolveDiscInputWithPlaylist(r.Context(), p, discPlaylistArg(r))
	streamArgs := []string{"-v", "error", "-show_entries", "stream=index,codec_type,codec_name,id:stream_tags=language,title", "-of", "json"}
	streamArgs = append(streamArgs, disc.InputArgs()...)
	streamArgs = append(streamArgs, disc.Spec)
	b, e := exec.CommandContext(r.Context(), "ffprobe", streamArgs...).Output()
	if e != nil {
		writeJSON(w, 200, map[string]any{"audio_tracks": []any{}, "subtitle_tracks": []any{}})
		return
	}
	var x struct {
		Streams []struct {
			Index     int               `json:"index"`
			CodecType string            `json:"codec_type"`
			CodecName string            `json:"codec_name"`
			// v1.0.0：原盘用 id（= PID）与 M2TS 的 PMT 语言描述符精确对齐。
			ID   string            `json:"id"`
			Tags map[string]string `json:"tags"`
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
			/* v0.9.99：旧实现把图形字幕（PGS / DVD 子图）整条 continue 掉了，
			   于是全部是原盘/图形字幕的库在播放器里「一个字幕都选不了」。
			   现在全部列出：文本轨给 WebVTT 提取地址，图形轨给出烧录地址
			   （compat + sub_track，服务端把字幕位图叠进画面）。 */
			label := subtitleLabelFor(r.Context(), disc, s.CodecName, s.Tags["title"], s.Tags["language"], s.ID, si)
			if label == "" {
				label = fmt.Sprintf("内嵌字幕 %d", si+1)
			}
			kind := subtitleTrackKind(s.CodecName)
			item := map[string]any{
				"index": si, "label": label, "codec": s.CodecName, "language": s.Tags["language"],
				"pid": s.ID, "kind": kind, "text": kind == "text", "burn_in": kind == "bitmap",
				"stream_index": s.Index,
			}
			if kind == "text" {
				item["url"] = "/api/media/subtitles/extract?id=" + url.QueryEscape(l.ID) + "&path=" + url.QueryEscape(r.URL.Query().Get("path")) + "&track=" + strconv.Itoa(si)
			} else {
				item["burn_track"] = si
			}
			subs = append(subs, item)
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
		/* v0.9.91：解/转码风向标用。cores = 容器可见 CPU 核数；software_only = 只能软编；
		   weak_cpu 只是提示（无硬件编码器且核数 ≤4），是否禁用服务端转码由用户决定。 */
		"cores":         runtime.NumCPU(),
		"software_only": selected == "cpu",
		"weak_cpu":      selected == "cpu" && runtime.NumCPU() <= 4,
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
// subtitleTrackKind 区分「能转成 WebVTT 的文本字幕」与「只能烧录进画面的图形字幕」。
// 图形字幕（PGS / DVD subpicture / DVB subpicture / XSUB）没有文本层，浏览器
// 无法渲染，OCR 不在本项目范围内 —— 唯一可行路径是服务端 overlay 烧录。
func subtitleTrackKind(codec string) string {
	switch strings.ToLower(strings.TrimSpace(codec)) {
	case "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "dvb_teletext":
		return "bitmap"
	}
	return "text"
}

/* —— v1.0.0（需求3）：内嵌字幕「语言 / 内容」识别 ——
   旧实现只会给出「内嵌字幕 1/2/3」再拼一个 ISO 码（chi、eng…），用户看不出哪条是
   简体、哪条是繁体、哪条是中英双语，只能一条条试。现在按层次推导标签：
     ① 轨道自带的 title 标签（「简体中文」「繁體中文」「English」… remux 常见）；
     ② 文本轨采样真实内容 → 简繁与中英混排判定（图形字幕没有文本层，跳过）；
     ③ 轨道自带的 language 标签 → 中文语言名；
     ④ 原盘 PGS 常常一个标签都没有 → 回落读原盘自己的 M2TS PMT 语言描述符；
     ⑤ 都拿不到才回到「内嵌字幕 N」。
   结果按「输入 + 轨号」缓存，播放器每次打开不会重复抽样本。 */

var subLangNames = map[string]string{
	"zho": "中文", "chi": "中文", "zh": "中文", "cmn": "中文", "chs": "简体中文", "cht": "繁体中文",
	"eng": "英语", "en": "英语", "jpn": "日语", "ja": "日语", "jp": "日语",
	"kor": "韩语", "ko": "韩语", "fra": "法语", "fre": "法语", "deu": "德语", "ger": "德语",
	"spa": "西班牙语", "rus": "俄语", "ita": "意大利语", "por": "葡萄牙语", "tha": "泰语",
	"vie": "越南语", "ara": "阿拉伯语", "hin": "印地语", "ind": "印尼语", "msa": "马来语",
	"nld": "荷兰语", "pol": "波兰语", "swe": "瑞典语", "tur": "土耳其语", "ukr": "乌克兰语", "heb": "希伯来语",
	// 原盘常见的小语种（实测《黑鹰坠落》原盘就带 bul / hrv / slv / hun 等 22 条字幕轨）。
	"bul": "保加利亚语", "hrv": "克罗地亚语", "slv": "斯洛文尼亚语", "hun": "匈牙利语",
	"ces": "捷克语", "cze": "捷克语", "dan": "丹麦语", "fin": "芬兰语", "ell": "希腊语", "gre": "希腊语",
	"nor": "挪威语", "nob": "挪威语", "ron": "罗马尼亚语", "rum": "罗马尼亚语", "srp": "塞尔维亚语",
	"slk": "斯洛伐克语", "slo": "斯洛伐克语", "est": "爱沙尼亚语", "lav": "拉脱维亚语", "lit": "立陶宛语",
	"isl": "冰岛语", "ice": "冰岛语", "cat": "加泰罗尼亚语", "fas": "波斯语", "per": "波斯语",
	"urd": "乌尔都语", "ben": "孟加拉语", "tam": "泰米尔语", "tel": "泰卢固语", "mar": "马拉地语",
	"guj": "古吉拉特语", "kan": "卡纳达语", "mal": "马拉雅拉姆语", "pan": "旁遮普语", "sin": "僧伽罗语",
	"nep": "尼泊尔语", "mya": "缅甸语", "bur": "缅甸语", "khm": "高棉语", "lao": "老挝语",
	"fil": "菲律宾语", "tgl": "菲律宾语", "swa": "斯瓦希里语", "afr": "南非荷兰语", "sqi": "阿尔巴尼亚语",
	"alb": "阿尔巴尼亚语", "hye": "亚美尼亚语", "arm": "亚美尼亚语", "aze": "阿塞拜疆语", "bel": "白俄罗斯语",
	"bos": "波斯尼亚语", "eus": "巴斯克语", "baq": "巴斯克语", "glg": "加利西亚语", "kat": "格鲁吉亚语",
	"geo": "格鲁吉亚语", "kaz": "哈萨克语", "mkd": "马其顿语", "mac": "马其顿语", "mlt": "马耳他语",
	"mon": "蒙古语", "yue": "粤语", "lat": "拉丁语", "ces2": "",
}

// subLangName 把 ffprobe / PMT 里的语言码翻成中文名；不认识时返回 ""。
func subLangName(code string) string {
	c := strings.ToLower(strings.TrimSpace(code))
	if c == "" || c == "und" || c == "unknown" {
		return ""
	}
	if n, ok := subLangNames[c]; ok {
		return n
	}
	if len(c) > 3 {
		if n, ok := subLangNames[c[:3]]; ok {
			return n
		}
	}
	return ""
}

/* 简繁判别用的「只在单边出现」的常见字幕字。两侧都列的是同一字的两种写法，
   所以某个样本里只有一侧的字反复出现时，就能判断这条字幕是简还是繁。 */
const (
	subHansChars = "们这说时对来国学开关见听么无发华电车马鸟鱼龙义体儿头买卖单动务医会众优传伤价伟伞余仅从仓仪侧凭划则刚创删剑剧劝办势区协卫却压历县双变号岁币师当录彻态怀总恶惊惧惨戏战户执扩扫扬护报担拟择挂挤挥损换据揽权欢气爱铁银钱长间问闻闲阵队随难顺须领风飞饭饮验齐齿个与为请谢样让觉过还进远边转"
	subHantChars = "們這說時對來國學開關見聽麼無發華電車馬鳥魚龍義體兒頭買賣單動務醫會眾優傳傷價偉傘餘僅從倉儀側憑劃則剛創刪劍劇勸辦勢區協衛卻壓歷縣雙變號歲幣師當錄徹態懷總惡驚懼慘戲戰戶執擴掃揚護報擔擬擇掛擠揮損換據攬權歡氣愛鐵銀錢長間問聞閒陣隊隨難順須領風飛飯飲驗齊齒個與為請謝樣讓覺過還進遠邊轉"
)

var (
	subHansSet = map[rune]bool{}
	subHantSet = map[rune]bool{}
)

func init() {
	for _, r := range subHansChars {
		subHansSet[r] = true
	}
	for _, r := range subHantChars {
		subHantSet[r] = true
	}
}

// subtitleSampleLabel 按字幕文本判定语言类别；样本太短或没有可用信号时返回 ""。
func subtitleSampleLabel(sample string) string {
	var cjk, hans, hant, latin, kana, hangul int
	for _, r := range sample {
		switch {
		case r >= 0x3040 && r <= 0x30ff:
			kana++
		case r >= 0xac00 && r <= 0xd7a3:
			hangul++
		case r >= 0x4e00 && r <= 0x9fff:
			cjk++
			if subHantSet[r] {
				hant++
			}
			if subHansSet[r] {
				hans++
			}
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			latin++
		}
	}
	total := cjk + latin
	if total < 8 && kana == 0 && hangul == 0 {
		return ""
	}
	switch {
	case kana > 0 && kana*4 >= cjk:
		return "日语"
	case hangul > 0 && hangul*4 >= cjk:
		return "韩语"
	case cjk == 0:
		return "英语"
	case latin*100 >= total*25:
		return "中英双语"
	case hant > hans*2 && hant >= 2:
		return "繁体中文"
	case hans > hant*2 && hans >= 2:
		return "简体中文"
	}
	return "中文"
}

// subtitleTitleHint 从轨标题里识别语言（含简繁 / 双语提示）；识别不到返回 ""。
// ASCII 部分按「分词后整词匹配」，避免 "en" 命中 "extended" 这类误判。
func subtitleTitleHint(title string) string {
	t := strings.ToLower(strings.TrimSpace(title))
	if t == "" {
		return ""
	}
	has := func(keys ...string) bool {
		for _, k := range keys {
			if strings.Contains(t, k) {
				return true
			}
		}
		return false
	}
	tok := map[string]bool{}
	for _, part := range regexp.MustCompile(`[^a-z0-9]+`).Split(t, -1) {
		if part != "" {
			tok[part] = true
		}
	}
	hasTok := func(keys ...string) bool {
		for _, k := range keys {
			if tok[k] {
				return true
			}
		}
		return false
	}
	zh := has("中文", "简体", "繁体") || hasTok("chi", "zho", "chs", "cht", "zh", "cn", "chinese", "mandarin")
	en := has("英文", "英语") || hasTok("eng", "en", "english")
	if has("中英", "双语") || hasTok("bilingual") || (zh && en) {
		return "中英双语"
	}
	switch {
	case has("简") || hasTok("chs", "simplified", "sc"):
		return "简体中文"
	case has("繁") || hasTok("cht", "traditional", "tc"):
		return "繁体中文"
	case zh:
		return "中文"
	case en:
		return "英语"
	case has("日文", "日语") || hasTok("jpn", "jp", "japanese"):
		return "日语"
	case has("韩文", "韩语") || hasTok("kor", "kr", "korean"):
		return "韩语"
	}
	return ""
}

/* subtitleSampleBuf：给 ffmpeg 的输出装一个上限，样本够用就停止增长 —
   整条字幕轨可能有几十 MB，全部读进来既慢又没必要。 */
type subtitleSampleBuf struct {
	buf []byte
	max int
}

func (b *subtitleSampleBuf) Write(p []byte) (int, error) {
	if n := b.max - len(b.buf); n > 0 {
		if n > len(p) {
			n = len(p)
		}
		b.buf = append(b.buf, p[:n]...)
	}
	return len(p), nil
}

func (b *subtitleSampleBuf) String() string { return string(b.buf) }

// sampleEmbeddedSubtitle 把一条文本字幕轨的前若干行抽成 SRT 当作样本。
// 图形字幕（PGS / DVD 子图）没有文本层，调用方需先按 kind 过滤。
func sampleEmbeddedSubtitle(ctx context.Context, disc discInput, track int) string {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	args = append(args, disc.InputArgs()...)
	args = append(args, "-i", disc.Spec, "-map", fmt.Sprintf("0:s:%d", track), "-f", "srt", "pipe:1")
	buf := &subtitleSampleBuf{max: 64 << 10}
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stdout = buf
	// 样本够了就会被超时/管道关闭打断，有输出即算成功。
	_ = cmd.Run()
	return buf.String()
}

var (
	subLabelMu    sync.Mutex
	subLabelCache = map[string]string{}
	subLabelTimes = map[string]time.Time{}
)

// subtitleSampleCached 内容采样结果按「输入 + 轨号 + 尺寸 + mtime」缓存。
func subtitleSampleCached(ctx context.Context, disc discInput, track int) string {
	key := fmt.Sprintf("sample|%s|%d", disc.Spec, track)
	if st, err := os.Stat(disc.File); err == nil {
		key = fmt.Sprintf("sample|%s|%d|%d|%d", disc.Spec, track, st.Size(), st.ModTime().Unix())
	}
	subLabelMu.Lock()
	if v, ok := subLabelCache[key]; ok {
		subLabelMu.Unlock()
		return v
	}
	subLabelMu.Unlock()
	label := subtitleSampleLabel(sampleEmbeddedSubtitle(ctx, disc, track))
	subLabelMu.Lock()
	subLabelCache[key] = label
	subLabelTimes[key] = time.Now()
	// 缓存上限：字幕轨数不多，超过 512 条就整体清一次，避免长跑进程无界增长。
	if len(subLabelCache) > 512 {
		subLabelCache = map[string]string{}
		subLabelTimes = map[string]time.Time{}
	}
	subLabelMu.Unlock()
	return label
}

/* discSubtitleLangInfo 原盘 PGS/DVD 子图轨常一个标签都没有，但原盘自己的 M2TS 里带着
   PMT 语言描述符。ffprobe 对 bluray: 输入的每条字幕流都带 id（= PID，如 0x1201），与 M2TS
   内的 PID 一一对应 —— 所以按 PID 精确回填，不按位置猜。
   实测《黑鹰坠落》原盘：bluray: 输入报 0x1200 / 0x1201 两条 PGS 无标签；
   同一 M2TS 里 0x1200=eng、0x1201=zho。 */
type discSubLangInfo struct {
	byPID map[string]string
	// 当整个 M2TS 的字幕语言只有一种时给出该语言（PID 对不上时的兜底）。
	only string
}

var (
	discLangMu    sync.Mutex
	discLangCache = map[string]discSubLangInfo{}
)

func discSubtitleLangInfo(ctx context.Context, disc discInput) discSubLangInfo {
	empty := discSubLangInfo{byPID: map[string]string{}}
	if disc.Kind != discInputBluRay || disc.DiscRoot == "" {
		return empty
	}
	key := disc.DiscRoot
	discLangMu.Lock()
	if v, ok := discLangCache[key]; ok {
		discLangMu.Unlock()
		return v
	}
	discLangMu.Unlock()
	info := discSubLangInfo{byPID: map[string]string{}}
	streamDir := filepath.Join(disc.DiscRoot, "BDMV", "STREAM")
	if ents, err := os.ReadDir(streamDir); err == nil {
		biggest, size := "", int64(-1)
		for _, x := range ents {
			if x.IsDir() || !strings.EqualFold(filepath.Ext(x.Name()), ".m2ts") {
				continue
			}
			if st, e := x.Info(); e == nil && st.Size() > size {
				biggest, size = filepath.Join(streamDir, x.Name()), st.Size()
			}
		}
		if biggest != "" {
			ctx2, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			if b, e := exec.CommandContext(ctx2, "ffprobe", "-v", "error", "-select_streams", "s",
				"-show_entries", "stream=id:stream_tags=language", "-of", "json", biggest).Output(); e == nil {
				var x struct {
					Streams []struct {
						ID   string            `json:"id"`
						Tags map[string]string `json:"tags"`
					} `json:"streams"`
				}
				if json.Unmarshal(b, &x) == nil {
					seen := map[string]bool{}
					for _, s := range x.Streams {
						lang := subLangName(s.Tags["language"])
						if lang == "" {
							continue
						}
						if pid := normalizeStreamPID(s.ID); pid != "" {
							info.byPID[pid] = lang
						}
						seen[lang] = true
					}
					if len(seen) == 1 {
						for l := range seen {
							info.only = l
						}
					}
				}
			}
		}
	}
	discLangMu.Lock()
	// 缓存上限：原盘数量有限，超过 64 条整体清一次。
	if len(discLangCache) > 64 {
		discLangCache = map[string]discSubLangInfo{}
	}
	discLangCache[key] = info
	discLangMu.Unlock()
	return info
}

// normalizeStreamPID 统一 PID 写法（ffprobe 给 "0x1201"，大小写与 0x 前缀都可能变化）。
func normalizeStreamPID(id string) string {
	s := strings.ToLower(strings.TrimSpace(id))
	if s == "" {
		return ""
	}
	s = strings.TrimPrefix(s, "0x")
	return s
}

// subtitleLabelFor 推导一条内嵌字幕轨的展示标签；毫无线索时返回 ""（调用方回落「内嵌字幕 N」）。
// pid 是 ffprobe 报的流 id（PID），仅原盘用于精确回填语言。
func subtitleLabelFor(ctx context.Context, disc discInput, codec, title, lang, pid string, track int) string {
	kind := subtitleTrackKind(codec)
	if hint := subtitleTitleHint(title); hint != "" {
		return hint
	}
	if kind == "text" {
		if l := subtitleSampleCached(ctx, disc, track); l != "" {
			return l
		}
	}
	if n := subLangName(lang); n != "" {
		return n
	}
	if kind == "bitmap" {
		info := discSubtitleLangInfo(ctx, disc)
		if n := info.byPID[normalizeStreamPID(pid)]; n != "" {
			return n
		}
		if info.only != "" {
			return info.only
		}
	}
	return strings.TrimSpace(title)
}

// embeddedSubtitleTracks 读取当前输入（含原盘解析）的内嵌字幕轨清单，
// 供播放器字幕面板与「搜索并挂载」共用，避免两处口径漂移。
func embeddedSubtitleTracks(ctx context.Context, disc discInput, libID, relPath string) []map[string]any {
	args := []string{"-v", "error", "-select_streams", "s", "-show_entries", "stream=index,codec_name,id:stream_tags=language,title", "-of", "json"}
	args = append(args, disc.InputArgs()...)
	args = append(args, disc.Spec)
	b, e := exec.CommandContext(ctx, "ffprobe", args...).Output()
	if e != nil {
		return nil
	}
	var x struct {
		Streams []struct {
			Index     int               `json:"index"`
			CodecName string            `json:"codec_name"`
			ID        string            `json:"id"`
			Tags      map[string]string `json:"tags"`
		} `json:"streams"`
	}
	if json.Unmarshal(b, &x) != nil {
		return nil
	}
	out := make([]map[string]any, 0, len(x.Streams))
	for si, s := range x.Streams {
		label := subtitleLabelFor(ctx, disc, s.CodecName, s.Tags["title"], s.Tags["language"], s.ID, si)
		if label == "" {
			label = fmt.Sprintf("内嵌字幕 %d", si+1)
		}
		kind := subtitleTrackKind(s.CodecName)
		item := map[string]any{
			"index": si, "label": label, "codec": s.CodecName, "language": s.Tags["language"],
			"pid": s.ID, "kind": kind, "text": kind == "text", "burn_in": kind == "bitmap", "stream_index": s.Index,
		}
		if kind == "text" {
			item["url"] = "/api/media/subtitles/extract?id=" + url.QueryEscape(libID) + "&path=" + url.QueryEscape(relPath) + "&track=" + strconv.Itoa(si)
		} else {
			item["burn_track"] = si
		}
		out = append(out, item)
	}
	return out
}

func (a *App) extractSubtitle(w http.ResponseWriter, r *http.Request) {
	/* v1.0.3（审查 S-2）：本端点会跑 ffmpeg 抽字幕并返回文本内容，属于「媒体内容 +
	   高开销」操作，之前漏了鉴权 —— 未登录即可对任意库内文件反复抽取（信息泄露 +
	   资源耗尽）。与文件流/归档读取保持一致，统一要求登录会话。 */
	if !readAuth(r) {
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
	/* v0.9.94（需求8）：转码 / 分页 / 音频缓存必须落在独立映射的卷上
	   （compose 里把独立磁盘挂到 /data/transcode-cache 这种），不能写进主 /data 卷 ——
	   主 /data 卷同时放着媒体索引与 Docker 数据，缓存一涨就把整卷顶满（实测 84%）。
	   启动时自检一次并打印结论：是独立卷就报设备与容量，否则明确告警。 */
	a.reportCacheVolume()
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
	mux.HandleFunc("/api/media/cover", a.coverSave)
	mux.HandleFunc("/api/media/cover/", a.coverGet)
	mux.HandleFunc("/api/media/archive/zip", a.archive)
	mux.HandleFunc("/api/media/archive/zip/register", a.archive)
	/* v0.9.67：按页转码端点（漫画「省流模式」）。w=0 时行为与 register 完全一致。 */
	mux.HandleFunc("/api/media/pdf/info", a.pdfInfo)
	mux.HandleFunc("/api/media/pdf/page", a.pdfPage)
	mux.HandleFunc("/api/media/pdf/cover", a.pdfCover)
	mux.HandleFunc("/api/media/archive/zip/page", a.archivePage)
	/* v0.9.67：归档首页缩略图，供书架卡片当封面（替代慢且易失败的外网封面刮削）。 */
	mux.HandleFunc("/api/media/archive/zip/cover", a.archiveCover)
	/* v0.9.70：EPUB 电子书按阅读顺序解析为纯文本章节（零新依赖，ZIP 容器自解析）。 */
	mux.HandleFunc("/api/media/document/epub", a.epubDocument)
	/* v0.9.67：歌词刮削（本地识别 + 在线源链 + sidecar 落盘）与音乐元数据服务端缓存。 */
	mux.HandleFunc("/api/media/audio/lyrics", a.audioLyrics)
	mux.HandleFunc("/api/media/audio/lyrics/batch", a.batchLyrics)
	mux.HandleFunc("/api/media/audio/cache", a.audioCache)
	mux.HandleFunc("/api/media/audio/cache/stats", a.audioCacheStats)
	/* v0.9.72: authoritative scrape status and persistent metadata commit. */
	mux.HandleFunc("/api/media/audio/scrape/status", a.audioScrapeStatus)
	mux.HandleFunc("/api/media/audio/metadata/commit", a.audioMetadataCommit)
	mux.HandleFunc("/api/media/archive", a.archive)
	mux.HandleFunc("/api/media/zip", a.archive)
	mux.HandleFunc("/api/media/settings", a.runtimeSettings)
	/* v0.9.88：刮削结果服务端持久化（影视 / 电子书）。 */
	mux.HandleFunc("/api/media/scrape-cache", a.scrapeCacheHandler)
	// v0.9.89：NFO 元数据本地化（刮削结果写回媒体目录，下次直接读本地，不再重复联网）。
	mux.HandleFunc("/api/media/nfo", a.nfoHandler)
	/* v1.0.9（需求1）：NFO 体检与补全 —— 服务端逐条检查本地 NFO 是否缺失/无信息，
	   缺失就刮削（TMDB → 豆瓣）并把 NFO 与海报写回媒体同目录。 */
	mux.HandleFunc("/api/media/nfo/repair", a.nfoRepairHandler)
	mux.HandleFunc("/api/media/nfo/repair/status", a.nfoRepairStatus)
	mux.HandleFunc("/api/media/nfo/repair/cancel", a.nfoRepairCancel)
	mux.HandleFunc("/api/media/nfo/repair/one", a.nfoRepairOne)
	/* v1.0.9（需求3）：大库服务端分页 / 音乐三级聚合 —— 前端不再下载整库索引。 */
	mux.HandleFunc("/api/media/shelf", a.shelfBrowse)
	mux.HandleFunc("/api/media/lookup", a.lookupPaths)
	mux.HandleFunc("/api/media/audio/browse", a.audioBrowse)
	/* v0.9.97：Plex 口径的多季剧集方案（命名体检 / 季集结构）与缺失集比对。 */
	mux.HandleFunc("/api/media/series/plan", a.seriesPlan)
	mux.HandleFunc("/api/media/series/missing", a.seriesMissing)
	/* v0.9.98：原盘（BDMV / ISO）播放菜单 —— 播放器「媒体菜单」的数据源。 */
	mux.HandleFunc("/api/media/disc/playlists", a.discPlaylistHandler)
	mux.HandleFunc("/api/media/scrapers", func(w http.ResponseWriter, r *http.Request) {
		/* v1.0.7 契约收紧：运行配置快照（含代理/密钥掩码等）不再匿名可读。 */
		if !readAuth(r) {
			errJSON(w, 401, "login required")
			return
		}
		out := a.runtimeConfigSnapshot(false)
		out["default"], out["types"] = out["scraper_mode"], []string{"movie", "series"}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("/api/media/hardware", func(w http.ResponseWriter, r *http.Request) {
		/* v1.0.7 契约收紧：硬件能力快照属于基础设施信息，不再匿名可读。 */
		if !readAuth(r) {
			errJSON(w, 401, "login required")
			return
		}
		writeJSON(w, 200, detectHardware(r.Context(), r.URL.Query().Get("hw")))
	})
	mux.HandleFunc("/api/media/probe", func(w http.ResponseWriter, r *http.Request) {
		/* v1.0.7 契约收紧：ffprobe 可枚举任意库内文件元数据，不再匿名可用。 */
		if !readAuth(r) {
			errJSON(w, 401, "login required")
			return
		}
		probe(w, r, a)
	})
	mux.HandleFunc("/api/media/playback/plan", a.playbackPlan)
	mux.HandleFunc("/api/media/playback/sessions", a.playbackSessionsHandler)
	mux.HandleFunc("/api/media/playback/sessions/", a.playbackSessionAction)
	mux.HandleFunc("/api/media/playback/progress", a.playbackProgress)
	mux.HandleFunc("/api/media/streams", func(w http.ResponseWriter, r *http.Request) { streams(w, r, a) })
	mux.HandleFunc("/api/media/tasks/cancel", func(w http.ResponseWriter, r *http.Request) { cancelTask(w, r, a) })
	mux.HandleFunc("/api/media/subtitles/search", a.subtitle)
	mux.HandleFunc("/api/media/subtitles/extract", a.extractSubtitle)
	mux.HandleFunc("/api/media/subtitles/proxy", a.externalSubtitle)
	mux.HandleFunc("/api/media/tmdb", a.tmdb)
	/* v1.0.2（需求5）：豆瓣评分代理（浏览器直连豆瓣必然被 CORS 拦）。 */
	mux.HandleFunc("/api/media/douban", a.douban)
	mux.HandleFunc("/api/media/douban/batch", a.doubanBatch)
	mux.HandleFunc("/api/media/cast/avatar", a.castAvatar)
	mux.HandleFunc("/api/media/tvdb", a.tvdb)
	mux.HandleFunc("/api/media/metadata", a.localMetadata)
	mux.HandleFunc("/api/media/metadata/batch", a.localMetadataBatch)
	mux.HandleFunc("/api/media/metadata/override", a.metadataOverride)
	mux.HandleFunc("/api/media/metadata/artwork", a.artworkCandidates)
	mux.HandleFunc("/api/media/reading/progress", a.readingProgress)
	mux.HandleFunc("/api/media/audio/metadata", a.audioMetadata)
	/* v0.9.56：歌手维度刮削（单人/组合/合作演唱关系），返回演唱者头像作为歌手封面。 */
	mux.HandleFunc("/api/media/audio/artist", a.audioArtist)
	/* v0.9.71 弱网：限码率音频流转码 + 客户端下行探测（见 audio_stream.go）。 */
	mux.HandleFunc("/api/media/audio/stream", a.audioStream)
	mux.HandleFunc("/api/media/weak/probe", a.weakProbe)
	mux.HandleFunc("/api/media/network/speed", a.networkSpeed)
	mux.HandleFunc("/api/media/compat", a.compat)
	fmt.Println("VaultHub media API listening on 127.0.0.1:9100")
	http.ListenAndServe("127.0.0.1:9100", mux)
}
/* v0.9.99：字幕搜索（播放器「搜索并挂载」）。旧实现只在本集目录里找
   以文件名开头的 .srt/.vtt/.ass/.ssa，原盘 / 内嵌图形字幕的库必然返回空 ——
   用户看到的就是「点了搜索并挂载什么都没有」。现在合并三个来源：
   ① 内嵌字幕轨（文本轨可直接挂载，图形轨给出烧录入口）；
   ② 本集目录与常见字幕子目录、剧名根目录下的字幕文件；
   ③ 匹配规则放宽：文件名包含关系，或「集号标记」一致（S01E02 / 01x02 / 第2集 / 独立两位数）。 */
func (a *App) subtitle(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	relPath := r.URL.Query().Get("path")
	p, _, e := safeFile(l, relPath)
	if e != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	items := []map[string]any{}
	/* ① 内嵌字幕轨 */
	subCtx, subCancel := context.WithTimeout(r.Context(), 25*time.Second)
	disc := a.resolveDiscInputWithPlaylist(subCtx, p, discPlaylistArg(r))
	for _, s := range embeddedSubtitleTracks(subCtx, disc, l.ID, relPath) {
		/* v1.0.0（需求3）：标签直接用语言/内容识别结果（「简体中文」「繁体中文」
		   「中英双语」…），不再出现「字幕 1 · 内嵌字幕 1」这种两段式冗余。 */
		label := "内嵌 · " + fmt.Sprint(s["label"])
		entry := map[string]any{"label": label, "kind": s["kind"], "text": s["text"], "burn_in": s["burn_in"], "index": s["index"], "codec": s["codec"], "language": s["language"], "pid": s["pid"]}
		if s["text"] == true {
			entry["url"] = s["url"]
		} else {
			entry["burn_track"] = s["burn_track"]
		}
		items = append(items, entry)
	}
	subCancel()
	/* ② 本地字幕文件 */
	d := filepath.Dir(p)
	stem := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
	subDirs := []string{"Subs", "subs", "Sub", "sub", "Subtitles", "subtitles", "字幕"}
	bases := []string{d}
	if l.Type == "series" {
		/* 单集在 Season NN/ 时，字幕常放在剧名根目录或其 Subs/ 下。 */
		bases = append(bases, seriesShowDirs(l, d)...)
	}
	dirs := []string{}
	for _, base := range bases {
		dirs = append(dirs, base)
		for _, sd := range subDirs {
			cand := filepath.Join(base, sd)
			if st, err := os.Stat(cand); err == nil && st.IsDir() {
				dirs = append(dirs, cand)
			}
		}
	}
	seen := map[string]bool{}
	for _, dir := range dirs {
		ents, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, x := range ents {
			if x.IsDir() {
				continue
			}
			ext := strings.ToLower(filepath.Ext(x.Name()))
			if !map[string]bool{".srt": true, ".vtt": true, ".ass": true, ".ssa": true}[ext] {
				continue
			}
			if !subtitleNameMatches(stem, x.Name()) {
				continue
			}
			abs := filepath.Join(dir, x.Name())
			if seen[abs] {
				continue
			}
			seen[abs] = true
			rel := indexRelFor(l, abs)
			if rel == "" {
				continue
			}
			items = append(items, map[string]any{"label": "本地 · " + x.Name(), "kind": "text", "text": true,
				"url": "/api/media/subtitles/proxy?id=" + url.QueryEscape(l.ID) + "&path=" + url.QueryEscape(filepath.ToSlash(rel))})
		}
	}
	writeJSON(w, 200, map[string]any{"items": items, "count": len(items)})
}

// subtitleNameMatches 判断某个本地字幕文件是否属于当前视频。
// 先比文件名包含关系，再比「集号标记」—— 原盘 / 压制组的字幕常与视频文件名
// 毫无共同前缀，但都带同一集号（S01E02 / 01x02 / 第2集 / [02]）。
func subtitleNameMatches(mediaStem, subName string) bool {
	ms, sn := strings.ToLower(strings.TrimSpace(mediaStem)), strings.ToLower(strings.TrimSpace(subName))
	if ms == "" || sn == "" {
		return false
	}
	if strings.Contains(sn, ms) || strings.Contains(ms, strings.TrimSuffix(sn, filepath.Ext(sn))) {
		return true
	}
	a, b := episodeTokenOf(ms), episodeTokenOf(sn)
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	/* 只有一方带季号时（s01e01 ↔ 01）：比集号即可；
	   双方都带季号却不一致（s01e01 ↔ s02e01）→ 判定不是同一集。 */
	if strings.Contains(a, "S") && strings.Contains(b, "S") {
		return false
	}
	ea, eb := episodeNoOf(a), episodeNoOf(b)
	return ea != "" && ea == eb
}

// episodeNoOf 取集号部分（S01E002 → 002，E002 → 002）。
func episodeNoOf(token string) string {
	if i := strings.Index(token, "E"); i >= 0 {
		return token[i+1:]
	}
	return ""
}

// episodeTokenOf 从文件名里抽出规整的集号标记，抽不到返回空串。
// 末尾一支是「裸集号」（01 / 12）：要求前后都不是数字，因此 1080p / 2160p 不会被误当成集号。
var episodeTokenPattern = regexp.MustCompile(`(?i)s(\d{1,2})\s*[ex._-]\s*(\d{1,3})|(\d{1,2})x(\d{1,3})|第\s*(\d{1,3})\s*[集话話]|(?:^|[\s._\-\[\]()])(\d{1,2})(?:[\s._\-\[\]()]|$)`)

func episodeTokenOf(name string) string {
	m := episodeTokenPattern.FindStringSubmatch(name)
	if m == nil {
		return ""
	}
	atoi := func(s string) int { n, _ := strconv.Atoi(s); return n }
	switch {
	case m[1] != "":
		return fmt.Sprintf("S%02dE%02d", atoi(m[1]), atoi(m[2]))
	case m[3] != "":
		return fmt.Sprintf("S%02dE%02d", atoi(m[3]), atoi(m[4]))
	case m[5] != "":
		return fmt.Sprintf("E%02d", atoi(m[5]))
	}
	return fmt.Sprintf("E%02d", atoi(m[6]))
}

/*
tmdbIsBearerToken 判定 TMDB v4 Read Access Token（JWT）：三段点分且以 eyJ 开头。

	v3 的 API Key 是 32 位十六进制，两者不会混淆。
*/
func tmdbIsBearerToken(key string) bool {
	k := strings.TrimSpace(key)
	return strings.HasPrefix(k, "eyJ") && strings.Count(k, ".") == 2
}

/*
scrubSecret 从回传文本里剔除配置的密钥（含 URL 转义形态），

	错误响应只用于诊断，绝不能把凭据带回浏览器。
*/
func scrubSecret(text, secret string) string {
	if secret == "" {
		return text
	}
	for _, form := range []string{secret, url.QueryEscape(secret), url.PathEscape(secret)} {
		if form == "" || form == secret && secret == "" {
			continue
		}
		text = strings.ReplaceAll(text, form, "***")
	}
	if len(text) > 300 {
		text = text[:300]
	}
	return text
}

/* castAvatarLocal：本地演职人员头像（库内文件）。白名单图片扩展名 + 4MiB 上限。 */
func (a *App) castAvatarLocal(w http.ResponseWriter, r *http.Request) {
	libID := strings.TrimSpace(r.URL.Query().Get("id"))
	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	if libID == "" || rel == "" {
		errJSON(w, 400, "invalid person")
		return
	}
	lib, ok := a.find(libID)
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	p, _, err := safeFile(lib, rel)
	if err != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	ct := localAvatarContentType(p)
	if ct == "" {
		errJSON(w, 415, "not an image")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		errJSON(w, 404, "avatar not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() || st.Size() > 4<<20 {
		errJSON(w, 413, "avatar too large")
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-VaultHub-Avatar", "local")
	_, _ = io.Copy(w, io.LimitReader(f, 4<<20))
}

/* localAvatarContentType：头像图片扩展名白名单（不认识的一律拒绝，避免把任意文件当图片吐出去）。 */
func localAvatarContentType(p string) string {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".bmp":
		return "image/bmp"
	case ".avif":
		return "image/avif"
	}
	return ""
}

func (a *App) castAvatar(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	person := r.URL.Query().Get("person")
	/* v0.9.98：本地头像 —— 媒体目录里的 .actors/姓名.jpg（Emby / Jellyfin 下载的头像），
	   或本地 NFO 里写的相对路径。用库内路径读取，与封面/海报同一条安全通道
	   （safeFile 负责防目录穿越）。 */
	if strings.TrimSpace(person) == "" {
		a.castAvatarLocal(w, r)
		return
	}
	if person == "" || strings.HasPrefix(person, "//") || strings.Contains(person, "..") || len(person) > 256 {
		errJSON(w, 400, "invalid person")
		return
	}
	a.mu.RLock()
	key, imgBase, proxy := a.tmdbAPIKey, a.tmdbImageBase, a.scraperProxy
	a.mu.RUnlock()
	imgURL := strings.TrimRight(imgBase, "/") + "/w185" + person
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, imgURL, nil)
	if tmdbIsBearerToken(key) {
		req.Header.Set("Authorization", "Bearer "+key)
	} else if key != "" {
		q := req.URL.Query()
		q.Set("api_key", key)
		req.URL.RawQuery = q.Encode()
	}
	client, cerr := outboundHTTPClient(proxy)
	if cerr != nil {
		errJSON(w, 400, cerr.Error())
		return
	}
	res, e := client.Do(req)
	if e != nil {
		errJSON(w, 502, "avatar fetch failed")
		return
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		errJSON(w, 502, "avatar "+res.Status[:3])
		return
	}
	ct := res.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "image/") {
		errJSON(w, 502, "not an image")
		return
	}
	if _, err := io.Copy(w, io.LimitReader(res.Body, 4<<20)); err != nil {
		return
	}
}

/*
v0.9.85：TMDB 语言白名单 —— 界面语言 → TMDB language 代码。非法值回落 zh-CN。

	v0.9.87：加入 ja-JP（刮削地区「日本」）。
*/
func tmdbLanguage(q string) string {
	switch strings.ToLower(strings.TrimSpace(q)) {
	case "en", "en-us":
		return "en-US"
	case "zh-tw", "zh-hk":
		return "zh-TW"
	case "ja", "ja-jp":
		return "ja-JP"
	}
	return "zh-CN"
}

/*
v0.9.87：刮削地区 —— 客户要求「增加刮削地区配置（中/日/美）并在后续的信息刮削中同步」。

	地区决定 TMDB 请求的 language：日文界面查美剧会拿到日文条目，若该条目没有日文翻译，
	TMDB 回落原名（对刮削无害）；反之用中文去查纯日文原名的作品会直接 0 结果，
	前端随即回落「文件名展示」—— 也就是客户看到的「直接使用资源名称」。
*/
func normalizeScrapeRegion(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "cn", "zh", "zh-cn", "china", "中国", "中國":
		return "cn"
	case "jp", "ja", "ja-jp", "japan", "日本":
		return "jp"
	case "us", "en", "en-us", "usa", "america", "美国", "美國":
		return "us"
	}
	return "auto"
}

/*
白名单校验必须看「原始输入」—— 归一化会把未知值静默变成 auto，

	那样任何输入都会被判为合法，客户切错地区也不会得到提示。
*/
func validScrapeRegion(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "auto":
		return true
	case "cn", "zh", "zh-cn", "china", "中国", "中國",
		"jp", "ja", "ja-jp", "japan", "日本",
		"us", "en", "en-us", "usa", "america", "美国", "美國":
		return true
	}
	return false
}
func scrapeRegionLanguage(region string) string {
	switch normalizeScrapeRegion(region) {
	case "cn":
		return "zh-CN"
	case "jp":
		return "ja-JP"
	case "us":
		return "en-US"
	}
	return ""
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
		/* v0.9.94（需求9 多季度分离刮削）：季标签（幽游白书S04）要取「第四季」的
		   季名/季简介/季海报与分集名，只有 search/* 与 {movie,tv}/{id} 两个端点是
		   不够的 —— 这里放开 tv/{id}/season/{n}，季号必须是 0~99 的整数。 */
		if season := strings.TrimSpace(r.URL.Query().Get("season")); season != "" && kind == "tv" {
			n, err := strconv.Atoi(season)
			if err != nil || n < 0 || n > 99 {
				errJSON(w, 400, "invalid TMDB season")
				return
			}
			endpoint = "tv/" + id + "/season/" + strconv.Itoa(n)
		}
	}
	/* v0.9.77：TMDB 有两种凭据形态 —— v3 API Key（32 位十六进制）用 ?api_key=，
	   v4 Read Access Token（JWT，形如 eyJ…，带两个点）必须用 Authorization: Bearer。
	   此前一律拼 ?api_key=，用户填的是 v4 Token → TMDB 返回
	   {"status_code":7,"status_message":"Invalid API key..."}（HTTP 401），
	   前端 if(res.ok) 整段跳过 → 详情/演职人员/TMDB 评分/影视推荐全部不生效。 */
	/* v0.9.83：详情接口追加 images —— 推荐「视频信息」弹窗在简介较长时用
	   多张横版剧照填充左侧图集（前端只保留 1.5~1.9 宽高比的图）。 */
	/* v0.9.85：language 跟随界面语言（前端传 lang=zh-CN/zh-TW/en-US）——
	   演职人员姓名与角色名、简介、剧集名都随系统语言本地化。白名单校验，
	   非法值一律回落 zh-CN（历史默认）。 */
	lang := ""
	if q := strings.TrimSpace(r.URL.Query().Get("lang")); q != "" {
		lang = tmdbLanguage(q)
	} else if rq := strings.TrimSpace(r.URL.Query().Get("region")); rq != "" {
		lang = scrapeRegionLanguage(rq)
	}
	if lang == "" {
		/* 前端未显式带语言时按已配置的刮削地区（auto → 历史默认 zh-CN）。 */
		a.mu.RLock()
		region := a.scrapeRegion
		a.mu.RUnlock()
		lang = scrapeRegionLanguage(region)
	}
	if lang == "" {
		lang = "zh-CN"
	}
	u := base + "/" + endpoint + "?language=" + url.QueryEscape(lang)
	/* v0.9.94：季详情端点不接受 credits/recommendations/images 这些追加参数
	   （TMDB 会直接报错），只有影视详情与搜索需要它们。 */
	if !strings.Contains(endpoint, "/season/") {
		u += "&append_to_response=credits,recommendations,images"
	}
	if !tmdbIsBearerToken(key) {
		u += "&api_key=" + url.QueryEscape(key)
	}
	if strings.HasPrefix(endpoint, "search/") {
		u += "&query=" + url.QueryEscape(r.URL.Query().Get("query"))
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	if tmdbIsBearerToken(key) {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("Accept", "application/json")
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
	body, readErr := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if readErr != nil {
		errJSON(w, 502, "tmdb read failed")
		return
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		/* v0.9.77：把 TMDB 的 status_message 原样带回（含 invalid key 之类），
		   让前端能显示「TMDB 密钥无效/未授权」而不是一片空白。
		   审查项（配置与密钥）：上游可能把请求 URL/凭据回显在错误体里，
		   回传前先擦除本机配置的密钥，避免凭据经错误响应外泄。 */
		msg := scrubSecret(string(body), key)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(res.StatusCode)
		_, _ = w.Write([]byte(msg))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(res.StatusCode)
	_, _ = w.Write(body)
}

// v0.9.93：后台预转码（为下次打开准备可拖动的缓存）必须可取消。
//
// 旧实现用 context.Background() 起后台 ffmpeg：用户关掉播放器后浏览器已断开、
// 前台流也结束了，后台那个 ffmpeg 仍会把整部片子转完（上限 compatBuildTimeout=6h）——
// 客户看到的就是「播放器关闭 / 停止播放后，后台还有数据在跑」（CPU 占用、缓存目录持续变大）。
//
// 现在：构建注册表保存 cancel，并且按「是否还有人在看」决定生死 ——
// 最后一个观看者断开（或显式 stop 播放会话）时立即取消后台转码。
type compatBuildState struct {
	cancel    context.CancelFunc
	mediaPath string // 绝对路径，用于按播放会话的库内相对路径后缀匹配
}

var (
	compatMu       sync.Mutex
	compatBuilds   = map[string]*compatBuildState{}
	compatWatchers = map[string]int{} // cache 文件 → 正在观看该转码流的客户端数
)

// compatBuildMaxConcurrent 限制同时进行的后台预转码数量：同时打开多部片子时
// 不能把整机 CPU 交给一堆后台 ffmpeg。
const compatBuildMaxConcurrent = 2

// noteCompatWatcher / releaseCompatWatcher 维护「这条转码流还有几个人在看」。
// 归零即取消对应的后台构建（前台流本身由 r.Context() 结束）。
func noteCompatWatcher(cache string) {
	compatMu.Lock()
	compatWatchers[cache]++
	compatMu.Unlock()
}
func releaseCompatWatcher(cache string) {
	compatMu.Lock()
	if n := compatWatchers[cache]; n > 1 {
		compatWatchers[cache] = n - 1
	} else {
		delete(compatWatchers, cache)
	}
	var cancel context.CancelFunc
	if compatWatchers[cache] == 0 {
		if st := compatBuilds[cache]; st != nil {
			cancel = st.cancel
		}
	}
	compatMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// cancelCompatBuildsForMedia 取消所有正在为某个媒体文件做预转码的后台任务。
// 播放会话 stop 时调用：即便客户端连接还没断，也立刻停掉后台转码。
func cancelCompatBuildsForMedia(mediaPath string) int {
	rel := strings.TrimPrefix(mediaPath, "/")
	compatMu.Lock()
	var cbs []context.CancelFunc
	for _, st := range compatBuilds {
		if st == nil {
			continue
		}
		spec := st.mediaPath
		if spec == mediaPath || (rel != "" && strings.HasSuffix(spec, "/"+rel)) {
			cbs = append(cbs, st.cancel)
		}
	}
	compatMu.Unlock()
	for _, cb := range cbs {
		cb()
	}
	return len(cbs)
}

// compatArgs assembles the ffmpeg arguments shared by the live stream and the
// background cache build: pick the video codec (copy when the source is already
// H.264), map the requested audio track, and always deliver stereo AAC.
func compatArgs(ctx context.Context, p, audioTrack, hw, mode string) (pre []string, mid []string) {
	return compatArgsScaled(ctx, p, audioTrack, hw, mode, 0, -1, "")
}

// compatArgsScaled builds the ffmpeg arguments for the compatibility stream.
// maxHeight > 0 caps the output height (v0.9.50 播放器 设置 → 转码质量); a cap
// forces a real re-encode because you cannot scale a copied stream.
//
// v0.9.51 音画同步修复：
//
//	· copy 模式显式补 -fflags +genpts+igndts，避免容器时间基漂移导致音画不同步
//	· 转码/重编码模式加 -async 1，强制 ffmpeg 在输出结尾做 1 次音频时钟同步拉伸，
//	  修正长播放后音频时钟相对于视频时钟的累积漂移
//	· 统一 -vsync cfr + -r 源帧率，保证输出恒定帧率，消除因 VFR 内容导致的
//	  音频时钟与视频时钟脱钩
func compatArgsScaled(ctx context.Context, p, audioTrack, hw, mode string, maxHeight int, subTrack int, burnInput string) (pre []string, mid []string) {
	/* v0.9.99 图形字幕烧录：把字幕位图 overlay 到视频上，必须重编码视频。
	   这里刻意走软编码（libx264）—— overlay 需要把字幕位图解码到内存再合成，
	   硬件编码链要额外做 hwdownload/hwupload 往返，跨驱动不稳定，宁可慢也要出画面。

	   v0.9.99 续（容器实测发现）：原盘用 bluray:/dvdvideo 直接做输入时，PGS 字幕流在
	   libbluray 里没有尺寸信息（ffprobe 报 unspecified size），ffmpeg 的 sub2video 会退回
	   720x480 默认画布，字幕位图落在画布外 —— 逐帧比对下「有/无 overlay」两帧完全一致
	   （黑底测量 YMAX 恒为 16，即纯黑），等于什么都没烧。把选中的字幕轨先 copy 成独立
	   .sup（PGS 自带 PTS，时间轴与主视频一致）再当第二个输入 overlay，字幕才真正出现
	   （同一测点 YMAX=217）。所以原盘一律走 burnInput 分支。 */
	if subTrack >= 0 {
		subSpec := fmt.Sprintf("0:s:%d", subTrack)
		if burnInput != "" {
			subSpec = "1:s:0"
		}
		srcFps := "25"
		if fc, ok := detectFramerate(ctx, p); ok && fc > 0 {
			srcFps = fmt.Sprintf("%d", fc)
		}
		chain := ""
		if maxHeight > 0 {
			chain = fmt.Sprintf("scale=-2:min(ih\\,%d),", maxHeight)
		}
		audioMap := "0:a:0?"
		if n, err := strconv.Atoi(audioTrack); audioTrack != "" && err == nil && n >= 0 {
			audioMap = fmt.Sprintf("0:a:%d?", n)
		}
		pre = []string{"-fflags", "+genpts+igndts", "-async", "1"}
		mid = []string{
			"-filter_complex", fmt.Sprintf("[0:v:0]%ssetpts=PTS-STARTPTS[v0];[v0][%s]overlay=format=auto:eof_action=pass[vout]", chain, subSpec),
			"-map", "[vout]",
			"-map", audioMap,
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-tune", "zerolatency",
			"-c:a", "aac", "-ac", "2", "-b:a", "160k",
			"-r", srcFps, "-vsync", "cfr",
		}
		return pre, mid
	}
	vcodec := ""
	var post []string
	srcFps := "25" // safe fallback
	if fc, ok := detectFramerate(ctx, p); ok && fc > 0 {
		srcFps = fmt.Sprintf("%d", fc)
	}
	if vc, _ := probeVideoCodec(ctx, p); vc == "h264" && mode != "full_transcode" && maxHeight <= 0 {
		vcodec = "copy"                                // stream copy: no CPU transcode, starts instantly
		pre = append(pre, "-fflags", "+genpts+igndts") // v0.9.51 音画同步：修复 PTS 生成
	} else {
		hwInfo := detectHardware(ctx, hw)
		mode, _ := hwInfo["selected"].(string)
		dev, _ := hwInfo["vaapi_device"].(string)
		pre, vcodec, post = hwEncodeArgs(mode, dev)
		if maxHeight > 0 {
			post = withScaleFilter(post, vcodec, maxHeight)
		}
		pre = append(pre, "-fflags", "+genpts+igndts") // v0.9.51 音画同步
		pre = append(pre, "-async", "1")               // v0.9.51 音画同步：结尾同步拉伸
	}
	mid = []string{"-map", "0:v:0"}
	if n, err := strconv.Atoi(audioTrack); audioTrack != "" && err == nil && n >= 0 {
		mid = append(mid, "-map", fmt.Sprintf("0:a:%d?", n))
	} else {
		mid = append(mid, "-map", "0:a:0?")
	}
	mid = append(mid, "-c:v", vcodec)
	mid = append(mid, post...)
	mid = append(mid, "-r", srcFps, "-vsync", "cfr")
	if mode == "remux" && maxHeight <= 0 {
		mid = append(mid, "-c:a", "copy")
	} else {
		mid = append(mid, "-c:a", "aac", "-ac", "2", "-b:a", "160k")
	}
	return pre, mid
}

// detectFramerate probes the average frame rate of the first video stream.
// Returns (fps, true) on success or (0, false) if the stream cannot be read.
func detectFramerate(ctx context.Context, p string) (int, bool) {
	b, e := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=avg_frame_rate",
		"-of", "default=nk=1:nw=1",
		p).Output()
	if e != nil {
		return 0, false
	}
	parts := strings.Split(strings.TrimSpace(string(b)), "/")
	if len(parts) != 2 {
		return 0, false
	}
	num, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	den, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil || den == 0 {
		return 0, false
	}
	// Round to nearest integer fps; use > 0 guard.
	fps := int(float64(num)/float64(den) + 0.5)
	if fps <= 0 {
		return 0, false
	}
	return fps, true
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

// prepareBurnSubtitle 把原盘里选中的图形字幕轨抽成独立 .sup，供 overlay 当第二个输入用。
//
// 为什么必须这么做：用 bluray:/dvdvideo 当输入时，libbluray 交给 ffmpeg 的 PGS 字幕流没有
// 尺寸信息（ffprobe 报 unspecified size），ffmpeg 的 sub2video 机制退回 720x480 默认画布，
// 字幕位图实际落在画布之外。实测（容器内对真实《黑鹰坠落》BDMV）：「有/无 overlay」逐帧
// blend=difference 的 YAVG 恒为 0，把字幕叠到纯黑底上 YMAX 恒为 16（纯黑），字幕等于没烧。
// 用 -c:s copy 抽成 .sup 后，同一测点的黑底 YMAX=217，字幕正常渲染 —— PGS .sup 自带 PTS，
// 时间轴与主视频一致，直接当第二路输入即可。
//
// 失败时返回 ""，调用方退回原地的 0:s:N（普通 MKV/MP4 图形字幕走原地路径本来就正常）。
// 抽出物放在缓存目录的 burnsub/ 子目录（缓存清理器只扫 .mp4，不会误删也不会把它计入配额），
// 文件名由「媒体路径 + sub_track」派生，同一字幕轨只抽一次、可供不同音频/画质档复用。
func (a *App) prepareBurnSubtitle(ctx context.Context, disc discInput, st os.FileInfo, cache string, subTrack int) string {
	if disc.Kind != discInputBluRay && disc.Kind != discInputDVD {
		/* 普通文件（plain）的图形字幕原地 overlay 就正常，不需要先抽 .sup。 */
		return ""
	}
	if st == nil {
		return ""
	}
	h := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d:s%d", disc.Spec, st.Size(), st.ModTime().UnixNano(), subTrack)))
	dir := filepath.Join(filepath.Dir(cache), "burnsub")
	if e := os.MkdirAll(dir, 0755); e != nil {
		return ""
	}
	out := filepath.Join(dir, hex.EncodeToString(h[:])+".sup")
	if fi, e := os.Stat(out); e == nil && fi.Size() > 0 {
		return out
	}
	ectx, cancel := context.WithTimeout(ctx, compatBuildTimeout)
	defer cancel()
	tmp := out + ".part"
	args := []string{"-hide_banner", "-loglevel", "error", "-y"}
	args = append(args, disc.InputArgs()...)
	args = append(args, "-i", disc.Spec, "-map", fmt.Sprintf("0:s:%d", subTrack), "-c:s", "copy", "-f", "sup", tmp)
	if e := exec.CommandContext(ectx, "ffmpeg", args...).Run(); e != nil {
		_ = os.Remove(tmp)
		return ""
	}
	if fi, e := os.Stat(tmp); e != nil || fi.Size() == 0 {
		_ = os.Remove(tmp)
		return ""
	}
	if e := os.Rename(tmp, out); e != nil {
		_ = os.Remove(tmp)
		return ""
	}
	return out
}

// buildCompatCache produces the seekable (faststart) MP4 in the background so
// the *next* open is a plain cache hit with full Range support. It deliberately
// uses a detached context: the user closing the tab must not abort it.
// parent 是发起播放的那个客户端请求的 context：客户端断开（关播放器 / 关页面）
// 时 parent 结束，后台转码立即取消，不再空转。
func (a *App) buildCompatCache(parent context.Context, disc discInput, cache, audioTrack, hw, mode string, maxHeight int, subTrack int, burnInput string) {
	compatMu.Lock()
	if _, running := compatBuilds[cache]; running {
		compatMu.Unlock()
		return
	}
	if len(compatBuilds) >= compatBuildMaxConcurrent {
		compatMu.Unlock()
		fmt.Printf("compat precache skipped: %d builds already running\n", len(compatBuilds))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), compatBuildTimeout)
	if parent != nil {
		/* 父请求结束（客户端断开）→ 取消本次预转码。父 context 生命周期总是
		   比本构建短：请求结束即无人观看，继续转只是在烧 CPU 和磁盘。 */
		go func() {
			select {
			case <-parent.Done():
				cancel()
			case <-ctx.Done():
			}
		}()
	}
	compatBuilds[cache] = &compatBuildState{cancel: cancel, mediaPath: disc.Spec}
	compatMu.Unlock()
	go func() {
		defer func() { compatMu.Lock(); delete(compatBuilds, cache); compatMu.Unlock() }()
		defer cancel()
		tmp := cache + fmt.Sprintf(".bg-%d", os.Getpid())
		pre, mid := compatArgsScaled(ctx, disc.Spec, audioTrack, hw, mode, maxHeight, subTrack, burnInput)
		args := append([]string{"-hide_banner", "-loglevel", "error"}, pre...)
		args = append(args, disc.InputArgs()...)
		args = append(args, "-i", disc.Spec)
		if burnInput != "" {
			args = append(args, "-i", burnInput)
		}
		args = append(args, mid...)
		args = append(args, "-movflags", "+faststart", "-f", "mp4", "-y", tmp)
		if e := exec.CommandContext(ctx, "ffmpeg", args...).Run(); e != nil {
			_ = os.Remove(tmp)
			return
		}
		if e := os.Rename(tmp, cache); e != nil {
			_ = os.Remove(tmp)
			return
		}
		/* v0.9.91：单条目超额直接丢弃。一个 9.7 GB 的整片转码缓存会独占并击穿配额
		   （生产实测：配额 30.7 GB / 实际 45 GB），而这块盘同时放着索引库 ——
		   撑满后整个应用（含 WebUI）都会失去响应。缓存只是加速手段，丢弃不影响播放。 */
		a.mu.RLock()
		budget := a.cacheMaxBytes
		a.mu.RUnlock()
		if limit := cacheEntryLimit(budget); limit > 0 {
			if info, err := os.Stat(cache); err == nil && info.Size() > limit {
				_ = os.Remove(cache)
				fmt.Printf("compat cache entry exceeds per-entry budget, dropped: %s (%d bytes, limit %d)\n", filepath.Base(cache), info.Size(), limit)
			}
		}
		/* 每次构建完立刻按配额清理一次，避免攒到下一次定时清理。 */
		a.cleanCache()
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
	/* v0.9.99：图形字幕（PGS / DVD 子图 / DVB 子图）没有文本层，浏览器无法渲染，
	   也无法像 SRT 那样转成 WebVTT —— 唯一可行路径是服务端把它叠进画面（burn-in）。
	   sub_track 是字幕流序号（ffmpeg 的 0:s:N，N 就是这里的值），-1 表示不烧录。
	   烧录必须重编码视频，因此强制 full_transcode。 */
	subTrack := -1
	if n, err := strconv.Atoi(r.URL.Query().Get("sub_track")); err == nil && n >= 0 && n < 256 {
		subTrack = n
		mode = "full_transcode"
	}
	// v0.9.50: height caps the output resolution (播放器 设置 → 转码质量). It is part
	// of the cache key so 1080p and 720p renditions never collide on disk.
	maxHeight := 0
	if n, err := strconv.Atoi(r.URL.Query().Get("height")); err == nil && n >= 144 && n <= 4320 {
		maxHeight = n
	}
	/* v0.9.88：原盘镜像的转码输入与探测保持一致（bluray: / dvdvideo），
	   并把它并入缓存键 —— 否则同一镜像换了解析方式会命中旧缓存。 */
	/* v1.0.8：ss = 起始秒数（客户端拖动进度条用）。
	   背景：缓存未命中时走的是「边转边发」的分片 MP4（Accept-Ranges: none），
	   没有字节范围就没有拖动 —— 浏览器发 Range 我们答不了，只能整段重来。
	   所以把「时间位置」做成参数：带 ss 时 ffmpeg 从该秒数起转（-ss 在 -i 之前，
	   走关键帧快 seek），客户端只需换 URL 重新请求，就能实现首次播放也能拖动。
	   缓存命中时忽略 ss（整段文件自带 Range，客户端自己 seek 更快）。 */
	seekStart := 0.0
	if v, err := strconv.ParseFloat(r.URL.Query().Get("ss"), 64); err == nil && v > 0 && v <= 86400 {
		seekStart = v
	}
	disc := a.resolveDiscInputWithPlaylist(r.Context(), p, discPlaylistArg(r))
	cache := a.cacheKey(fmt.Sprintf("%s:%d:%d:%s:%s:a%s:h%d:d%s:r%d:s%d", p, st.Size(), st.ModTime().UnixNano(), hw, mode, audioTrack, maxHeight, disc.Kind, disc.SelectedRef(), subTrack))
	// Fully built cache: serve it with byte ranges so seeking works.
	if f, e := os.Open(cache); e == nil {
		defer f.Close()
		/* v0.9.92（审查的中危项）：命中即刷新 mtime。正在播放的条目在 LRU 里
		   始终保持「最新」，边播边清不会把它删掉；否则播放中拖动进度条正好赶上
		   清理窗口，同一条转码产物会被删掉再重新转一遍（用户体感：拖一下卡一次）。 */
		if nowT := time.Now(); true {
			_ = os.Chtimes(cache, nowT, nowT)
		}
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
	/* v0.9.99：原盘（bluray:/dvdvideo）的 PGS 字幕无法直接从 bluray: 输入 overlay（见
	   compatArgsScaled 注释里的实测），先把选中的字幕轨 copy 成独立 .sup，再把它当第二个
	   输入。抽不出来就退回原地的 0:s:N（普通 MKV/MP4 的图形字幕走这条路本就正常）。 */
	burnInput := ""
	if subTrack >= 0 {
		burnInput = a.prepareBurnSubtitle(r.Context(), disc, st, cache, subTrack)
	}
	pre, mid := compatArgsScaled(ctx, disc.Spec, audioTrack, hw, mode, maxHeight, subTrack, burnInput)
	args := append([]string{"-hide_banner", "-loglevel", "error"}, pre...)
	args = append(args, disc.InputArgs()...)
	/* v1.0.8：-ss 属于输入选项，必须排在 -i 之前；走的是 ffmpeg 的关键帧快 seek，
	   大文件也能秒开。 */
	if seekStart > 0 {
		args = append(args, "-ss", strconv.FormatFloat(seekStart, 'f', 3, 64))
	}
	args = append(args, "-i", disc.Spec)
	if burnInput != "" {
		args = append(args, "-i", burnInput)
	}
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
	/* v0.9.93：登记「有人在看这条转码流」。最后一个观看者断开时，
	   后台预转码会被取消 —— 关掉播放器后不再有后台数据在跑。 */
	noteCompatWatcher(cache)
	defer releaseCompatWatcher(cache)
	/* v1.0.8：带 ss 的请求是「拖动后续播」，不再顺带触发整段预转码 ——
	   否则每拖一次就重建一次缓存，父请求一断又被取消，白烧 CPU。 */
	if seekStart <= 0 && env("COMPAT_PRECACHE", "1") != "0" {
		a.buildCompatCache(r.Context(), disc, cache, audioTrack, hw, mode, maxHeight, subTrack, burnInput)
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-VaultHub-Compat", "live")
	w.Header().Set("X-VaultHub-Seek-Start", strconv.FormatFloat(seekStart, 'f', 3, 64))
	// v0.9.51 音画同步：通过 HTTP 响应头降低浏览器缓冲上限，
	// 迫使 HTMLVideoElement 的 currentTime 尽可能贴近实时位置，
	// 缩小音频时钟与视频时钟的漂移窗口。
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Transfer-Encoding", "chunked")
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
