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

func search(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	id := r.URL.Query().Get("id")
	v, e := safeVideo(r.URL.Query().Get("path"))
	if e != nil {
		http.Error(w, e.Error(), 400)
		return
	}
	ps := []Provider{localProvider{id: id}, shooter{os.Getenv("SUBTITLE_SHOOTER_ENDPOINT")}, webProvider{"zimuku", os.Getenv("SUBTITLE_ZIMUKU_BASE")}, webProvider{"subhd", os.Getenv("SUBTITLE_SUBHD_BASE")}}
	items := []Subtitle{}
	seen := map[string]bool{}
	for _, p := range ps {
		xs, e := p.Search(v, id)
		if e != nil {
			log.Printf("subtitle provider=%s error=%v", p.Name(), e)
			continue
		}
		for _, x := range xs {
			if !seen[x.URL] {
				seen[x.URL] = true
				items = append(items, x)
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"items": items, "providers": []string{"local", "shooter", "zimuku", "subhd"}})
}

type localProvider struct{ id string }

func (p localProvider) Name() string                            { return "local" }
func (p localProvider) Search(v, id string) ([]Subtitle, error) { return localSearch(v, id) }
func download(w http.ResponseWriter, r *http.Request) {
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
