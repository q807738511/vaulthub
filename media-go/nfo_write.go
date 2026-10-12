package main

import (
	"bytes"
	"encoding/json"
	"net/url"
	"encoding/xml"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

/* v0.9.89：NFO 元数据本地化写入。
 *
 * 读取端早就有了（local_metadata.go：movie.nfo / tvshow.nfo / <文件名>.nfo →
 * provider「本地 NFO」），缺的是把刮削结果**写回去**。补齐之后形成闭环：
 *
 *   刮削成功 → 写 NFO（+ 图片本地化） → 下次进库 / 换设备 / 重扫
 *   → /api/media/metadata 直接读到本地 NFO → 不再联网刮削
 *
 * NFO 是 Kodi / Emby / Jellyfin / Plex(XBMCnfo) 通用格式，写在媒体文件旁边，
 * 用户自己的媒体服务器也能直接读；文件名与读取端候选完全一致，保证写进去下次一定读得到。
 *
 * 安全：
 *   - 需要登录会话（writeAuth）；
 *   - 目标目录必须落在该媒体库的合法根内（复用 safeFile 的边界校验，防路径穿越）；
 *   - 只允许写 .nfo，文件名白名单 ^[A-Za-z0-9._\-\u4e00-\u9fa5 ]+\.nfo$，不允许分隔符；
 *   - 已存在但不是 VaultHub 写的 NFO（用户手写 / 其他工具的）→ 默认保留不覆盖；
 *   - 临时文件 + rename 原子写，0644，单文件上限 512 KB。
 */

const nfoWriteMaxBytes = 512 << 10

// nfoMarker 用于识别「这个 NFO 是 VaultHub 写的」，避免覆盖用户手写的 NFO。
const nfoMarker = "VaultHub"

var nfoNameRe = regexp.MustCompile(`^[A-Za-z0-9._\-\x{4e00}-\x{9fa5} ]+\.nfo$`)

type nfoWriteMeta struct {
	/* v0.9.98：写 NFO 时的 TMDB 图片基址（把头像代理 URL 还原成可被其它刮削器
	   直接使用的原图地址）。前端不传则用官方基址。 */
	ImageBase     string              `json:"image_base"`
	Title         string              `json:"title"`
	OriginalTitle string              `json:"original_title"`
	ShowTitle     string              `json:"show_title"`
	Year          string              `json:"year"`
	Premiered     string              `json:"premiered"`
	Overview      string              `json:"overview"`
	Outline       string              `json:"outline"`
	Runtime       int                 `json:"runtime"`
	Rating        float64             `json:"rating"`
	Genres        []string            `json:"genres"`
	Cast          []localMetadataCast `json:"cast"`
	TMDBID        string              `json:"tmdb_id"`
	TVDBID        string              `json:"tvdb_id"`
	Poster        string              `json:"poster"`
	Fanart        string              `json:"fanart"`
	Backdrop      string              `json:"backdrop"`
	Logo          string              `json:"logo"`
}

type nfoExtraTarget struct {
	Name string `json:"name"` // movie.nfo / tvshow.nfo / album.nfo / artist.nfo
	Up   int    `json:"up"`   // 0 = 媒体文件所在目录；1 = 上一层（剧集根 / 专辑根）
}

type nfoWriteRequest struct {
	ID        string           `json:"id"`
	Path      string           `json:"path"`
	Extras    []nfoExtraTarget `json:"extras"`
	Overwrite bool             `json:"overwrite"`
	Meta      nfoWriteMeta     `json:"meta"`
}

type nfoWriteDoc struct {
	XMLName       xml.Name      `xml:"movie"`
	Title         string        `xml:"title,omitempty"`
	OriginalTitle string        `xml:"originaltitle,omitempty"`
	ShowTitle     string        `xml:"showtitle,omitempty"`
	Year          string        `xml:"year,omitempty"`
	Premiered     string        `xml:"premiered,omitempty"`
	Plot          string        `xml:"plot,omitempty"`
	Outline       string        `xml:"outline,omitempty"`
	Runtime       string        `xml:"runtime,omitempty"`
	Rating        string        `xml:"rating,omitempty"`
	Genres        []string      `xml:"genre"`
	Actors        []nfoActor    `xml:"actor"`
	UniqueIDs     []nfoUniqueID `xml:"uniqueid"`
	Thumbs        []nfoThumb    `xml:"thumb"`
	FanartThumbs  []string      `xml:"fanart>thumb"`
	WrittenBy     string        `xml:"writtenby,omitempty"`
}

func nfoClip(v string, max int) string {
	v = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, v))
	if len(v) > max {
		v = strings.TrimSpace(v[:max])
	}
	return v
}

