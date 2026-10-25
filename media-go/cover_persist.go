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
	"strconv"
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

/* v0.9.89：图片本地化扩展到海报以外的角色。
   v0.9.56 只落 <名>.cover.jpg，而服务端本地元数据读取端（local_metadata.go）
   认的是 <名>-poster.jpg / <名>-fanart.jpg / <名>-backdrop.jpg / <名>-logo.png。
   两套命名对不上，导致「刮削完图还是远程图床」，换设备/断网就白板。
   现在同一张图按角色落成读取端认识的 sidecar：下次读本地元数据直接带回本地 URL，
   前端拿到即是本地图，也不再需要重新下载。 */
var coverRoleSidecar = map[string]string{
	"poster":   "poster",
	"fanart":   "fanart",
	"backdrop": "backdrop",
	"logo":     "logo",
}

/* v0.9.92：封面/海报 sidecar 的文件名判定。
   客户反馈「电子书栏目里 .cover 文件出现在目录列表中」——
   cover_persist 写入的 <名>.cover.jpg 与 v0.9.89 的 <名>-poster.jpg 等图片 sidecar
   在扫描端没有被排除（旧注释假设「不在任何媒体库扫描格式内」，但漫画/电子书库
   接受 jpg/png/webp/gif，于是它们以「一页」的身份进了书架）。
   这些文件只应作为封面资源被 /api/media/cover 与 local_metadata 直接读取，
   不该出现在任何列表里。 */
var sidecarImageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true, ".bmp": true, ".avif": true,
}

// isMediaSidecarImage 判定 basename 是否为封面/海报 sidecar：
//   <媒体名>.cover.<图片扩展名>      （v0.9.56 封面落盘）
//   <媒体名>-poster|-fanart|-backdrop|-logo.<图片扩展名>（v0.9.89 角色图落盘）
// 裸 cover.jpg / poster.jpg（媒体库级封面，local_metadata 认可）不算 sidecar。
func isMediaSidecarImage(base string) bool {
	b := strings.ToLower(strings.TrimSpace(base))
	if b == "" {
		return false
	}
	dot := strings.LastIndex(b, ".")
	if dot <= 0 || dot == len(b)-1 {
		return false
	}
	if !sidecarImageExts[b[dot:]] {
		return false
	}
	stem := b[:dot]
	if rest, ok := strings.CutSuffix(stem, ".cover"); ok {
		return rest != ""
	}
	for _, role := range []string{"-poster", "-fanart", "-backdrop", "-logo"} {
		if rest, ok := strings.CutSuffix(stem, role); ok {
			return rest != ""
		}
	}
	return false
}

// coverSidecarRelRole 由媒体相对路径 + 角色派生 sidecar 相对路径。
// role 为空或 "cover" → 沿用 v0.9.56 的 <名>.cover.<ext>（前端 /api/media/cover 直读）；
// poster/fanart/backdrop/logo → <名>-<role>.<ext>（服务端本地元数据读取端认得）。
func coverSidecarRelRole(mediaRel, role, ext string) string {
	name := filepath.Base(mediaRel)
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	if stem == "" {
		stem = name
	}
	tag, ok := coverRoleSidecar[role]
	if !ok || role == "" {
		tag = "cover"
	}
	side := stem + "-" + tag + "." + ext
	if tag == "cover" {
		side = stem + ".cover." + ext
	}
	dir := filepath.Dir(mediaRel)
	if dir == "." || dir == "" {
		return side
	}
	return filepath.ToSlash(filepath.Join(dir, side))
}

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

/* coverTargetGuard 是可替换的包级校验（v1.0.3 审查 S-1）。
   生产恒为 ensurePublicTarget；单测里用本地 httptest 当封面源时临时替换，
   生产代码路径不允许替换成「放行」。 */
var coverTargetGuard = ensurePublicTarget

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
		Role string `json:"role"` // v0.9.89: cover(默认) / poster / fanart / backdrop / logo
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
	/* v1.0.3（审查 S-1）：先确认目标是公网地址，再下载 —— 配了代理时
	   safeTransport 的 DialContext 校验不生效（它连的是代理），必须在这里挡。 */
	if err := coverTargetGuard(r.Context(), u); err != nil {
		errJSON(w, 400, "cover url rejected: "+err.Error())
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
	/* v1.0.9：图片站对非浏览器 UA 直接 418/403（实测豆瓣图床），改用共享的浏览器 UA。 */
	req.Header.Set("User-Agent", artworkUserAgent)
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
	if body.Role != "" && body.Role != "cover" {
		if _, ok := coverRoleSidecar[body.Role]; !ok {
			errJSON(w, 400, "invalid artwork role")
			return
		}
	}
	relOut := coverSidecarRelRole(body.Path, body.Role, ext)
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
	role := body.Role
	if role == "" {
		role = "cover"
	}
	writeJSON(w, 200, map[string]any{"ok": true, "path": relOut, "ext": ext, "url": coverURL, "role": role, "localized": true})
}

func (a *App) coverGet(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	l, ok := a.find(q.Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	rel := q.Get("path")
	p, fi, err := safeFile(l, rel)
	if err != nil || fi == nil || fi.IsDir() {
		errJSON(w, 404, "cover not found")
		return
	}
	/* v0.9.82：海报墙按展示尺寸取缩略图（w=320 等），远程访问时把单张封面从 MB 级
	   降到十几 KB（命中磁盘缓存后 0 成本）；w 缺失或不可转码时流式直出原图。
	   注意顺序：先试缩略，失败必须回落原图 —— 封面永远可读。 */
	if width, _ := strconv.Atoi(q.Get("w")); width > 0 {
		if a.serveCoverThumb(w, r, l, rel, p, fi, width) {
			return
		}
	}
	if !serveCoverOriginal(w, r, p) {
		errJSON(w, 404, "cover not found")
		return
	}
}
