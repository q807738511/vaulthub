package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"time"
)

/* v0.9.82：封面缩略图 —— 远程（DDNS/蜂窝）访问提速。
 *
 * 问题（客户反馈「用 DDNS 反向代理访问非常慢，资源多时操作迟缓」）：
 *   媒体库里的封面 sidecar 往往是刮削到的原始大图（1500×2250、0.5–3 MB）。
 *   海报墙一屏要几十张，原图逐张下发时首屏完全被 WAN 上行拖死；
 *   而且旧实现用 os.ReadFile 把整张图读进内存再写出，并发浏览时内存也被放大。
 *
 * 方案：复用漫画页那套「按需缩略 + 内容寻址磁盘缓存」——
 *   GET /api/media/cover?id=&path=&w=320 → 转码成 320px 宽 JPEG（十几 KB）并按
 *   内容键落盘，之后同键 0 成本命中；304 由 serveCachedPage 里的 ETag 处理。
 *   未带 w 的请求改为 http.ServeContent 流式直出原图（支持 Range/If-Modified-Since），
 *   不再整块驻留内存。
 *
 * 安全与回退：w 超上限、页面缓存被禁用、源图过大、解码失败、转码后反而更大
 *   —— 任何一条不满足都返回 false，由调用方原样直出，保证「永远能读」。
 *   转码走全局并发闸门（acquireTranscode），并设定很短的排队上限：
 *   封面比漫画页更「可牺牲」，排队超时就直出原图，绝不让海报墙卡住。
 */

const coverCacheKeyVersion = "ch1"

const (
	// maxCoverSourceBytes 超过该体积不做缩略（避免并发解码叠加大内存），直接流式直出原图。
	maxCoverSourceBytes = 24 << 20
	// coverMaxWidth 允许的最大缩略宽度，防止任意 w 值把缓存刷满。
	coverMaxWidth = 1280
	coverJPEGQuality = 82
	// coverThumbQueueTimeout 封面转码排队上限：宁可直出原图，也不让请求排队等太久。
	coverThumbQueueTimeout = 3 * time.Second
)

func coverCacheKey(libID, relPath string, size, mtime int64, width int) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s|%s|%d|%d|%d|%s", libID, relPath, size, mtime, width, coverCacheKeyVersion)
	return hex.EncodeToString(h.Sum(nil))
}

// serveCoverThumb 尝试「缩略 + 磁盘缓存」下发；返回 false 表示调用方应原样直出原图。
func (a *App) serveCoverThumb(w http.ResponseWriter, r *http.Request, l Library, relPath, absPath string, fi os.FileInfo, width int) bool {
	if width <= 0 || width > coverMaxWidth {
		return false
	}
	if fi == nil || fi.IsDir() || fi.Size() <= 0 || fi.Size() > maxCoverSourceBytes {
		return false
	}
	pc := a.pageCacheRef()
	if !pc.enabled() {
		return false
	}
	key := coverCacheKey(l.ID, relPath, fi.Size(), fi.ModTime().Unix(), width)
	if file, ok := pc.get(key); ok {
		/* 头必须在写响应体之前设置（http.ServeContent 一写体即落头）。 */
		w.Header().Set("X-Vaulthub-Cover-Cache", "hit")
		if serveCachedPage(w, r, file, key) {
			return true
		}
		w.Header().Del("X-Vaulthub-Cover-Cache")
	}
	ctx, cancel := context.WithTimeout(r.Context(), coverThumbQueueTimeout)
	defer cancel()
	release, allowed := a.acquireTranscode(ctx)
	if !allowed {
		return false
	}
	defer release()
	raw, err := os.ReadFile(absPath)
	if err != nil {
		return false
	}
	out, ok := transcodePageImage(raw, width, coverJPEGQuality)
	if !ok {
		return false
	}
	file, cached := pc.put(key, out, "jpg")
	if !cached {
		return false
	}
	w.Header().Set("X-Vaulthub-Cover-Cache", "miss")
	if serveCachedPage(w, r, file, key) {
		return true
	}
	w.Header().Del("X-Vaulthub-Cover-Cache")
	return false
}

// serveCoverOriginal 流式直出原图：嗅探魔数回 Content-Type，其余交给 http.ServeContent
// （Range / If-Modified-Since / Content-Length 全部由标准库处理）。
func serveCoverOriginal(w http.ResponseWriter, r *http.Request, absPath string) bool {
	f, err := os.Open(absPath)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		return false
	}
	head := make([]byte, 16)
	n, _ := f.Read(head)
	ext := sniffImageExt(head[:n])
	if ext == "" {
		return false
	}
	/* 缓存策略与旧实现一致：公开长缓存，URL 带 &v= 版本号做失效。 */
	w.Header().Set("Content-Type", imageContentType(ext))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, err := f.Seek(0, 0); err != nil {
		return false
	}
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
	return true
}