// nfoResolveTarget 把「媒体相对路径 + 目标文件名 + 上溯层数」解析成库内合法绝对路径。
//
// 注意：NFO 目标文件**尚不存在**，因此不能直接对目标用 safeFile（它会 Stat）。
// 正确做法是先解析媒体文件（存在）→ 取目录 → 上溯 → 校验该目录仍在该库某个
// 合法根内（EvalSymlinks 后的边界比较）→ 再用 indexRelFor 得到索引相对路径。
func nfoResolveTarget(lib Library, mediaPath, name string, up int) (string, string, error) {
	if !nfoNameRe.MatchString(name) {
		return "", "", fmt.Errorf("invalid nfo name")
	}
	if up < 0 || up > 2 {
		return "", "", fmt.Errorf("invalid nfo scope")
	}
	abs, _, err := safeFile(lib, mediaPath)
	if err != nil {
		return "", "", fmt.Errorf("invalid media path")
	}
	dir := filepath.Dir(abs)
	for i := 0; i < up; i++ {
		dir = filepath.Dir(dir)
	}
	if !dirInsideLibrary(lib, dir) {
		return "", "", fmt.Errorf("nfo target outside library")
	}
	relDir := indexRelFor(lib, dir)
	target := filepath.Join(dir, name)
	rel := name
	if relDir != "" {
		rel = filepath.ToSlash(filepath.Join(relDir, name))
	}
	if strings.Contains(rel, "..") || strings.HasPrefix(rel, "/") {
		return "", "", fmt.Errorf("nfo target outside library")
	}
	return target, rel, nil
}

// dirInsideLibrary 判断（已存在的）目录是否落在该库某个合法根内。
func dirInsideLibrary(lib Library, dir string) bool {
	for _, root := range lib.AllPaths() {
		rootReal, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(rootReal, dir)
		if err != nil || filepath.IsAbs(rel) {
			continue
		}
		if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))) {
			return true
		}
	}
	return false
}

// nfoDirMediaCount 统计目录里的媒体文件数（含原盘镜像）。
//
// 用途：movie.nfo 是 Kodi/Emby 的「这个目录里的电影」约定名，而本地元数据读取端在
// 「目录里只有一个媒体文件」时会把 movie.nfo 应用到该目录所有文件。若在扁平库
// （多部片子共用一个目录）里写 movie.nfo，就会把一部片的信息串到同目录其它文件上
// （v0.9.89 实测：写完后同目录的 ISO 也被读成「本地 NFO + 同一部片」）。
// 因此只有在目录里确实只有一个媒体文件时才写 movie.nfo；否则只写 <文件名>.nfo。
func nfoDirMediaCount(dir string) int {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return -1
	}
	n := 0
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		switch strings.ToLower(filepath.Ext(e.Name())) {
		case ".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".ts", ".m2ts", ".iso",
			".mpg", ".mpeg", ".wmv", ".flv", ".rmvb", ".rm", ".vob", ".evob", ".disc":
			n++
		}
	}
	return n
}

/* nfoActorThumb：写 NFO 时的演员头像地址（v0.9.98）。
   优先用本地 NFO 里读到的原样 thumb；其次把 VaultHub 的 TMDB 头像代理 URL 还原成
   原图地址（w500，其它刮削器/播放器可直接用）；再次是任何 http(s) 地址；都没有则留空。 */
func nfoActorThumb(a localMetadataCast, imageBase string) string {
	if t := nfoClip(a.AvatarThumb, 512); t != "" {
		return t
	}
	av := strings.TrimSpace(a.Avatar)
	if strings.HasPrefix(av, "/api/media/cast/avatar?person=") {
		raw := strings.TrimPrefix(av, "/api/media/cast/avatar?person=")
		if p, err := url.QueryUnescape(raw); err == nil && strings.HasPrefix(p, "/") {
			base := strings.TrimRight(strings.TrimSpace(imageBase), "/")
			if base == "" {
				base = "https://image.tmdb.org/t/p"
			}
			return base + "/w500" + p
		}
	}
	if strings.HasPrefix(av, "http://") || strings.HasPrefix(av, "https://") {
		return nfoClip(av, 512)
	}
	return ""
}

