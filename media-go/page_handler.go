package main

import (
	"archive/zip"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

/* v0.9.67：漫画/归档「按页转码」HTTP 端点
 *
 *   GET /api/media/archive/zip/page?id=&path=&entry=&w=&q=
 *        w=0（默认）或缓存禁用 → 与旧端点 archive/zip/register 完全一致：原样直出该页。
 *        w>0                   → 解码→降采样→JPEG→落盘缓存后下发；命中磁盘缓存则 0 成本。
 *   GET /api/media/archive/zip/cover?id=&path=&w=&q=
 *        直接返回归档第一页的缩略图（默认宽 320），供书架卡片当封面，
 *        替代此前「外网刮削封面」在漫画书目上既慢又常失败的问题。
 *
 * 安全与稳健性：
 *   - 复用 readAuth + find + safeFile：未登录 401、库不存在 404、路径越界 404；
 *   - entry 必须命中该归档已解析条目（indexOf 白名单），杜绝 zip-slip / 任意文件读取；
 *   - w/q 越界一律 400，不做静默钳制，避免客户端写出不可复现的缓存键；
 *   - 转码失败、像素过大、条目过大、转码后更大 → 一律回落原样直出，保证「永远能读」；
 *   - 同键并发用进程内 singleflight 合并，避免同一页被并发解码多次。
 *
 * 可观测性：响应头 X-Vaulthub-Page-Cache: hit | miss | off，便于验证与排障。
 */

/* 转码全局并发闸门。
   转码是 CPU + 内存密集型：解码一张 4M 像素的扫描页峰值内存约 30–70MB，且不同页面的
   缓存键不同 —— singleflight 只合并同键请求，拦不住「同时请求很多不同页」的场景
   （滚轮快速预取、多个客户端、或恶意构造）。没有全局上限时容器内存会被打爆。
   配额：min(3, max(2, NumCPU/2))；队列等待超过 8s 或客户端已断开则放弃转码、回落直出。 */
const transcodeQueueTimeout = 8 * time.Second

func (a *App) acquireTranscode(ctx context.Context) (func(), bool) {
	a.transcodeSemOnce.Do(func() {
		n := runtime.NumCPU() / 2
		if n < 2 {
			n = 2
		}
		if n > 3 {
			n = 3
		}
		a.transcodeSem = make(chan struct{}, n)
	})
	release := func() { <-a.transcodeSem }
	select {
	case a.transcodeSem <- struct{}{}:
		return release, true
	case <-ctx.Done():
		return func() {}, false
	case <-time.After(transcodeQueueTimeout):
		return func() {}, false
	}
}

type pageJob struct {
	done chan struct{}
	file string
	ok   bool
}

func (a *App) zipCacheRef() *zipArchiveCache {
	a.zipCacheMu.Lock()
	defer a.zipCacheMu.Unlock()
	if a.zipCache == nil {
		a.zipCache = newZipArchiveCache(8)
	}
	return a.zipCache
}

func (a *App) pageCacheRef() *pageCache {
	a.pageCacheMu.Lock()
	defer a.pageCacheMu.Unlock()
	if a.pageCache == nil {
		dir := a.pageCacheDir
		if dir == "" {
			dir = env("MEDIA_PAGE_CACHE_DIR", filepath.Join(a.cacheDir, "page-cache"))
		}
		max := a.pageCacheMaxBytes
		if max == 0 {
			max = envInt64("MEDIA_PAGE_CACHE_MAX_BYTES", 4*1024*1024*1024)
		}
		a.pageCache = newPageCache(dir, max)
	}
	return a.pageCache
}

func (a *App) beginPageJob(key string) (*pageJob, bool) {
	a.pageJobsMu.Lock()
	defer a.pageJobsMu.Unlock()
	if a.pageJobs == nil {
		a.pageJobs = map[string]*pageJob{}
	}
	if j, ok := a.pageJobs[key]; ok {
		return j, false
	}
	j := &pageJob{done: make(chan struct{})}
	a.pageJobs[key] = j
	return j, true
}

func (a *App) endPageJob(key string, j *pageJob, file string, ok bool) {
	/* 顺序很重要：先把结果落到 job 上并关闭 done（等待方据此读取），最后再摘除表项。
	   若先 delete，同一 key 会在「已删除但 done 未关闭」的窗口里被第二个请求当成新
	   leader —— 两路并发解码同页，只是白烧 CPU/IO。 */
	a.pageJobsMu.Lock()
	j.file, j.ok = file, ok
	close(j.done)
	delete(a.pageJobs, key)
	a.pageJobsMu.Unlock()
}

// pageParams 解析 w/q；返回 bad=true 表示参数越界（调用方应回 400）。
func pageParams(r *http.Request, defaultWidth, maxWidth int) (width, quality int, bad bool) {
	width = defaultWidth
	if v := strings.TrimSpace(r.URL.Query().Get("w")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > maxWidth {
			return 0, 0, true
		}
		width = n
	}
	if width > 0 && width < 64 {
		return 0, 0, true
	}
	quality = 82
	if v := strings.TrimSpace(r.URL.Query().Get("q")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			return 0, 0, true
		}
		quality = n
	}
	return width, quality, false
}

