package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Subtitle struct {
	Label    string `json:"label"`
	URL      string `json:"url"`
	Provider string `json:"provider"`
	Language string `json:"language,omitempty"`
	Format   string `json:"format,omitempty"`
	/* v0.9.99：内嵌字幕轨（来自媒体 API，库感知 + 原盘解析）。
	   文本轨给 url（WebVTT 提取），图形轨给 burn_track（服务端烧录）。 */
	Kind      string `json:"kind,omitempty"`
	Text      bool   `json:"text,omitempty"`
	BurnIn    bool   `json:"burn_in,omitempty"`
	BurnTrack *int   `json:"burn_track,omitempty"`
	Index     *int   `json:"index,omitempty"`
}
type Provider interface {
	Name() string
	Search(string, string) ([]Subtitle, error)
}

var client = &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(r *http.Request, v []*http.Request) error {
	if len(v) >= 4 {
		return fmt.Errorf("redirect limit")
	}
	return nil
}}

func esc(s string) string { return url.QueryEscape(s) }
func root() string {
	if x := os.Getenv("MEDIA_ROOT"); x != "" {
		return filepath.Clean(x)
	}
	return "/media"
}
func safeVideo(raw string) (string, error) {
	if raw == "" || filepath.IsAbs(raw) {
		return "", fmt.Errorf("relative video path required")
	}
	r := root()
	p := filepath.Join(r, filepath.Clean(raw))
	rel, e := filepath.Rel(r, p)
	if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path outside media root")
	}
	real, e := filepath.EvalSymlinks(p)
	if e != nil {
		return "", fmt.Errorf("video not found")
	}
	rr, e := filepath.Rel(r, real)
	if e != nil || rr == ".." || strings.HasPrefix(rr, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path outside media root")
	}
	st, e := os.Stat(real)
	if e != nil || !st.Mode().IsRegular() {
		return "", fmt.Errorf("video not found")
	}
	return real, nil
}
func localSearch(video, id string) ([]Subtitle, error) {
	dir, base := filepath.Split(video)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	es, e := os.ReadDir(dir)
	if e != nil {
		return nil, e
	}
	out := []Subtitle{}
	for _, x := range es {
		if x.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(x.Name()))
		if ext != ".srt" && ext != ".vtt" && ext != ".ass" && ext != ".ssa" {
			continue
		}
		n := strings.TrimSuffix(x.Name(), filepath.Ext(x.Name()))
		if !strings.HasPrefix(strings.ToLower(n), strings.ToLower(stem)) {
			continue
		}
		rel, _ := filepath.Rel(root(), filepath.Join(dir, x.Name()))
		out = append(out, Subtitle{Label: "本地 · " + x.Name(), URL: "/api/media/subtitles/proxy?id=" + esc(id) + "&path=" + esc(rel), Provider: "local", Format: strings.TrimPrefix(ext, ".")})
	}
	return out, nil
}

