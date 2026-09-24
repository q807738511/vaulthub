package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* ==================== v0.9.77：PDF 漫画/文档服务端翻页 ====================
   问题：漫画库里的 .pdf 由前端 <iframe src="..."> 交给浏览器内置 PDF 阅读器，
   客户反馈「还是用的浏览器自带播放器」，与漫画阅读器的单页/双页/条漫、右起/左起、
   省流转码、预取、页码进度完全脱节。

   做法：复用已有的「页缓存 + 页转码闸门」流水线，把 PDF 页在服务端光栅化成 JPEG：
     · /api/media/pdf/info  —— 页数 + 是否加密（pdfinfo，poppler）
     · /api/media/pdf/page  —— 第 N 页 → JPEG（pdftoppm，poppler），落 pageCache 复用
     · 首页封面走同一套（page=1 + 小宽度），书架用 /api/media/pdf/cover

   安全与可靠性约束（本版审查项）：
     · 只接受库内相对路径（safeFile），扩展名必须是 .pdf；
     · page 必须落在 [1, 页数]，宽度/质量走 pageParams 白名单；
     · pdftoppm 以只读方式运行、无 shell、超时 45s、并发走 acquireTranscode 闸门；
     · 输出统一 JPEG；失败返回结构化错误，绝不回退成浏览器内置查看器。 */

const (
	pdfRenderTimeout = 45 * time.Second
	pdfMaxPages      = 20000
	pdfInfoTimeout   = 15 * time.Second
)

var errPDFToolsMissing = errors.New("pdftoppm not available")

const (
	/* pdfDefaultPageWidth 未显式给宽度时的默认目标宽度（避免整页原图直出）。 */
	pdfDefaultPageWidth = 1600
	pdfCountTTL         = 10 * time.Minute
)

type pdfCountEntry struct {
	pages int
	size  int64
	mod   int64
	at    time.Time
}

var (
	pdfCountMu    sync.Mutex
	pdfCountCache = map[string]pdfCountEntry{}
)

/* pdfCountCached 按「路径 + size + mtime」缓存页数，避免每页请求都跑一次 pdfinfo。 */
func (a *App) pdfCountCached(ctx context.Context, file string, st os.FileInfo) (int, bool, error) {
	pdfCountMu.Lock()
	entry, ok := pdfCountCache[file]
	pdfCountMu.Unlock()
	if ok && entry.size == st.Size() && entry.mod == st.ModTime().Unix() && time.Since(entry.at) < pdfCountTTL {
		return entry.pages, false, nil
	}
	pages, encrypted, err := pdfPageCount(ctx, file)
	if err != nil {
		return 0, encrypted, err
	}
	pdfCountMu.Lock()
	/* 上限保护：进程长跑时表不会无限增长。 */
	if len(pdfCountCache) > 4096 {
		pdfCountCache = map[string]pdfCountEntry{}
	}
	pdfCountCache[file] = pdfCountEntry{pages: pages, size: st.Size(), mod: st.ModTime().Unix(), at: time.Now()}
	pdfCountMu.Unlock()
	return pages, encrypted, nil
}

// pdfToolPath 解析 poppler 二进制；测试可通过 pdfToolOverride 注入桩程序。
var (
	pdfToolMu          sync.RWMutex
	pdfToolOverride    = "" // 测试用：覆盖 pdftoppm 路径
	pdfInfoOverride    = "" // 测试用：覆盖 pdfinfo 路径
	popplerMissingOnce sync.Once
	popplerMissing     bool
)

func pdfTool(kind string) (string, error) {
	pdfToolMu.RLock()
	override := pdfToolOverride
	if kind == "info" {
		override = pdfInfoOverride
	}
	pdfToolMu.RUnlock()
	if override != "" {
		return override, nil
	}
	name := "pdftoppm"
	if kind == "info" {
		name = "pdfinfo"
	}
	p, err := exec.LookPath(name)
	if err != nil {
		popplerMissingOnce.Do(func() { popplerMissing = true })
		return "", errPDFToolsMissing
	}
	return p, nil
}

// pdfSafePath 校验请求指向库内一个真实存在的 .pdf 文件。
func (a *App) pdfSafePath(r *http.Request) (Library, string, error) {
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		return l, "", os.ErrNotExist
	}
	p, _, err := safeFile(l, r.URL.Query().Get("path"))
	if err != nil {
		return l, "", err
	}
	if !strings.EqualFold(filepath.Ext(p), ".pdf") {
		return l, "", fmt.Errorf("not a pdf")
	}
	return l, p, nil
}