func nfoBuildDoc(m nfoWriteMeta) nfoWriteDoc {
	doc := nfoWriteDoc{
		Title:         nfoClip(m.Title, 300),
		OriginalTitle: nfoClip(m.OriginalTitle, 300),
		ShowTitle:     nfoClip(m.ShowTitle, 300),
		Year:          nfoClip(m.Year, 8),
		Premiered:     nfoClip(m.Premiered, 32),
		Plot:          nfoClip(m.Overview, 8000),
		Outline:       nfoClip(m.Outline, 2000),
		WrittenBy:     nfoMarker,
	}
	if doc.Year == "" && len(doc.Premiered) >= 4 {
		doc.Year = doc.Premiered[:4]
	}
	if m.Runtime > 0 {
		doc.Runtime = strconv.Itoa(m.Runtime)
	}
	if m.Rating > 0 {
		doc.Rating = strconv.FormatFloat(m.Rating, 'f', 1, 64)
	}
	for _, g := range m.Genres {
		if g = nfoClip(g, 64); g != "" {
			doc.Genres = append(doc.Genres, g)
		}
		if len(doc.Genres) >= 20 {
			break
		}
	}
	for _, a := range m.Cast {
		name := nfoClip(a.Name, 120)
		if name == "" {
			continue
		}
		doc.Actors = append(doc.Actors, nfoActor{Name: name, Role: nfoClip(a.Character, 120), Thumb: nfoActorThumb(a, m.ImageBase)})
		if len(doc.Actors) >= 60 {
			break
		}
	}
	if id := nfoClip(m.TMDBID, 32); id != "" {
		doc.UniqueIDs = append(doc.UniqueIDs, nfoUniqueID{Type: "tmdb", Value: id})
	}
	if id := nfoClip(m.TVDBID, 32); id != "" {
		doc.UniqueIDs = append(doc.UniqueIDs, nfoUniqueID{Type: "tvdb", Value: id})
	}
	for _, art := range []struct{ aspect, val string }{{"poster", m.Poster}, {"fanart", m.Fanart}, {"backdrop", m.Backdrop}, {"clearlogo", m.Logo}} {
		if v := nfoClip(art.val, 500); v != "" {
			doc.Thumbs = append(doc.Thumbs, nfoThumb{Aspect: art.aspect, Value: v})
		}
	}
	return doc
}

// writeNFOFile 原子写入一个 NFO；已存在且不是 VaultHub 写的，默认保留。
func writeNFOFile(path string, doc nfoWriteDoc, overwrite bool) (written bool, kept bool, err error) {
	if info, e := os.Stat(path); e == nil {
		if info.IsDir() {
			return false, false, fmt.Errorf("nfo target is a directory")
		}
		if !overwrite {
			if b, rerr := os.ReadFile(path); rerr == nil && !strings.Contains(string(b), nfoMarker) {
				return false, true, nil // 用户手写 / 别的工具写过的 NFO：不动它
			}
		}
	}
	body, err := xml.MarshalIndent(doc, "", "  ")
	if err != nil {
		return false, false, err
	}
	// 没有 fanart 时 encoding/xml 会留下空元素 <fanart></fanart>，清掉让文件干净。
	body = bytes.ReplaceAll(body, []byte("  <fanart></fanart>\n"), nil)
	buf := append([]byte("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<!-- written by "+nfoMarker+" -->\n"), body...)
	buf = append(buf, '\n')
	if len(buf) > nfoWriteMaxBytes {
		return false, false, fmt.Errorf("nfo too large")
	}
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".vaulthub-nfo-*.tmp")
	if err != nil {
		return false, false, err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(buf); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return false, false, err
	}
	if err = os.Chmod(tmp, 0644); err != nil {
		return false, false, err
	}
	if err = os.Rename(tmp, path); err != nil {
		return false, false, err
	}
	return true, false, nil
}

// nfoPortableArtURL 把图片地址规范成 NFO 里可移植的形式。
//
// 本站 sidecar 图（/api/media/cover?path=... 这类带查询串的地址）外部媒体服务器
// （Emby / Jellyfin / Kodi）无法解析，写进去等于没写；而与 NFO 同目录的 sidecar
// 只需写文件名，播放器会自动找到。其它主机（http/https）保留原地址，站内其它位置
// 的图则留空（宁可不写，也不写一个别人读不了的地址）。
func nfoPortableArtURL(raw, mediaPath string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "/api/media/cover?") || strings.HasPrefix(raw, "/api/media/file?") {
		u, err := url.Parse(raw)
		if err != nil {
			return ""
		}
		p := filepath.ToSlash(u.Query().Get("path"))
		if p == "" {
			return ""
		}
		if filepath.ToSlash(filepath.Dir(p)) == filepath.ToSlash(filepath.Dir(mediaPath)) {
			return filepath.Base(p)
		}
		return ""
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw
	}
	return ""
}