func (a *App) archivePage(w http.ResponseWriter, r *http.Request) {
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
	entry := r.URL.Query().Get("entry")
	if entry == "" {
		errJSON(w, 400, "entry required")
		return
	}
	width, quality, bad := pageParams(r, 0, 4096)
	if bad {
		errJSON(w, 400, "invalid w or q")
		return
	}
	zc := a.zipCacheRef()
	ze, e := zc.acquire(p)
	if e != nil {
		errJSON(w, 400, "not a ZIP/CBZ archive")
		return
	}
	defer zc.release(ze)
	i := ze.indexOf(entry)
	if i < 0 {
		errJSON(w, 404, "archive entry not found")
		return
	}
	if a.serveTranscodedPage(w, r, l, p, ze, i, width, quality) {
		return
	}
	w.Header().Set("X-Vaulthub-Page-Cache", "off")
	writeArchiveEntryRaw(w, ze.files[i], ze.display[i])
}

// archiveCover 书架封面：归档第一张图片的缩略图（默认宽 320）。
func (a *App) archiveCover(w http.ResponseWriter, r *http.Request) {
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
	width, quality, bad := pageParams(r, 320, 1024)
	if bad {
		errJSON(w, 400, "invalid w or q")
		return
	}
	/* 封面必须真的缩略：w=0 会让书架每张卡片下整张原图（多 MB）。
	   审查建议强制 w>=64，不可转码时返回 404 让前端回落到渐变占位。 */
	if width == 0 {
		errJSON(w, 400, "cover requires w>=64")
		return
	}
	zc := a.zipCacheRef()
	ze, e := zc.acquire(p)
	if e != nil {
		errJSON(w, 400, "not a ZIP/CBZ archive")
		return
	}
	defer zc.release(ze)
	/* 与 archive() 的条目列表用同一套自然排序，保证「第一页」= 阅读器的第 1 页。 */
	idx := make([]int, 0, len(ze.files))
	for i, x := range ze.files {
		if imageEntry(ze.display[i]) || imageEntry(x.Name) {
			idx = append(idx, i)
		}
	}
	if len(idx) == 0 {
		errJSON(w, 404, "archive has no images")
		return
	}
	sort.SliceStable(idx, func(x, y int) bool { return naturalLess(ze.display[idx[x]], ze.display[idx[y]]) })
	if a.serveTranscodedPage(w, r, l, p, ze, idx[0], width, quality) {
		return
	}
	/* 不能缩略时不回整张原图（书架会变成几 MB 一页），404 → 前端用渐变占位兜底。 */
	errJSON(w, 404, "cover unavailable")
}

