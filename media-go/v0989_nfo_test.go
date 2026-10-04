package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* v0.9.89：NFO 元数据本地化写入。
 *
 * 闭环要点：写进去的 NFO 必须能被服务端本地元数据读取端（local_metadata.go）
 * 原样读回来 —— 否则「下次进库直接读本地、不再联网刮削」就是空话。
 */

func newV0989NFOApp(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	for _, rel := range []string{
		"Water.Boys.2001/Water.Boys.2001.1080p.mkv",
		"Show Name/Season 01/Show.Name.S01E01.mkv",
	} {
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a := &App{
		libs: []Library{
			{ID: "movie1", Name: "电影", Type: "movie", Path: root},
			{ID: "tv1", Name: "剧集", Type: "series", Path: root},
		},
		scrapeCachePath: filepath.Join(root, "media-scrape-cache.json"),
	}
	return a, root
}

func v0989NFOAuth(t *testing.T) {
	t.Helper()
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	t.Cleanup(func() { managerSessionOK = old })
}

func v0989NFOPost(t *testing.T, a *App, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	a.nfoHandler(rec, httptest.NewRequest(http.MethodPost, "/api/media/nfo", bytes.NewReader(raw)))
	return rec
}

// TestV0989NFORoundTrip 写入后必须能被本地元数据读取端读回（本地 NFO 闭环）。
func TestV0989NFORoundTrip(t *testing.T) {
	a, root := newV0989NFOApp(t)
	v0989NFOAuth(t)
	rec := v0989NFOPost(t, a, map[string]any{
		"id":   "movie1",
		"path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv",
		"meta": map[string]any{
			"title": "五个扑水的少年", "original_title": "Water Boys",
			"year": "2001", "overview": "剧情简介", "rating": 6.8, "runtime": 91,
			"genres": []string{"喜剧", "运动"}, "tmdb_id": "61",
			"cast":  []map[string]any{{"name": "妻夫木聪", "character": "铃木"}},
			"poster": "https://image.tmdb.org/t/p/w342/wb.jpg",
		},
	})
	if rec.Code != 200 {
		t.Fatalf("POST nfo → %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	// 目标名 = 媒体文件去扩展名 + .nfo（读取端候选顺序正是 <文件名>.nfo → movie.nfo）
	if got := out["nfo"]; got != "Water.Boys.2001/Water.Boys.2001.1080p.nfo" {
		t.Fatalf("写入路径应为同目录同名 .nfo，得到 %v", got)
	}
	abs := filepath.Join(root, "Water.Boys.2001", "Water.Boys.2001.1080p.nfo")
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatalf("NFO 文件应存在：%v", err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("NFO 权限应为 0644，得到 %v", info.Mode().Perm())
	}
	body, _ := os.ReadFile(abs)
	if !strings.HasPrefix(string(body), "<?xml") || !strings.Contains(string(body), nfoMarker) {
		t.Fatalf("NFO 应为带标记的 XML：%s", string(body)[:min(120, len(body))])
	}

	// 读取端闭环
	lib, _ := a.find("movie1")
	m, err := readLocalMediaMetadata(lib, "Water.Boys.2001/Water.Boys.2001.1080p.mkv")
	if err != nil {
		t.Fatalf("读回失败：%v", err)
	}
	if m.Provider != "本地 NFO" || m.NFO == "" {
		t.Fatalf("应识别为本地 NFO，得到 provider=%q nfo=%q", m.Provider, m.NFO)
	}
	if m.Title != "五个扑水的少年" || m.Year != "2001" || m.TMDBID != "61" {
		t.Fatalf("标题/年份/TMDB ID 未读回：%+v", m)
	}
	if len(m.Genres) != 2 || len(m.Cast) != 1 || m.Cast[0].Name != "妻夫木聪" {
		t.Fatalf("类型/演员未读回：%+v", m)
	}
	if m.Overview == "" || m.Rating == 0 {
		t.Fatalf("简介/评分未读回：%+v", m)
	}

	// 剧集：extras 写到上一层 show 根的 tvshow.nfo
	rec2 := v0989NFOPost(t, a, map[string]any{
		"id": "tv1", "path": "Show Name/Season 01/Show.Name.S01E01.mkv",
		"extras": []map[string]any{{"name": "tvshow.nfo", "up": 1}},
		"meta":   map[string]any{"title": "剧集名", "show_title": "Show Name", "year": "2019"},
	})
	if rec2.Code != 200 {
		t.Fatalf("剧集 POST → %d %s", rec2.Code, rec2.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "Show Name", "tvshow.nfo")); err != nil {
		t.Fatalf("tvshow.nfo 应写在 show 根：%v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "Show Name", "Season 01", "Show.Name.S01E01.nfo")); err != nil {
		t.Fatalf("单集 NFO 应写在集目录：%v", err)
	}
}

// TestV0989NFOKeepsUserFile 用户手写 / 其他工具写的 NFO 默认不被覆盖。
func TestV0989NFOKeepsUserFile(t *testing.T) {
	a, root := newV0989NFOApp(t)
	v0989NFOAuth(t)
	abs := filepath.Join(root, "Water.Boys.2001", "Water.Boys.2001.1080p.nfo")
	if err := os.WriteFile(abs, []byte("<movie><title>我自己写的</title></movie>"), 0644); err != nil {
		t.Fatal(err)
	}
	rec := v0989NFOPost(t, a, map[string]any{
		"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv",
		"meta": map[string]any{"title": "五个扑水的少年"},
	})
	if rec.Code != 200 {
		t.Fatalf("POST → %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	kept, _ := out["kept"].([]any)
	if len(kept) != 1 {
		t.Fatalf("用户 NFO 应被保留（kept 一条），得到 %v", out)
	}
	body, _ := os.ReadFile(abs)
	if !strings.Contains(string(body), "我自己写的") {
		t.Fatalf("用户 NFO 被覆盖了：%s", body)
	}
	// 显式 overwrite 才允许覆盖
	rec2 := v0989NFOPost(t, a, map[string]any{
		"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv", "overwrite": true,
		"meta": map[string]any{"title": "五个扑水的少年"},
	})
	if rec2.Code != 200 {
		t.Fatalf("overwrite POST → %d", rec2.Code)
	}
	body2, _ := os.ReadFile(abs)
	if strings.Contains(string(body2), "我自己写的") || !strings.Contains(string(body2), "五个扑水的少年") {
		t.Fatalf("overwrite=true 应覆盖：%s", body2)
	}
}

// TestV0989NFOPathGuard 路径边界：不接受穿越 / 绝对路径 / 非 .nfo 名字。
func TestV0989NFOPathGuard(t *testing.T) {
	a, root := newV0989NFOApp(t)
	v0989NFOAuth(t)
	cases := []struct {
		name string
		body map[string]any
		code int
	}{
		{"媒体路径穿越", map[string]any{"id": "movie1", "path": "../etc/passwd", "meta": map[string]any{"title": "x"}}, 400},
		{"绝对路径", map[string]any{"id": "movie1", "path": "/etc/passwd", "meta": map[string]any{"title": "x"}}, 400},
		{"非法 extras 名（.jpg）", map[string]any{"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv", "extras": []map[string]any{{"name": "../../evil.nfo"}}, "meta": map[string]any{"title": "x"}}, 400},
		{"extras 上溯越界", map[string]any{"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv", "extras": []map[string]any{{"name": "movie.nfo", "up": 9}}, "meta": map[string]any{"title": "x"}}, 400},
		{"缺标题", map[string]any{"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv", "meta": map[string]any{}}, 400},
		{"未知库", map[string]any{"id": "nope", "path": "a.mkv", "meta": map[string]any{"title": "x"}}, 404},
	}
	for _, c := range cases {
		if rec := v0989NFOPost(t, a, c.body); rec.Code != c.code {
			t.Errorf("%s：期望 %d，得到 %d %s", c.name, c.code, rec.Code, rec.Body.String())
		}
	}
	// 越界写入不能真的落到根目录外
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "evil.nfo")); err == nil {
		t.Fatal("越界写入发生了：根目录外出现 evil.nfo")
	}
	// 未登录
	managerSessionOK = func(*http.Request) bool { return false }
	if rec := v0989NFOPost(t, a, map[string]any{"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv", "meta": map[string]any{"title": "x"}}); rec.Code != 401 {
		t.Fatalf("未登录应 401，得到 %d", rec.Code)
	}
}

// TestV0989NFOEscapesXML 标题/简介里的 XML 特殊字符必须转义（不能写出坏 XML）。
func TestV0989NFOEscapesXML(t *testing.T) {
	a, root := newV0989NFOApp(t)
	v0989NFOAuth(t)
	rec := v0989NFOPost(t, a, map[string]any{
		"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv",
		"meta": map[string]any{"title": `A & B <script>alert("x")</script>`, "overview": "1 < 2 && 3 > 2", "year": "2001"},
	})
	if rec.Code != 200 {
		t.Fatalf("POST → %d %s", rec.Code, rec.Body.String())
	}
	body, _ := os.ReadFile(filepath.Join(root, "Water.Boys.2001", "Water.Boys.2001.1080p.nfo"))
	if strings.Contains(string(body), "<script>") {
		t.Fatalf("XML 未转义：%s", body)
	}
	// 能被解析回来（读取端不报错）
	lib, _ := a.find("movie1")
	m, err := readLocalMediaMetadata(lib, "Water.Boys.2001/Water.Boys.2001.1080p.mkv")
	if err != nil || !strings.Contains(m.Title, "A & B") {
		t.Fatalf("转义后的标题应能读回：%v %q", err, m.Title)
	}
}

// TestV0989ArtworkRoleSidecar 图片本地化按角色落成读取端认识的 sidecar 名。
func TestV0989ArtworkRoleSidecar(t *testing.T) {
	cases := []struct{ rel, role, ext, want string }{
		{"Water.Boys.2001/Water.Boys.2001.1080p.mkv", "poster", "jpg", "Water.Boys.2001/Water.Boys.2001.1080p-poster.jpg"},
		{"Water.Boys.2001/Water.Boys.2001.1080p.mkv", "fanart", "jpg", "Water.Boys.2001/Water.Boys.2001.1080p-fanart.jpg"},
		{"Water.Boys.2001/Water.Boys.2001.1080p.mkv", "backdrop", "png", "Water.Boys.2001/Water.Boys.2001.1080p-backdrop.png"},
		{"Water.Boys.2001/Water.Boys.2001.1080p.mkv", "logo", "png", "Water.Boys.2001/Water.Boys.2001.1080p-logo.png"},
		{"Water.Boys.2001/Water.Boys.2001.1080p.mkv", "", "jpg", "Water.Boys.2001/Water.Boys.2001.1080p.cover.jpg"},
		{"Water.Boys.2001/Water.Boys.2001.1080p.mkv", "cover", "jpg", "Water.Boys.2001/Water.Boys.2001.1080p.cover.jpg"},
	}
	for _, c := range cases {
		if got := coverSidecarRelRole(c.rel, c.role, c.ext); got != c.want {
			t.Errorf("role=%q → %q，期望 %q", c.role, got, c.want)
		}
	}
	// 读取端确实认这些名字（poster/fanart/backdrop/logo 都在候选里）
	lib := Library{ID: "movie1", Type: "movie", Path: t.TempDir()}
	_ = lib
	src, err := os.ReadFile(filepath.Join("local_metadata.go"))
	if err != nil {
		t.Skip("源码不可读")
	}
	for _, frag := range []string{`"-poster.png"`, `"-poster.jpg"`, `"-fanart.jpg"`, `"-backdrop.jpg"`, `"-logo.png"`} {
		if !bytes.Contains(src, []byte(frag)) {
			t.Errorf("本地元数据读取端没有 %s 候选，本地化图片会读不回", frag)
		}
	}
}

// TestV0989NFOFlatLibrarySkipsMovieNFO 扁平库（目录里多部片子）不写 movie.nfo，
// 避免读取端把一部片的信息串到同目录其它文件上。
func TestV0989NFOFlatLibrarySkipsMovieNFO(t *testing.T) {
	a, root := newV0989NFOApp(t)
	v0989NFOAuth(t)
	// 同目录再来一个原盘镜像 → 目录内媒体文件数 = 2
	iso := filepath.Join(root, "Water.Boys.2001", "Water.Boys.2001.Blu-ray.iso")
	if err := os.WriteFile(iso, []byte("iso"), 0644); err != nil {
		t.Fatal(err)
	}
	rec := v0989NFOPost(t, a, map[string]any{
		"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv",
		"extras": []map[string]any{{"name": "movie.nfo", "up": 0}},
		"meta":   map[string]any{"title": "五个扑水的少年"},
	})
	if rec.Code != 200 {
		t.Fatalf("POST → %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if _, err := os.Stat(filepath.Join(root, "Water.Boys.2001", "movie.nfo")); err == nil {
		t.Fatal("目录里有 2 个媒体文件时不应写 movie.nfo（会串到别的文件上）")
	}
	sk, _ := out["skipped"].([]any)
	if len(sk) != 1 {
		t.Fatalf("应把 movie.nfo 记为 skipped，得到 %v", out)
	}
	if _, err := os.Stat(filepath.Join(root, "Water.Boys.2001", "Water.Boys.2001.1080p.nfo")); err != nil {
		t.Fatalf("同名 .nfo 仍应写入：%v", err)
	}
	// 单文件目录（电影独立目录）→ 正常写 movie.nfo
	only := filepath.Join(root, "Solo.Movie.2020")
	if err := os.MkdirAll(only, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(only, "Solo.Movie.2020.mkv"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	rec2 := v0989NFOPost(t, a, map[string]any{
		"id": "movie1", "path": "Solo.Movie.2020/Solo.Movie.2020.mkv",
		"extras": []map[string]any{{"name": "movie.nfo", "up": 0}},
		"meta":   map[string]any{"title": "单人电影"},
	})
	if rec2.Code != 200 {
		t.Fatalf("单文件目录 POST → %d", rec2.Code)
	}
	if _, err := os.Stat(filepath.Join(only, "movie.nfo")); err != nil {
		t.Fatalf("电影独立目录应写 movie.nfo（Emby/Kodi 约定）：%v", err)
	}
}

// TestV0989NFOOutputClean 输出保持干净且可被读取端解析（不留空元素 / 重复署名）。
func TestV0989NFOOutputClean(t *testing.T) {
	a, root := newV0989NFOApp(t)
	v0989NFOAuth(t)
	rec := v0989NFOPost(t, a, map[string]any{
		"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv",
		"meta": map[string]any{"title": "五个扑水的少年", "year": "2001", "overview": "简介", "tmdb_id": "61"},
	})
	if rec.Code != 200 {
		t.Fatalf("POST → %d", rec.Code)
	}
	body, _ := os.ReadFile(filepath.Join(root, "Water.Boys.2001", "Water.Boys.2001.1080p.nfo"))
	if bytes.Contains(body, []byte("<fanart></fanart>")) {
		t.Fatalf("没有 fanart 时不该留空元素：%s", body)
	}
	if bytes.Contains(body, []byte("VaultHub VaultHub")) {
		t.Fatalf("署名重复：%s", body)
	}
	if !bytes.Contains(body, []byte("<title>五个扑水的少年</title>")) {
		t.Fatalf("标题缺失：%s", body)
	}
}

// TestV0989NFOPortableArtwork 图片地址可移植化：同目录 sidecar 写文件名，远程保留 URL。
func TestV0989NFOPortableArtwork(t *testing.T) {
	if got := nfoPortableArtURL("/api/media/cover?id=movie1&path=A/B-poster.jpg&v=1", "A/B.mkv"); got != "B-poster.jpg" {
		t.Errorf("同目录 sidecar 应写文件名，得到 %q", got)
	}
	if got := nfoPortableArtURL("/api/media/file?id=movie1&path=elsewhere/x.jpg", "A/B.mkv"); got != "" {
		t.Errorf("站内其它位置的图应留空，得到 %q", got)
	}
	if got := nfoPortableArtURL("https://image.tmdb.org/t/p/w342/x.jpg", "A/B.mkv"); got != "https://image.tmdb.org/t/p/w342/x.jpg" {
		t.Errorf("远程图应保留 URL，得到 %q", got)
	}
	if got := nfoPortableArtURL("javascript:alert(1)", "A/B.mkv"); got != "" {
		t.Errorf("非法协议应留空，得到 %q", got)
	}
	// 落盘后确认 NFO 里就是文件名
	a, root := newV0989NFOApp(t)
	v0989NFOAuth(t)
	rec := v0989NFOPost(t, a, map[string]any{
		"id": "movie1", "path": "Water.Boys.2001/Water.Boys.2001.1080p.mkv",
		"meta": map[string]any{"title": "五个扑水的少年",
			"poster": "/api/media/cover?id=movie1&path=Water.Boys.2001/Water.Boys.2001.1080p-poster.jpg&v=9"},
	})
	if rec.Code != 200 {
		t.Fatalf("POST → %d", rec.Code)
	}
	body, _ := os.ReadFile(filepath.Join(root, "Water.Boys.2001", "Water.Boys.2001.1080p.nfo"))
	if !bytes.Contains(body, []byte("<thumb aspect=\"poster\">Water.Boys.2001.1080p-poster.jpg</thumb>")) {
		t.Fatalf("NFO 里的海报应是同目录文件名：%s", body)
	}
	if bytes.Contains(body, []byte("&amp;v=9")) {
		t.Fatalf("不该写入带查询串的站内地址：%s", body)
	}
}