func (a *App) nfoWrite(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	var body nfoWriteRequest
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body) != nil {
		errJSON(w, 400, "invalid nfo payload")
		return
	}
	lib, ok := a.find(body.ID)
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	if strings.TrimSpace(body.Path) == "" {
		errJSON(w, 400, "missing media path")
		return
	}
	if strings.TrimSpace(body.Meta.Title) == "" {
		errJSON(w, 400, "missing nfo title")
		return
	}
	// v0.9.89：图片地址规范化（同目录 sidecar → 文件名，外部服务器才认得）。
	body.Meta.Poster = nfoPortableArtURL(body.Meta.Poster, body.Path)
	body.Meta.Fanart = nfoPortableArtURL(body.Meta.Fanart, body.Path)
	body.Meta.Backdrop = nfoPortableArtURL(body.Meta.Backdrop, body.Path)
	body.Meta.Logo = nfoPortableArtURL(body.Meta.Logo, body.Path)
	doc := nfoBuildDoc(body.Meta)

	abs, _, err := safeFile(lib, body.Path)
	if err != nil {
		errJSON(w, 400, "invalid media path")
		return
	}
	stem := filepath.Base(abs)
	stem = strings.TrimSuffix(stem, filepath.Ext(stem))
	if stem == "" {
		stem = "movie"
	}

	type target struct {
		Abs  string
		Name string
	}
	targets := []target{}
	mainAbs, mainRel, err := nfoResolveTarget(lib, body.Path, stem+".nfo", 0)
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	targets = append(targets, target{Abs: mainAbs, Name: mainRel})
	skippedExtras := []string{}
	for _, ex := range body.Extras {
		name := strings.TrimSpace(ex.Name)
		if name == "" {
			continue
		}
		exAbs, exRel, err := nfoResolveTarget(lib, body.Path, name, ex.Up)
		if err != nil {
			errJSON(w, 400, err.Error())
			return
		}
		if exAbs == mainAbs {
			continue
		}
		/* movie.nfo 只在「该目录只有一个媒体文件」时才写 —— 否则会把这部片的信息
		   串到同目录其它片子/镜像上（读取端在单文件目录下会让 movie.nfo 对该目录
		   所有文件生效）。扁平库因此只写 <文件名>.nfo，安全且同样能被读回。 */
		if strings.EqualFold(name, "movie.nfo") && ex.Up == 0 {
			if n := nfoDirMediaCount(filepath.Dir(exAbs)); n != 1 {
				skippedExtras = append(skippedExtras, exRel)
				continue
			}
		}
		targets = append(targets, target{Abs: exAbs, Name: exRel})
	}

	written := []string{}
	kept := []string{}
	for _, t := range targets {
		wrote, keep, err := writeNFOFile(t.Abs, doc, body.Overwrite)
		if err != nil {
			errJSON(w, 500, "nfo write failed: "+err.Error())
			return
		}
		switch {
		case wrote:
			written = append(written, t.Name)
		case keep:
			kept = append(kept, t.Name)
		}
	}
	first := ""
	if len(written) > 0 {
		first = written[0]
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "id": body.ID, "path": body.Path,
		"nfo": first, "written": written, "kept": kept, "skipped": skippedExtras,
		"written_at": time.Now().UnixMilli(),
	})
}

// nfoRead 回读：确认写进去的 NFO 真的能被本地元数据读取端解析（v0.9.89 闭环验证用）。
func (a *App) nfoRead(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, http.StatusUnauthorized, "login required")
		return
	}
	lib, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	path := r.URL.Query().Get("path")
	if strings.TrimSpace(path) == "" {
		errJSON(w, 400, "missing media path")
		return
	}
	m, err := readLocalMediaMetadata(lib, path)
	if err != nil {
		errJSON(w, 400, "invalid media path")
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "id": lib.ID, "path": path, "nfo": m.NFO,
		"provider": m.Provider, "title": m.Title, "year": m.Year,
		"overview": m.Overview, "rating": m.Rating, "genres": m.Genres,
		"cast": m.Cast, "tmdb_id": m.TMDBID, "tvdb_id": m.TVDBID,
		"poster": m.Poster, "fanart": m.Fanart, "backdrop": m.Backdrop, "logo": m.Logo,
		"has_nfo": m.NFO != "",
	})
}

func (a *App) nfoHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		a.nfoWrite(w, r)
	case http.MethodGet:
		a.nfoRead(w, r)
	default:
		errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