// serveTranscodedPage 尝试「转码 + 磁盘缓存」并下发；返回 false 表示调用方应回落直出。
// 覆盖的可观测头：hit（命中磁盘缓存）/ miss（本次转码并落盘）/ off（不可转码）。
func (a *App) serveTranscodedPage(w http.ResponseWriter, r *http.Request, l Library, archivePath string, ze *zipCacheEntry, i, width, quality int) bool {
	if i < 0 || i >= len(ze.files) {
		return false
	}
	if width <= 0 {
		return false
	}
	pc := a.pageCacheRef()
	if !pc.enabled() {
		return false
	}
	f := ze.files[i]
	fi := f.FileInfo()
	if fi.Size() > maxPageSourceBytes {
		return false
	}
	/* 键里必须含**归档自身**的 size/mtime：条目 size/mtime 在「保留时间戳重打包」后可能不变，
	   那样会下发陈旧页面。归档身份由 LRU 每请求校验，这里再多取一次 stat 并入键。 */
	arcSize, arcMod := fi.Size(), fi.ModTime().Unix()
	if st, err := os.Stat(archivePath); err == nil {
		arcSize, arcMod = st.Size(), st.ModTime().Unix()
	}
	key := pageCacheKey(l.ID, archivePath, f.Name, arcSize, arcMod, width, quality)
	if file, ok := pc.get(key); ok {
		/* 注意顺序：响应头必须在写响应体之前设置（http.ServeContent 一写体就落头），
		   否则 X-Vaulthub-Page-Cache 会被静默丢弃。若缓存文件此刻不可用，
		   撤掉该头并把请求交给下面的转码/直出路径，绝不回 404。 */
		w.Header().Set("X-Vaulthub-Page-Cache", "hit")
		if serveCachedPage(w, r, file, key) {
			return true
		}
		w.Header().Del("X-Vaulthub-Page-Cache")
	}
	job, leader := a.beginPageJob(key)
	if !leader {
		select {
		case <-job.done:
		case <-r.Context().Done():
			errJSON(w, 499, "client closed request")
			return true
		}
		if job.ok {
			w.Header().Set("X-Vaulthub-Page-Cache", "hit")
			if serveCachedPage(w, r, job.file, key) {
				return true
			}
			w.Header().Del("X-Vaulthub-Page-Cache")
		}
		return false
	}
	file, cached := "", false
	/* 用 defer 保证「任何退出路径」都会结束 job（含解码器 panic）：
	   审查指出漏掉 endPageJob 会让 pageJobs[key] 永久残留，
	   之后同键请求全部阻塞在永不关闭的 done 上。 */
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				file, cached = "", false
			}
			a.endPageJob(key, job, file, cached)
		}()
		release, allowed := a.acquireTranscode(r.Context())
		if !allowed {
			return
		}
		defer release()
		raw, err := readZipEntry(f, maxPageSourceBytes)
		if err != nil {
			return
		}
		if out, ok := transcodePageImage(raw, width, quality); ok {
			file, cached = pc.put(key, out, "jpg")
		}
	}()
	if cached {
		w.Header().Set("X-Vaulthub-Page-Cache", "miss")
		if serveCachedPage(w, r, file, key) {
			return true
		}
		w.Header().Del("X-Vaulthub-Page-Cache")
	}
	return false
}

func readZipEntry(f *zip.File, limit int64) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, limit+1))
}

// writeArchiveEntryRaw 与旧的 archive() 直出分支保持一致的嗅探与缓存头。
func writeArchiveEntryRaw(w http.ResponseWriter, f *zip.File, displayName string) {
	rc, err := f.Open()
	if err != nil {
		errJSON(w, 404, "archive entry not found")
		return
	}
	defer rc.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(rc, head)
	head = head[:n]
	contentType := http.DetectContentType(head)
	if !strings.HasPrefix(contentType, "image/") {
		if mt := mime(displayName); strings.HasPrefix(mt, "image/") {
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
}

// serveCachedPage 下发转码结果：内容寻址 → 可永久缓存 + 支持条件请求。
// （见上）
// 返回 false 表示缓存文件此刻不可用（已被淘汰/权限问题），调用方应回落原样直出 ——
// 绝不因为缓存层的问题让用户看不到页面。
func serveCachedPage(w http.ResponseWriter, r *http.Request, path, key string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	/* 审查指出：该端点受会话鉴权保护，用 public 会让中间缓存/前置反代把内容重放给未登录者
	   （且未带 Vary: Cookie）。改 private 后浏览器端缓存收益完全不变。 */
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+key+`"`)
	if ifNoneMatchSatisfied(r.Header.Get("If-None-Match"), key) {
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
	return true
}

/* ifNoneMatchSatisfied 按 RFC 9110 判定 If-None-Match 是否命中当前表示。
   审查发现：早期实现用 strings.Contains(header, key) 判断，会把
   `"other<key>junk"` 这类无关标签也判成命中并返回 304（客户端因此永远拿到缓存里没有的页面）。
   这里改成解析逗号分隔的实体标签并做**精确**比较（容忍 W/ 弱校验前缀）；`*` 表示任意现有
   表示都命中，对 GET 语义即 304。 */
func ifNoneMatchSatisfied(header, key string) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	want := `"` + key + `"`
	for _, part := range strings.Split(header, ",") {
		tag := strings.TrimSpace(part)
		if tag == "*" {
			return true
		}
		if strings.HasPrefix(tag, "W/") || strings.HasPrefix(tag, "w/") {
			tag = strings.TrimSpace(tag[2:])
		}
		if tag == want {
			return true
		}
	}
	return false
}
