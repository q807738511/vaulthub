package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

/* v0.9.56：封面刮削持久化 —— 把刮削到的封面以「媒体文件同名 sidecar」写入媒体库
   所在目录（如 One Piece v01.cbz → One Piece v01.cover.jpg），展示端始终读本地文件，
   不再依赖第三方图床热链，换浏览器/清缓存后封面依然在。

   - POST /api/media/cover {id, path, url}：需要登录会话（writeAuth）。服务端下载
     图片（≤20MB，仅接受 jpeg/png/webp/gif），嗅探魔数后原子写入
     <媒体文件所在目录>/<文件名去扩展名>.cover.<ext>。响应带可直接展示的同源 url。
   - GET  /api/media/cover?id=&path=：公开读取 sidecar（path 为相对库根路径），
     按魔数回 Content-Type 并长缓存（url 带 &v= 版本号做缓存失效）。
   写入方向与媒体路径同界：只允许写在 safeFile 已校验过的媒体文件同目录，
   杜绝路径穿越；sidecar 扩展名 .cover.jpg 等不在任何媒体库扫描格式内，不会被入库。 */

const coverDownloadMaxBytes = 20 << 20 // 20 MiB

// sniffImageExt 识别图片魔数；非图片返回空串。
func sniffImageExt(head []byte) string {
	if len(head) < 3 {
		return ""
	}
	if bytes.HasPrefix(head, []byte{0xFF, 0xD8, 0xFF}) {
		return "jpg"
	}
	if len(head) >= 8 && bytes.HasPrefix(head, []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}) {
		return "png"
	}
	if len(head) >= 6 && (bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a"))) {
		return "gif"
	}
	if len(head) >= 12 && bytes.HasPrefix(head, []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WEBP")) {
		return "webp"
	}
	return ""
}

func imageContentType(ext string) string {
	switch ext {
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	default:
		return "image/jpeg"
	}
}

// coverSidecarRel 由媒体文件相对路径派生 sidecar 相对路径：
// dir/名.cover.<ext>（同一目录可容纳同名多格式媒体的各自封面）。
func coverSidecarRel(mediaRel, ext string) string {
	dir := filepath.Dir(mediaRel)
	name := filepath.Base(mediaRel)
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	if stem == "" {
		stem = name
	}
	side := stem + ".cover." + ext
	if dir == "." || dir == "" {
		return side
	}
	return filepath.ToSlash(filepath.Join(dir, side))
}

func (a *App) coverDownloadClient() (*http.Client, error) {
	a.mu.RLock()
	proxy := a.scraperProxy
	a.mu.RUnlock()
	tr, err := safeTransport(proxy)
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: tr, Timeout: 25 * time.Second}, nil
}

func (a *App) coverSave(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		a.coverGet(w, r)
		return
	}
	if r.Method != "POST" {
		errJSON(w, 405, "method not allowed")
		return
	}
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	var body struct {
		ID   string `json:"id"`
		Path string `json:"path"`
		URL  string `json:"url"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body) != nil {
		errJSON(w, 400, "invalid json")
		return
	}
	l, ok := a.find(body.ID)
	if !ok || !validID(body.ID) {
		errJSON(w, 400, "invalid id")
		return
	}
	mediaFull, _, err := safeFile(l, body.Path)
	if err != nil {
		errJSON(w, 404, "media file not found")
		return
	}
	u, err := url.Parse(strings.TrimSpace(body.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || len(body.URL) > 4096 {
		errJSON(w, 400, "invalid cover url")
		return
	}
	client, err := a.coverDownloadClient()
	if err != nil {
		errJSON(w, 500, "proxy config invalid")
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		errJSON(w, 400, "invalid cover url")
		return
	}
	req.Header.Set("User-Agent", "VaultHub/0.9.56 cover-scraper (https://github.com/q807738511/vaulthub)")
	res, err := client.Do(req)
	if err != nil {
		errJSON(w, 502, "cover download failed: "+err.Error())
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		errJSON(w, 502, fmt.Sprintf("cover source returned HTTP %d", res.StatusCode))
		return
	}
	limited := io.LimitReader(res.Body, coverDownloadMaxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		errJSON(w, 502, "cover download failed")
		return
	}
	if len(data) > coverDownloadMaxBytes {
		errJSON(w, 400, "cover image exceeds 20 MiB")
		return
	}
	ext := sniffImageExt(data)
	if ext == "" {
		errJSON(w, 415, "cover is not jpeg/png/webp/gif")
		return
	}
	relOut := coverSidecarRel(body.Path, ext)
	dest := filepath.Join(filepath.Dir(mediaFull), filepath.Base(relOut))
	// 只允许写在已通过安全校验的媒体文件同一目录内（safeFile 已做 symlink 边界检查）。
	if filepath.Dir(dest) != filepath.Dir(mediaFull) {
		errJSON(w, 400, "invalid cover path")
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(mediaFull), ".vault-cover-*.tmp")
	if err != nil {
		errJSON(w, 500, "cannot write cover file")
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err = tmp.Chmod(0644); err == nil {
		_, err = tmp.Write(data)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		errJSON(w, 500, "cannot write cover file")
		return
	}
	if err = os.Rename(tmpName, dest); err != nil {
		errJSON(w, 500, "cannot write cover file")
		return
	}
	st, _ := os.Stat(dest)
	version := st.ModTime().Unix()
	coverURL := "/api/media/cover?id=" + url.QueryEscape(l.ID) + "&path=" + url.QueryEscape(relOut) + "&v=" + fmt.Sprintf("%d", version)
	writeJSON(w, 200, map[string]any{"ok": true, "path": relOut, "ext": ext, "url": coverURL})
}

func (a *App) coverGet(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	l, ok := a.find(q.Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	p, _, err := safeFile(l, q.Get("path"))
	if err != nil {
		errJSON(w, 404, "cover not found")
		return
	}
	data, err := os.ReadFile(p)
	if err != nil {
		errJSON(w, 404, "cover not found")
		return
	}
	ext := sniffImageExt(data)
	if ext == "" {
		errJSON(w, 404, "cover not found")
		return
	}
	w.Header().Set("Content-Type", imageContentType(ext))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
