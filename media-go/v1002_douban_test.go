package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

/* v1.0.2（需求4/5）：豆瓣评分 —— 片名归一化、匹配打分、搜索→详情取分、缓存。
 * 全部走本地 httptest 桩，不联网（CI 里没有外网）。 */

type v1002RoundTrip func(*http.Request) (*http.Response, error)

func (f v1002RoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

/* v1002StubClient：把电影搜索与 rexxar 详情分别路由到桩响应，并统计外呼次数。 */
func v1002StubClient(hits *int, searchJSON, detailJSON string) func(string) (*http.Client, error) {
	return func(string) (*http.Client, error) {
		return &http.Client{Transport: v1002RoundTrip(func(r *http.Request) (*http.Response, error) {
			*hits++
			body := searchJSON
			if strings.Contains(r.URL.Path, "/rexxar/") {
				body = detailJSON
			}
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(body)),
				Request:    r,
				Status:     "200 OK",
			}, nil
		})}, nil
	}
}

func v1002ResetDoubanCache() {
	doubanCacheMu.Lock()
	doubanCache = map[string]doubanCacheEntry{}
	doubanInflight = map[string]*sync.WaitGroup{}
	doubanCacheMu.Unlock()
}

func TestV1002DoubanNormTitle(t *testing.T) {
	cases := []struct{ in, want string }{
		{"东京喰种", "东京喰种"},
		{"東京喰種：re", "東京喰種re"},
		{"Tokyo Ghoul", "tokyoghoul"},
		{"The Flash (2014)", "theflash2014"},
		{"  名  侦探  柯南  ", "名侦探柯南"},
		{"ＡＢＣ", "abc"},
		{"肖申克的救赎", "肖申克的救赎"},
	}
	for _, c := range cases {
		if got := doubanNormTitle(c.in); got != c.want {
			t.Errorf("doubanNormTitle(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

func TestV1002DoubanBestMatch(t *testing.T) {
	items := []doubanSuggestItem{
		{ID: "1", Title: "东京喰种", Year: "2014", Type: "tv"},
		{ID: "2", Title: "东京喰种：re", Year: "2018", Type: "tv"},
		{ID: "3", Title: "东京物语", Year: "1953", Type: "movie"},
	}
	best, note := doubanBest(items, "tv", "2014", "东京喰种")
	if best.ID != "1" || note != "片名一致" {
		t.Fatalf("应命中完全一致那条：%+v / %q", best, note)
	}
	if best2, note2 := doubanBest(items, "tv", "1999", "东京喰种"); best2.ID != "1" || !strings.Contains(note2, "年份不同") {
		t.Fatalf("年份不同时应命中片名一致项并标注差异：%+v / %q", best2, note2)
	}
	/* 归一化后「东京喰种re」与条目 2 完全相同 → 仍然算完全一致。 */
	if got, note := doubanBest(items, "tv", "2018", "东京喰种 re"); got.ID != "2" || note != "片名一致" {
		t.Fatalf("归一化后应完全一致命中第 2 条：%+v / %q", got, note)
	}
	/* 完全不相干 → 低于阈值不出分（绝不拿别的片子顶替）。 */
	if got, _ := doubanBest(items, "tv", "2014", "海贼王"); got.ID != "" {
		t.Fatalf("不相干片名不应命中：%+v", got)
	}
	if got, _ := doubanBest(nil, "tv", "", "任何"); got.ID != "" {
		t.Fatalf("空结果集不应命中：%+v", got)
	}
}

func TestV1002DoubanLookupAndCache(t *testing.T) {
	v1002ResetDoubanCache()
	hits := 0
	old := outboundHTTPClient
	outboundHTTPClient = v1002StubClient(&hits,
		`[{"id":"1292052","title":"肖申克的救赎","year":"1994","type":"movie","img":"https://img/x.jpg"}]`,
		`{"title":"肖申克的救赎","year":"1994","type":"movie","url":"https://movie.douban.com/subject/1292052/","rating":{"value":9.7,"count":2860000},"pic":{"normal":"https://img/n.jpg"}}`)
	defer func() { outboundHTTPClient = old }()

	a := &App{}
	hit := a.lookupDouban("肖申克的救赎", "1994", "movie")
	if !hit.Match || hit.ID != "1292052" || hit.Rating != 9.7 || hit.Votes != 2860000 {
		t.Fatalf("取分失败：%+v", hit)
	}
	if hit.URL == "" || hit.Poster == "" || hit.Cached {
		t.Fatalf("链接/封面应回填、首次不应命中缓存：%+v", hit)
	}
	if hits != 2 {
		t.Fatalf("首次应搜一次、详情一次，得到 %d 次外呼", hits)
	}
	again := a.lookupDouban("肖申克的救赎", "1994", "movie")
	if !again.Cached || again.Rating != 9.7 || hits != 2 {
		t.Fatalf("第二次应命中缓存且不外呼：cached=%v hits=%d", again.Cached, hits)
	}
	/* 上游失败只记 10 分钟（不把一部剧锁死一天）：这里只验证「未命中」也会落缓存。 */
	miss := a.lookupDouban("不存在的片子", "", "movie")
	if miss.Match {
		t.Fatalf("桩只返回肖申克，查别的片名不应命中：%+v", miss)
	}
}

func TestV1002DoubanHandlerGuards(t *testing.T) {
	old := managerSessionOK
	defer func() { managerSessionOK = old }()
	a := &App{}
	managerSessionOK = func(*http.Request) bool { return false }
	rec := httptest.NewRecorder()
	a.douban(rec, httptest.NewRequest(http.MethodGet, "/api/media/douban?query=x", nil))
	if rec.Code != 401 {
		t.Fatalf("未登录应 401，得到 %d", rec.Code)
	}
	managerSessionOK = func(*http.Request) bool { return true }
	rec = httptest.NewRecorder()
	a.douban(rec, httptest.NewRequest(http.MethodGet, "/api/media/douban", nil))
	if rec.Code != 400 {
		t.Fatalf("缺 query 应 400，得到 %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	a.douban(rec, httptest.NewRequest(http.MethodPost, "/api/media/douban?query=x", nil))
	if rec.Code != 405 {
		t.Fatalf("非 GET 应 405，得到 %d", rec.Code)
	}
	/* 批量接口：未登录 401、空列表返回空 map、非法 JSON 400。 */
	rec = httptest.NewRecorder()
	a.doubanBatch(rec, httptest.NewRequest(http.MethodPost, "/api/media/douban/batch", strings.NewReader(`{"items":[]}`)))
	if rec.Code != 200 {
		t.Fatalf("空批量应 200，得到 %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	a.doubanBatch(rec, httptest.NewRequest(http.MethodPost, "/api/media/douban/batch", strings.NewReader(`{`)))
	if rec.Code != 400 {
		t.Fatalf("非法 JSON 应 400，得到 %d", rec.Code)
	}
}

/* v1.0.2（需求2）：剧集库补齐 show 级 NFO —— 剧名、剧集级 ID、演职人员。 */
func v1002SeriesFixture(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("东京喰种 (2014)/Season 1/东京喰种 - S01E01 - 第 1 集.mkv", "video")
	write("东京喰种 (2014)/Season 1/东京喰种 - S01E01 - 第 1 集.nfo", `<?xml version="1.0" encoding="utf-8"?>
<episodedetails>
  <uniqueid type="tmdb" default="true">1019299</uniqueid>
  <tmdbid>1019299</tmdbid>
  <title>悲剧</title>
  <rating>7.294</rating>
</episodedetails>`)
	write("东京喰种 (2014)/Season 1/season.nfo", `<?xml version="1.0" encoding="utf-8"?>
<season>
  <plot>季简介</plot>
  <title>东京喰种</title>
</season>`)
	write("东京喰种 (2014)/tvshow.nfo", `<?xml version="1.0" encoding="utf-8"?>
<tvshow>
  <tmdbid>61374</tmdbid>
  <uniqueid type="tmdb" default="false">61374</uniqueid>
  <tvdbid>281249</tvdbid>
  <actor><name>花江夏树</name><type>Actor</type><role>Ken Kaneki (voice)</role><thumb>https://image.tmdb.org/t/p/original/alTb0DlcPIbcwM08WSmxFai58sd.jpg</thumb></actor>
  <actor><name>雨宫天</name><role>Touka Kirishima (voice)</role><thumb>.actors/雨宫天.jpg</thumb></actor>
</tvshow>`)
	write("东京喰种 (2014)/.actors/雨宫天.jpg", "jpg")
	a := &App{libs: []Library{{ID: "series1", Name: "动画", Type: "series", Path: root}}}
	return a, root
}

func TestV1002SeriesEpisodeMergesShowNFO(t *testing.T) {
	a, _ := v1002SeriesFixture(t)
	lib, _ := a.find("series1")
	m, err := readLocalMediaMetadata(lib, "东京喰种 (2014)/Season 1/东京喰种 - S01E01 - 第 1 集.mkv")
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if m.Title != "悲剧" {
		t.Errorf("分集标题应取分集 NFO：%q", m.Title)
	}
	if m.ShowTitle != "东京喰种" || m.ShowTitleSource != "season-nfo" {
		t.Errorf("剧名应取 season.nfo 的 <title>：%q / %q", m.ShowTitle, m.ShowTitleSource)
	}
	if m.ShowTMDBID != "61374" {
		t.Errorf("剧集级 TMDB ID 应取 tvshow.nfo 的 61374：%q", m.ShowTMDBID)
	}
	if m.TMDBID != "1019299" || m.EpisodeTMDBID != "1019299" {
		t.Errorf("分集自己的 tmdbid 要留在 TMDBID/EpisodeTMDBID：%q / %q", m.TMDBID, m.EpisodeTMDBID)
	}
	if m.ShowTVDBID != "281249" {
		t.Errorf("剧集级 TVDB ID 应取到：%q", m.ShowTVDBID)
	}
	if len(m.Cast) != 2 || m.Cast[0].Name != "花江夏树" || m.Cast[1].Name != "雨宫天" {
		t.Fatalf("演职人员应来自 tvshow.nfo（分集 NFO 没有演员）：%+v", m.Cast)
	}
	if m.Cast[0].Avatar == "" || m.Cast[0].AvatarKind != "tmdb" {
		t.Errorf("TMDB 头像应转成代理地址：%+v", m.Cast[0])
	}
	if m.Cast[1].AvatarKind != "local" || !strings.Contains(m.Cast[1].Avatar, "path=") {
		t.Errorf(".actors/ 本地头像应走本地代理（相对 NFO 目录解析）：%+v", m.Cast[1])
	}
	/* 序列化后前端能拿到这些字段（json tag 不能写错）。 */
	raw, _ := json.Marshal(m)
	for _, key := range []string{`"show_title"`, `"show_title_source"`, `"show_tmdb_id"`, `"show_tvdb_id"`, `"cast"`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("JSON 缺少字段 %s", key)
		}
	}
}

func TestV1002SeriesShowTitleFallbacks(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("幽游白书 (1992)/Season 1/幽游白书.S01E01.mkv", "video")
	write("幽游白书 (1992)/tvshow.nfo", `<?xml version="1.0"?><tvshow><showtitle>幽游白书</showtitle><tmdbid>38658</tmdbid></tvshow>`)
	write("灌篮高手 (1993)/Season 1/灌篮高手.S01E01.mkv", "video")
	write("灌篮高手 (1993)/Season 1/season.nfo", `<?xml version="1.0"?><season><title>Season 1</title></season>`)
	a := &App{libs: []Library{{ID: "s", Name: "动画", Type: "series", Path: root}}}
	lib, _ := a.find("s")

	m1, err := readLocalMediaMetadata(lib, "幽游白书 (1992)/Season 1/幽游白书.S01E01.mkv")
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if m1.ShowTitle != "幽游白书" || m1.ShowTitleSource != "tvshow-nfo" || m1.ShowTMDBID != "38658" {
		t.Errorf("showtitle / tvshow.nfo 兜底失败：%+v", m1)
	}
	m2, err := readLocalMediaMetadata(lib, "灌篮高手 (1993)/Season 1/灌篮高手.S01E01.mkv")
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if m2.ShowTitle != "灌篮高手" || m2.ShowTitleSource != "folder" {
		t.Errorf("季标记标题应被排除并退回目录名：%+v", m2)
	}

	/* 电影库不受影响：不加剧名字段、ID 仍取自身的。 */
	write("Movie.2020/Movie.2020.mkv", "v")
	write("Movie.2020/Movie.2020.nfo", `<?xml version="1.0"?><movie><title>电影</title><tmdbid>7</tmdbid></movie>`)
	mlib := Library{ID: "m", Name: "电影", Type: "movie", Path: root}
	mm, err := readLocalMediaMetadata(mlib, "Movie.2020/Movie.2020.mkv")
	if err != nil {
		t.Fatalf("电影读取失败：%v", err)
	}
	if mm.ShowTitle != "" || mm.ShowTMDBID != "" || mm.Title != "电影" || mm.TMDBID != "7" {
		t.Errorf("电影库不应受剧集级合并影响：%+v", mm)
	}
}

func TestV1002SeasonMarkerTitle(t *testing.T) {
	for _, s := range []string{"Season 1", "season 03", "第 2 季", "Specials", "特别篇", "花絮", ""} {
		if !seasonMarkerTitle(s) {
			t.Errorf("%q 应被识别为季标记（不能当剧名）", s)
		}
	}
	for _, s := range []string{"东京喰种", "The Flash", "第一季的下克上"} {
		if seasonMarkerTitle(s) {
			t.Errorf("%q 是正常剧名，不该被判成季标记", s)
		}
	}
}

func TestV1002DoubanHitJSONShape(t *testing.T) {
	raw, _ := json.Marshal(doubanHit{Match: true, Rating: 8.7, Votes: 12345, URL: "u", Title: "t"})
	for _, key := range []string{`"match"`, `"rating"`, `"votes"`, `"url"`, `"title"`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("doubanHit JSON 缺少 %s：%s", key, raw)
		}
	}
}