/* pdfPageCount 读页数。pdfinfo 输出「Pages:         123」。 */
func pdfPageCount(ctx context.Context, file string) (int, bool, error) {
	bin, err := pdfTool("info")
	if err != nil {
		return 0, false, err
	}
	ctx, cancel := context.WithTimeout(ctx, pdfInfoTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, file).Output()
	if err != nil {
		return 0, false, fmt.Errorf("pdfinfo failed")
	}
	pages, encrypted := 0, false
	for _, line := range strings.Split(string(out), "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "pages":
			pages, _ = strconv.Atoi(strings.TrimSpace(value))
		case "encrypted":
			encrypted = strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), "yes")
		}
	}
	if pages <= 0 || pages > pdfMaxPages {
		return 0, encrypted, fmt.Errorf("pdf page count unavailable")
	}
	return pages, encrypted, nil
}

/*
renderPDFPage 把第 page 页渲染成 PNG 字节（pdftoppm -f/-l 单页、-r 分辨率）。

	-r 由目标宽度反推：宽 ≤ 320 用 72dpi（书架缩略图），否则 150dpi（阅读清晰度）。
*/
func renderPDFPage(ctx context.Context, file string, page, width int) ([]byte, error) {
	bin, err := pdfTool("page")
	if err != nil {
		return nil, err
	}
	dpi := "150"
	if width > 0 && width <= 320 {
		dpi = "72"
	}
	ctx, cancel := context.WithTimeout(ctx, pdfRenderTimeout)
	defer cancel()
	dir, err := os.MkdirTemp("", "vh-pdf-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	prefix := filepath.Join(dir, "page")
	cmd := exec.CommandContext(ctx, bin, "-png", "-r", dpi,
		"-f", strconv.Itoa(page), "-l", strconv.Itoa(page), file, prefix)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("pdf render failed: %s", strings.TrimSpace(stderr.String()))
	}
	matches, err := filepath.Glob(prefix + "*.png")
	if err != nil || len(matches) == 0 {
		return nil, fmt.Errorf("pdf render produced no page")
	}
	raw, err := os.ReadFile(matches[0])
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("pdf render empty page")
	}
	return raw, nil
}

/*
pdfPageCacheKey：同一 PDF 同一页、同一宽度/质量 → 同一缓存键。

	键里带 PDF 自身的 size/mtime，文件被替换后不会下发陈旧页面。
*/
func pdfPageCacheKey(libID, file string, page, width, quality int, size, mod int64) string {
	/* 键必须是**不含路径分隔符**的定长串：pageCache.put 用 key[:2] 做分片目录、
	   文件名直接用 key，键里带 / 会写到不存在的多级目录并静默落盘失败
	   （本版实测：渲染成功但 put 返回 false → 页面 500）。与归档页一致用 SHA-1。 */
	h := sha1.New()
	fmt.Fprintf(h, "pdf|%s|%s|%d|%d|%d|%d|%d|%s", libID, filepath.ToSlash(file), page, width, quality, size, mod, pageCacheKeyVersion)
	return hex.EncodeToString(h.Sum(nil))
}

// pdfRenderToCache 渲染 + 转码 + 入缓存；返回缓存文件名。
func (a *App) pdfRenderToCache(ctx context.Context, l Library, file string, page, width, quality int, key string) (string, bool) {
	pc := a.pageCacheRef()
	if !pc.enabled() {
		return "", false
	}
	release, allowed := a.acquireTranscode(ctx)
	if !allowed {
		return "", false
	}
	defer release()
	raw, err := renderPDFPage(ctx, file, page, width)
	if err != nil {
		return "", false
	}
	out, ok := transcodePageImage(raw, width, quality)
	if !ok {
		/* PNG 解码失败（极少见）时直接把渲染结果落盘，别让阅读器拿不到页。 */
		out = raw
	}
	return pc.put(key, out, "jpg")
}

