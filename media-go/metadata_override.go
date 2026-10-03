package main

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type mediaMetadataOverride struct {
	/* v0.9.86（客户要求「增加影视媒体编辑功能辅助完成刮削（媒体名称、年份）」）：
	   手工指定的名称与年份进 override 文件，既直接作为展示名，也作为刮削搜索词，
	   而且跨设备/跨浏览器一致（不依赖 localStorage）。 */
	Title      string   `json:"title,omitempty"`
	Year       string   `json:"year,omitempty"`
	UserRating float64  `json:"user_rating,omitempty"`
	Poster     string   `json:"poster,omitempty"`
	Logo       string   `json:"logo,omitempty"`
	Fanart     string   `json:"fanart,omitempty"`
	Backdrop   string   `json:"backdrop,omitempty"`
	Tags       []string `json:"tags,omitempty"`
	Watched    bool     `json:"watched,omitempty"`
}

func overrideKey(libID, mediaPath string) string {
	return libID + "\n" + filepath.ToSlash(filepath.Clean(mediaPath))
}

func (a *App) loadMetadataOverrides() (map[string]mediaMetadataOverride, error) {
	out := map[string]mediaMetadataOverride{}
	if a.metadataOverrides == "" {
		return out, nil
	}
	b, err := os.ReadFile(a.metadataOverrides)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (a *App) saveMetadataOverrides(all map[string]mediaMetadataOverride) error {
	if a.metadataOverrides == "" {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(filepath.Dir(a.metadataOverrides), 0755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(a.metadataOverrides), ".metadata-overrides-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Chmod(tmp, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, a.metadataOverrides); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(a.metadataOverrides))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func validArtworkValue(lib Library, raw string) bool {
	if raw == "" {
		return true
	}
	if strings.HasPrefix(raw, "/api/media/file?") {
		u, err := url.Parse(raw)
		if err != nil || u.Path != "/api/media/file" || u.Query().Get("id") != lib.ID {
			return false
		}
		p := u.Query().Get("path")
		if p == "" {
			return false
		}
		_, _, err = safeFile(lib, p)
		return err == nil && isArtworkFile(p)
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil && len(raw) <= 2048
}

func isArtworkFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif":
		return true
	}
	return false
}

func sanitizeOverride(lib Library, in mediaMetadataOverride) (mediaMetadataOverride, error) {
	for _, raw := range []string{in.Poster, in.Logo, in.Fanart, in.Backdrop} {
		if !validArtworkValue(lib, strings.TrimSpace(raw)) {
			return in, os.ErrInvalid
		}
	}
	in.Poster, in.Logo, in.Fanart, in.Backdrop = strings.TrimSpace(in.Poster), strings.TrimSpace(in.Logo), strings.TrimSpace(in.Fanart), strings.TrimSpace(in.Backdrop)
	/* v0.9.86：名称 / 年份 —— 名称去掉控制字符并限长（搜索词，别让请求被玩坏），
	   年份只接受 4 位数字，其它一律当空（宁可不写，也不写坏）。 */
	in.Title = sanitizeOverrideTitle(in.Title)
	in.Year = sanitizeOverrideYear(in.Year)
	/* v0.9.76：手动十分制评分（1–10，0 = 未评分）。存进 override 文件，
	   走的是同一份 /data 持久化，所以换设备/换浏览器打开同一部影片看到的
	   都是自己上次打的分 —— 多端同步就靠它，localStorage 只做缓存回退。 */
	if in.UserRating < 0 || in.UserRating > 10 {
		return in, os.ErrInvalid
	}
	if in.UserRating > 0 && in.UserRating != math.Round(in.UserRating*2)/2 {
		in.UserRating = math.Round(in.UserRating*2) / 2
	}
	seen, tags := map[string]bool{}, []string{}
	for _, tag := range in.Tags {
		tag = strings.TrimSpace(tag)
		if tag != "" && len([]rune(tag)) <= 32 && !seen[tag] && len(tags) < 20 {
			seen[tag] = true
			tags = append(tags, tag)
		}
	}
	in.Tags = tags
	return in, nil
}

func (a *App) metadataOverride(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodPut {
		errJSON(w, 405, "method not allowed")
		return
	}
	lib, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	mediaPath := r.URL.Query().Get("path")
	if _, _, err := safeFile(lib, mediaPath); err != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	var in mediaMetadataOverride
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&in); err != nil {
		errJSON(w, 400, "invalid metadata override")
		return
	}
	in, err := sanitizeOverride(lib, in)
	if err != nil {
		errJSON(w, 400, "invalid artwork URL or media path")
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	all, err := a.loadMetadataOverrides()
	if err != nil {
		errJSON(w, 500, "metadata override store is invalid")
		return
	}
	all[overrideKey(lib.ID, mediaPath)] = in
	if err := a.saveMetadataOverrides(all); err != nil {
		errJSON(w, 500, "metadata override save failed")
		return
	}
	writeJSON(w, 200, in)
}

func (a *App) mergeMetadataOverride(lib Library, mediaPath string, m *localMediaMetadata) {
	all, err := a.loadMetadataOverrides()
	if err != nil {
		return
	}
	in, ok := all[overrideKey(lib.ID, mediaPath)]
	if !ok {
		return
	}
	/* v0.9.86：手工名称/年份优先于文件名解析结果。 */
	if in.Title != "" {
		m.Title = in.Title
	}
	if in.Year != "" {
		m.Year = in.Year
	}
	if in.Poster != "" {
		m.Poster = in.Poster
	}
	if in.Logo != "" {
		m.Logo = in.Logo
	}
	if in.Fanart != "" {
		m.Fanart = in.Fanart
	}
	if in.Backdrop != "" {
		m.Backdrop = in.Backdrop
	}
	if in.UserRating > 0 {
		m.UserRating = in.UserRating
	}
	m.Tags, m.Watched = in.Tags, in.Watched
}

func (a *App) artworkCandidates(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	lib, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "invalid media path")
		return
	}
	p, _, err := safeFile(lib, r.URL.Query().Get("path"))
	if err != nil {
		errJSON(w, 404, "invalid media path")
		return
	}
	entries, err := os.ReadDir(filepath.Dir(p))
	if err != nil {
		errJSON(w, 500, "artwork list failed")
		return
	}
	items := []map[string]string{}
	for _, entry := range entries {
		if entry.IsDir() || !isArtworkFile(entry.Name()) {
			continue
		}
		abs := filepath.Join(filepath.Dir(p), entry.Name())
		rel := indexRelFor(lib, abs)
		if rel == "" {
			continue
		}
		_, info, safeErr := safeFile(lib, rel)
		if safeErr != nil || info.Size() > 25<<20 {
			continue
		}
		items = append(items, map[string]string{"name": entry.Name(), "url": mediaAssetURL(lib.ID, rel)})
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["name"] < items[j]["name"] })
	writeJSON(w, 200, map[string]any{"items": items})
}

/*
sanitizeOverrideTitle 清洗手工名称：去控制字符、压空白、限 120 字符（按 rune）。

	空字符串表示「不覆盖」—— 保持文件名解析出来的名称。
*/
func sanitizeOverrideTitle(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		if r == '\n' || r == '\r' || r == '\t' {
			b.WriteRune(' ')
			continue
		}
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	if len([]rune(out)) > 120 {
		out = string([]rune(out)[:120])
	}
	return out
}

/* sanitizeOverrideYear 只接受 4 位数字年份（1800–2200），其余按空处理。 */
func sanitizeOverrideYear(raw string) string {
	y := strings.TrimSpace(raw)
	if len(y) != 4 {
		return ""
	}
	for i := 0; i < len(y); i++ {
		if y[i] < '0' || y[i] > '9' {
			return ""
		}
	}
	n, err := strconv.Atoi(y)
	if err != nil || n < 1800 || n > 2200 {
		return ""
	}
	return y
}