func videoHash(p string) (string, error) {
	f, e := os.Open(p)
	if e != nil {
		return "", e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || st.Size() < 12288 {
		return "", fmt.Errorf("video too small")
	}
	pos := []int64{4096, (st.Size() / 3) * 2, st.Size() / 3, st.Size() - 8192}
	out := make([]string, 0, 4)
	for _, o := range pos {
		if _, e = f.Seek(o, 0); e != nil {
			return "", e
		}
		b := make([]byte, 4096)
		if _, e = io.ReadFull(f, b); e != nil {
			return "", e
		}
		h := md5.Sum(b)
		out = append(out, hex.EncodeToString(h[:]))
	}
	return strings.Join(out, ";"), nil
}
func httpGet(ctx context.Context, u, ref string) ([]byte, string, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", u, nil)
	if e != nil {
		return nil, "", e
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 VaultHub/0.6.22")
	if ref != "" {
		req.Header.Set("Referer", ref)
	}
	r, e := client.Do(req)
	if e != nil {
		return nil, "", e
	}
	defer r.Body.Close()
	if r.StatusCode/100 != 2 {
		return nil, r.Request.URL.String(), fmt.Errorf("HTTP %d", r.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	return b, r.Request.URL.String(), e
}
func internal(provider, link, lang, format string) string {
	return "/api/media/subtitles/download?provider=" + esc(provider) + "&url=" + esc(link) + "&language=" + esc(lang) + "&format=" + esc(format)
}

type shooter struct{ endpoint string }

func (p shooter) Name() string { return "shooter" }
func (p shooter) Search(video, id string) ([]Subtitle, error) {
	if p.endpoint == "" {
		p.endpoint = "https://www.shooter.cn/api/subapi.php"
	}
	h, e := videoHash(video)
	if e != nil {
		return nil, e
	}
	base := filepath.Base(video)
	out := []Subtitle{}
	for _, lang := range []struct{ code, wire string }{{"zh", "Chn"}, {"en", "Eng"}} {
		form := url.Values{"filehash": {h}, "pathinfo": {base}, "format": {"json"}, "lang": {lang.wire}}
		req, e := http.NewRequest("POST", p.endpoint, strings.NewReader(form.Encode()))
		if e != nil {
			return nil, e
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("User-Agent", "Mozilla/5.0 VaultHub/0.6.22")
		ctx, c := context.WithTimeout(context.Background(), 20*time.Second)
		req = req.WithContext(ctx)
		r, e := client.Do(req)
		c()
		if e != nil {
			continue
		}
		var rows []struct {
			Desc  string
			Files []struct{ Link, Ext string }
		}
		e = json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&rows)
		r.Body.Close()
		if e != nil {
			continue
		}
		seen := map[string]bool{}
		for _, row := range rows {
			for _, f := range row.Files {
				ext := strings.ToLower(strings.TrimPrefix(f.Ext, "."))
				if f.Link != "" && (ext == "srt" || ext == "ass") && !seen[ext] {
					seen[ext] = true
					out = append(out, Subtitle{Label: "Shooter · " + lang.code + " · " + ext, URL: internal("shooter", f.Link, lang.code, ext), Provider: "shooter", Language: lang.code, Format: ext})
				}
			}
		}
	}
	return out, nil
}

type webProvider struct{ name, base string }

func (p webProvider) Name() string { return p.name }
func (p webProvider) Search(video, id string) ([]Subtitle, error) {
	if p.base == "" {
		return nil, nil
	}
	q := strings.TrimSuffix(filepath.Base(video), filepath.Ext(video))
	u := strings.TrimRight(p.base, "/") + "/search/" + url.PathEscape(q)
	b, final, e := httpGet(context.Background(), u, "")
	if e != nil {
		return nil, e
	}
	re := regexp.MustCompile(`(?is)<a[^>]+href=["']([^"']+)["'][^>]*?(?:title=["']([^"']*)["'])?[^>]*>(.*?)</a>`)
	out := []Subtitle{}
	seen := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(string(b), -1) {
		link := html.UnescapeString(m[1])
		if !strings.Contains(link, "/") {
			continue
		}
		if !strings.HasPrefix(link, "http") {
			x, _ := url.Parse(final)
			y, _ := url.Parse(link)
			link = x.ResolveReference(y).String()
		}
		label := strings.TrimSpace(regexp.MustCompile(`<[^>]+>`).ReplaceAllString(html.UnescapeString(m[3]), " "))
		if label == "" {
			label = m[2]
		}
		if !seen[link] && link != "" {
			seen[link] = true
			out = append(out, Subtitle{Label: p.name + " · " + label, URL: internal(p.name, link, "", ""), Provider: p.name})
		}
	}
	return out, nil
}

/* v1.0.6（安全）：字幕服务是独立进程，Caddy 把 /api/media/subtitles/search 与
   /download 直接转到它（9120），绕过了媒体 API（9100）的 readAuth —— 实测未登录
   也能搜索（可枚举同目录字幕文件名）并用 /download 代理任意 https 内容。
   这里用同一会话向媒体 API 做一次探针：只有 401 才算「未登录」，其余状态
   （含 400 invalid id / 404）说明会话有效。网络失败按放行处理 —— 媒体 API 挂掉时
   不该把字幕服务一起拖死（旧行为也是放行）。 */
func sessionOK(r *http.Request) bool {
	base := strings.TrimRight(os.Getenv("MEDIA_API"), "/")
	if base == "" {
		base = "http://127.0.0.1:9100"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", base+"/api/media/files?id=__vh_auth_probe__", nil)
	if e != nil {
		return true
	}
	if ck := r.Header.Get("Cookie"); ck != "" {
		req.Header.Set("Cookie", ck)
	}
	req.Header.Set("User-Agent", "VaultHub-Subtitle/1.0.11")
	res, e := client.Do(req)
	if e != nil {
		log.Printf("subtitle: auth probe unavailable (%v) — allowing request", e)
		return true
	}
	res.Body.Close()
	return res.StatusCode != http.StatusUnauthorized
}

func search(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	if !sessionOK(r) {
		http.Error(w, "login required", 401)
		return
	}
	id := r.URL.Query().Get("id")
	rawPath := r.URL.Query().Get("path")
	items := []Subtitle{}
	seen := map[string]bool{}
	add := func(xs []Subtitle) {
		for _, x := range xs {
			key := x.URL
			if key == "" {
				key = "label:" + x.Label
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			items = append(items, x)
		}
	}
	/* v0.9.99：① 内嵌字幕轨 + 库感知的本地字幕文件（媒体 API）。
	   旧实现只有下面那段「单一 MEDIA_ROOT + 同目录同前缀」的扫描，原盘片段路径
	   直接 400「video not found」—— 用户看到的就是「搜索并挂载什么都没有」。 */
	add(embeddedFromMediaAPI(r, id, rawPath))
	providers := []string{"embedded", "local"}
	/* ② 文件能被本服务解析时，再叠加它自己的本地扫描与在线字幕源。 */
	if v, e := safeVideo(rawPath); e == nil {
		ps := []Provider{localProvider{id: id}, shooter{os.Getenv("SUBTITLE_SHOOTER_ENDPOINT")}, webProvider{"zimuku", os.Getenv("SUBTITLE_ZIMUKU_BASE")}, webProvider{"subhd", os.Getenv("SUBTITLE_SUBHD_BASE")}}
		for _, p := range ps {
			xs, e := p.Search(v, id)
			if e != nil {
				log.Printf("subtitle provider=%s error=%v", p.Name(), e)
				continue
			}
			add(xs)
		}
		providers = append(providers, "shooter", "zimuku", "subhd")
	} else {
		log.Printf("subtitle: skip local/online providers (%v)", e)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"items": items, "count": len(items), "providers": providers})
}

/* v0.9.99：媒体 API 才是「库感知」的一侧 —— 它知道每个媒体库的根目录、能按原盘
   解析（bluray:/dvdvideo:）并列出内嵌字幕轨。这里带上调用方的 Cookie 转发一次请求，
   让鉴权沿用同一会话；失败只记日志，不影响在线字幕源。 */
func embeddedFromMediaAPI(r *http.Request, id, rawPath string) []Subtitle {
	if id == "" || rawPath == "" {
		return nil
	}
	base := strings.TrimRight(os.Getenv("MEDIA_API"), "/")
	if base == "" {
		base = "http://127.0.0.1:9100"
	}
	u := base + "/api/media/subtitles/search?id=" + esc(id) + "&path=" + esc(rawPath)
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", u, nil)
	if e != nil {
		return nil
	}
	if ck := r.Header.Get("Cookie"); ck != "" {
		req.Header.Set("Cookie", ck)
	}
	req.Header.Set("User-Agent", "VaultHub-Subtitle/1.0.11")
	res, e := client.Do(req)
	if e != nil {
		log.Printf("subtitle: media api unavailable (%v)", e)
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		log.Printf("subtitle: media api HTTP %d", res.StatusCode)
		return nil
	}
	var payload struct {
		Items []struct {
			Label     string `json:"label"`
			URL       string `json:"url"`
			Kind      string `json:"kind"`
			Text      bool   `json:"text"`
			BurnIn    bool   `json:"burn_in"`
			BurnTrack *int   `json:"burn_track"`
			Index     *int   `json:"index"`
			Codec     string `json:"codec"`
		} `json:"items"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&payload) != nil {
		return nil
	}
	out := make([]Subtitle, 0, len(payload.Items))
	for _, s := range payload.Items {
		out = append(out, Subtitle{
			Label: s.Label, URL: s.URL, Provider: "内嵌", Format: s.Codec,
			Kind: s.Kind, Text: s.Text, BurnIn: s.BurnIn, BurnTrack: s.BurnTrack, Index: s.Index,
		})
	}
	return out
}

type localProvider struct{ id string }

func (p localProvider) Name() string                            { return "local" }
func (p localProvider) Search(v, id string) ([]Subtitle, error) { return localSearch(v, id) }
func download(w http.ResponseWriter, r *http.Request) {
	if !sessionOK(r) {
		http.Error(w, "login required", 401)
		return
	}
	u := r.URL.Query().Get("url")
	if u == "" {
		http.Error(w, "missing url", 400)
		return
	}
	x, e := url.Parse(u)
	if e != nil || x.Scheme != "https" {
		http.Error(w, "invalid subtitle url", 400)
		return
	}
	b, final, e := httpGet(r.Context(), u, "")
	if e != nil {
		http.Error(w, "subtitle unavailable", 502)
		return
	}
	_ = final
	w.Header().Set("Content-Type", formatType(r.URL.Query().Get("format")))
	w.Write(b)
}
func formatType(x string) string {
	if x == "vtt" {
		return "text/vtt; charset=utf-8"
	}
	return "text/plain; charset=utf-8"
}
func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/api/media/subtitles/search", search)
	mux.HandleFunc("/api/media/subtitles/download", download)
	addr := os.Getenv("SUBTITLE_API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:9120"
	}
	log.Printf("subtitle-api listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