/* pdfInfo：GET /api/media/pdf/info?id=&path= → {pages, encrypted, cached} */
func (a *App) pdfInfo(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	l, file, err := a.pdfSafePath(r)
	if err != nil {
		errJSON(w, 404, "pdf not found")
		return
	}
	if _, err := pdfTool("info"); err != nil {
		errJSON(w, 503, "PDF 渲染组件不可用（容器缺少 poppler-utils）")
		return
	}
	st, statErr := os.Stat(file)
	if statErr != nil {
		errJSON(w, 404, "pdf not found")
		return
	}
	pages, encrypted, err := a.pdfCountCached(r.Context(), file, st)
	if err != nil {
		errJSON(w, 422, err.Error())
		return
	}
	base := r.URL.Query().Get("base")
	if base == "" {
		base = "/api/media/pdf/page?id=" + url.QueryEscape(l.ID) + "&path=" + url.QueryEscape(r.URL.Query().Get("path"))
	}
	writeJSON(w, 200, map[string]any{"pages": pages, "encrypted": encrypted, "page_base": base})
}

/* pdfPage：GET /api/media/pdf/page?id=&path=&page=N&w=&q= → JPEG 页图 */
func (a *App) pdfPage(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	l, file, err := a.pdfSafePath(r)
	if err != nil {
		errJSON(w, 404, "pdf not found")
		return
	}
	page, convErr := strconv.Atoi(r.URL.Query().Get("page"))
	if convErr != nil || page < 1 || page > pdfMaxPages {
		errJSON(w, 400, "invalid page")
		return
	}
	/* 审查项（运行时可靠性/资源）：未给 w 时也必须给一个上限宽度。
	   否则渲染出的整页 PNG 会绕过缩放直接落盘/下发（大页可达数十 MB）。 */
	width, quality, bad := pageParams(r, 0, 4096)
	if bad {
		errJSON(w, 400, "invalid w or q")
		return
	}
	if width <= 0 {
		width = pdfDefaultPageWidth
	}
	if _, err := pdfTool("page"); err != nil {
		errJSON(w, 503, "PDF 渲染组件不可用（容器缺少 poppler-utils）")
		return
	}
	st, statErr := os.Stat(file)
	if statErr != nil {
		errJSON(w, 404, "pdf not found")
		return
	}
	/* 审查项（资源/DDoS）：页码先按真实页数校验，越界直接 404，
	   不会去起一个注定失败的 pdftoppm 进程。页数按 mtime 缓存，重复请求不再跑 pdfinfo。 */
	if pages, _, err := a.pdfCountCached(r.Context(), file, st); err == nil && page > pages {
		errJSON(w, 404, "page out of range")
		return
	}
	key := pdfPageCacheKey(l.ID, file, page, width, quality, st.Size(), st.ModTime().Unix())
	pc := a.pageCacheRef()
	if file, ok := pc.get(key); ok {
		w.Header().Set("X-Vaulthub-Page-Cache", "hit")
		if serveCachedPage(w, r, file, key) {
			return
		}
		w.Header().Del("X-Vaulthub-Page-Cache")
	}
	job, leader := a.beginPageJob(key)
	if !leader {
		select {
		case <-job.done:
		case <-r.Context().Done():
			errJSON(w, 499, "client closed request")
			return
		}
		if job.ok {
			w.Header().Set("X-Vaulthub-Page-Cache", "hit")
			if serveCachedPage(w, r, job.file, key) {
				return
			}
			w.Header().Del("X-Vaulthub-Page-Cache")
		}
		errJSON(w, 500, "pdf page render failed")
		return
	}
	cached := false
	outFile := ""
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				outFile, cached = "", false
			}
			a.endPageJob(key, job, outFile, cached)
		}()
		outFile, cached = a.pdfRenderToCache(r.Context(), l, file, page, width, quality, key)
	}()
	if cached {
		w.Header().Set("X-Vaulthub-Page-Cache", "miss")
		if serveCachedPage(w, r, outFile, key) {
			return
		}
		w.Header().Del("X-Vaulthub-Page-Cache")
	}
	errJSON(w, 500, "pdf page render failed")
}

/* pdfCover：书架封面 = 第 1 页小图（默认宽 320）。 */
func (a *App) pdfCover(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("page") == "" {
		q.Set("page", "1")
	}
	if q.Get("w") == "" {
		q.Set("w", "320")
	}
	r.URL.RawQuery = q.Encode()
	a.pdfPage(w, r)
}

var _ = json.Marshal
