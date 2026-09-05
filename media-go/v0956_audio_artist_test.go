package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

/* v0.9.56 歌手刮削契约：
   1. splitAudioCollaborators 正确处理单人 / 组合 / 合作演唱关系；
   2. iTunes musicArtist 命中返回头像（100x100 → 600x600 提升）；
   3. iTunes 无结果回落 MusicBrainz artist（规范名校验）；
   4. /api/media/audio/artist 需要登录会话（writeAuth），否则 401；
   5. 两源都未命中 → 404（前端保持文字/首字母占位）。 */

func TestSplitAudioCollaborators(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"周杰伦", []string{"周杰伦"}},
		{"五月天", []string{"五月天"}},
		{"周杰伦 feat. 杨瑞代", []string{"周杰伦", "杨瑞代"}},
		{"A ft. B", []string{"A", "B"}},
		{"A & B", []string{"A", "B"}},
		{"A、B", []string{"A", "B"}},
		{"A / B", []string{"A", "B"}},
		{"  (组合)  ", []string{"组合"}},
		{"A x B", []string{"A", "B"}},
		{"A feat B", []string{"A", "B"}},
	}
	for _, c := range cases {
		got := splitAudioCollaborators(c.in)
		if len(got) != len(c.want) {
			t.Fatalf("splitAudioCollaborators(%q) = %v, want %v", c.in, got, c.want)
		}
		for i := range c.want {
			if got[i] != c.want[i] {
				t.Fatalf("splitAudioCollaborators(%q) = %v, want %v", c.in, got, c.want)
			}
		}
	}
}

func TestAudioArtistItunesPrimaryWithArtwork(t *testing.T) {
	// 模拟 iTunes musicArtist 响应：命中「周杰伦」且返回 100x100 头像
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/search") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"resultCount":1,"results":[{"artistName":"周杰倫","artistId":300117743,"artworkUrl100":"https://art.example/100x100bb.jpg"}]}`))
	}))
	defer server.Close()
	oldBase, oldClient := itunesSearchBase, outboundHTTPClient
	itunesSearchBase = server.URL
	defer func() { itunesSearchBase, outboundHTTPClient = oldBase, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	res, ok := a.scrapeAudioArtistItunes(context.Background(), "周杰伦")
	if !ok {
		t.Fatal("iTunes artist lookup should hit")
	}
	if res.Name != "周杰倫" || !strings.Contains(res.Cover, "600x600bb") {
		t.Fatalf("unexpected result %+v", res)
	}
	if res.Provider != "iTunes" {
		t.Fatalf("provider = %s", res.Provider)
	}
}

func TestAudioArtistUsesAlbumLookupCover(t *testing.T) {
	// v0.9.56：musicArtist 实体通常不带 artwork（实测），命中后二次 lookup
	// 该歌手的代表专辑取封面 —— search 返回 artistId 无图，lookup 返回专辑封面。
	var hitSearch, hitLookup bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/search" {
			hitSearch = true
			w.Write([]byte(`{"resultCount":1,"results":[{"artistName":"周杰倫","artistId":300117743}]}`))
			return
		}
		if r.URL.Path == "/lookup" {
			hitLookup = true
			w.Write([]byte(`{"resultCount":2,"results":[{"wrapperType":"artist","artistName":"周杰倫","artistId":300117743},{"wrapperType":"collection","collectionType":"Album","artistId":300117743,"collectionName":"代表专辑","artworkUrl100":"https://art.example/100x100bb.jpg"}]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	oldBase, oldClient := itunesSearchBase, outboundHTTPClient
	itunesSearchBase = server.URL
	defer func() { itunesSearchBase, outboundHTTPClient = oldBase, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	res, ok := a.scrapeAudioArtistItunes(context.Background(), "周杰伦")
	if !ok {
		t.Fatal("album-lookup cover should hit")
	}
	if !hitSearch || !hitLookup {
		t.Fatalf("search=%v lookup=%v — 两次 iTunes 请求都要发出", hitSearch, hitLookup)
	}
	if res.Provider != "iTunes" || !strings.Contains(res.Cover, "600x600bb") || res.Name != "周杰倫" {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestAudioArtistCollaborationUsesLeadSinger(t *testing.T) {
	// 合作串：只应查询主歌手（feat. 前），返回主歌手封面
	var lastTerm string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/search") {
			q, _ := url.ParseQuery(r.URL.RawQuery)
			lastTerm = q.Get("term")
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"resultCount":1,"results":[{"artistName":"周杰伦","artistId":300117743,"artworkUrl100":"https://art.example/100x100bb.jpg"}]}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"resultCount":0,"results":[]}`))
	}))
	defer server.Close()
	oldBase, oldClient := itunesSearchBase, outboundHTTPClient
	itunesSearchBase = server.URL
	defer func() { itunesSearchBase, outboundHTTPClient = oldBase, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	out := a.scrapeAudioArtist(context.Background(), "周杰伦 feat. 杨瑞代")
	if strings.Contains(lastTerm, "feat") || !strings.Contains(lastTerm, "周杰伦") {
		t.Fatalf("should query lead singer only, term=%q", lastTerm)
	}
	if out.Name != "周杰伦" {
		t.Fatalf("name = %q", out.Name)
	}
	if len(out.Collaborators) != 2 || out.Collaborators[1] != "杨瑞代" {
		t.Fatalf("collaborators = %v", out.Collaborators)
	}
	if out.Provider != "iTunes" {
		t.Fatalf("provider = %s", out.Provider)
	}
}

func TestAudioArtistFallsBackToMusicBrainz(t *testing.T) {
	// iTunes 完全不返回 → 回落 MusicBrainz（规范化命中，类型 solo/group）
	itunesServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"resultCount":0,"results":[]}`))
	}))
	defer itunesServer.Close()
	mbServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"artists":[{"id":"mbid-1","name":"五月天","score":100,"type":"Group"}]}`))
	}))
	defer mbServer.Close()
	oldItunes, oldMB, oldClient := itunesSearchBase, audioScrapeBase, outboundHTTPClient
	itunesSearchBase = itunesServer.URL
	audioScrapeBase = mbServer.URL
	defer func() { itunesSearchBase, audioScrapeBase, outboundHTTPClient = oldItunes, oldMB, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return itunesServer.Client(), nil }

	a := &App{}
	out := a.scrapeAudioArtist(context.Background(), "五月天")
	if out.Provider != "MusicBrainz" || out.Name != "五月天" {
		t.Fatalf("expected MusicBrainz fallback, got %+v", out)
	}
	if out.Type != "group" {
		t.Fatalf("MB type should map Group → group, got %q", out.Type)
	}
	if out.Cover != "" {
		t.Fatalf("MB fallback should not fabricate a cover, got %q", out.Cover)
	}
}

func TestAudioArtistEndpointAuth(t *testing.T) {
	a := &App{}
	r := httptest.NewRequest(http.MethodGet, "/api/media/audio/artist?name=周杰伦", nil)
	w := httptest.NewRecorder()
	a.audioArtist(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no session should 401, got %d", w.Code)
	}
}

func TestAudioArtistEndpointHitAndMiss(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/search") && strings.Contains(r.URL.Query().Get("term"), "命中") {
			w.Write([]byte(`{"resultCount":1,"results":[{"artistName":"命中歌手","artistId":10086,"artworkUrl100":"https://art.example/100x100bb.jpg"}]}`))
			return
		}
		w.Write([]byte(`{"resultCount":0,"results":[]}`))
	}))
	defer server.Close()
	oldBase, oldClient, oldOK := itunesSearchBase, outboundHTTPClient, managerSessionOK
	itunesSearchBase = server.URL
	managerSessionOK = func(*http.Request) bool { return true }
	defer func() { itunesSearchBase, outboundHTTPClient, managerSessionOK = oldBase, oldClient, oldOK }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	w := httptest.NewRecorder()
	a.audioArtist(w, httptest.NewRequest(http.MethodGet, "/api/media/audio/artist?name="+url.QueryEscape("命中歌手"), nil))
	if w.Code != http.StatusOK {
		t.Fatalf("hit should 200, got %d body=%s", w.Code, w.Body.String())
	}
	var out artistScrapeResult
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Name != "命中歌手" || out.Provider != "iTunes" {
		t.Fatalf("unexpected body %s", w.Body.String())
	}

	// 未命中两源（MB 也空）→ 404
	oldMB := audioScrapeBase
	mbServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"artists":[]}`))
	}))
	defer mbServer.Close()
	audioScrapeBase = mbServer.URL
	defer func() { audioScrapeBase = oldMB }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	w2 := httptest.NewRecorder()
	a.audioArtist(w2, httptest.NewRequest(http.MethodGet, "/api/media/audio/artist?name="+url.QueryEscape("不存在的歌手"), nil))
	if w2.Code != http.StatusNotFound {
		t.Fatalf("miss should 404, got %d body=%s", w2.Code, w2.Body.String())
	}
}

// 确保节流锁与 ctx 取消路径不会死锁（快速连续两次 iTunes 调用）
func TestAudioArtistThrottleNoDeadlock(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/search") {
			w.Write([]byte(`{"resultCount":1,"results":[{"artistName":"节流歌手","artistId":20001,"artworkUrl100":"https://art.example/100x100bb.jpg"}]}`))
			return
		}
		w.Write([]byte(`{"resultCount":0,"results":[]}`))
	}))
	defer server.Close()
	oldBase, oldClient := itunesSearchBase, outboundHTTPClient
	itunesSearchBase = server.URL
	defer func() { itunesSearchBase, outboundHTTPClient = oldBase, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, ok := a.scrapeAudioArtistItunes(ctx, "节流歌手"); !ok {
			t.Fatalf("call %d should succeed", i)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

/* v0.9.56：合作演唱曲目（「周杰伦 feat. 费玉清」）整串检索在 iTunes 无结果 ——
   scrapeAudio 必须用主歌手再试一次，否则整首歌刮削失败只剩文件名展示。 */
func TestAudioMetadataRetriesWithLeadArtist(t *testing.T) {
	var terms []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		term := r.URL.Query().Get("term")
		terms = append(terms, term)
		if strings.Contains(term, "feat") {
			w.Write([]byte(`{"resultCount":0,"results":[]}`))
			return
		}
		w.Write([]byte(`{"resultCount":1,"results":[{"trackName":"千里之外","artistName":"周杰倫","collectionName":"依然范特西","artworkUrl100":"https://art.example/100x100bb.jpg"}]}`))
	}))
	defer server.Close()
	oldBase, oldClient := itunesSearchBase, outboundHTTPClient
	itunesSearchBase = server.URL
	defer func() { itunesSearchBase, outboundHTTPClient = oldBase, oldClient }()
	outboundHTTPClient = func(string) (*http.Client, error) { return server.Client(), nil }

	a := &App{}
	out, err := a.scrapeAudio(context.Background(), "千里之外", "周杰伦 feat. 费玉清")
	if err != nil {
		t.Fatalf("lead-artist retry should hit: %v", err)
	}
	if out.Provider != "iTunes" || out.Album != "依然范特西" || !strings.Contains(out.Cover, "600x600bb") {
		t.Fatalf("unexpected result %+v", out)
	}
	if len(terms) < 2 {
		t.Fatalf("expected a retry with the lead artist, terms=%v", terms)
	}
	if !strings.Contains(terms[0], "feat") {
		t.Fatalf("first attempt should use the full artist string, terms=%v", terms)
	}
	last := terms[len(terms)-1]
	if strings.Contains(last, "feat") || !strings.Contains(last, "周杰伦") {
		t.Fatalf("retry should query the lead artist only, term=%q", last)
	}
}

/* v0.9.56：itunesPick 择优 —— 真实 iTunes 对「周杰伦 千里之外」返回 5 条，
   其中标题完全相等的是翻唱版「雨天 & 楊蔓」，而正确条目标题带 (feat. 費玉清)。
   旧实现取「标题完全相等」的首条 → 整首歌被翻唱专辑《世間情歌》抢走。 */
func TestItunesPickPrefersArtistMatchOverExactTitle(t *testing.T) {
	tracks := []itunesTrack{
		{TrackName: "千里之外 (feat. 費玉清)", ArtistName: "周杰倫", CollectionName: "依然范特西", ArtworkURL100: "https://art.example/a/100x100bb.jpg"},
		{TrackName: "千里之外 (Live)", ArtistName: "費玉清 & 周杰倫", CollectionName: "中國新歌聲 第7期"},
		{TrackName: "千里之外", ArtistName: "雨天 & 楊蔓", CollectionName: "世間情歌"},
		{TrackName: "千里之外", ArtistName: "康然 & 彭芳", CollectionName: "家"},
	}
	out, ok := itunesPick("千里之外", "周杰伦 feat. 费玉清", tracks)
	if !ok {
		t.Fatal("should pick a candidate")
	}
	if out.Album != "依然范特西" || out.Artist != "周杰倫" {
		t.Fatalf("wrong candidate picked: %+v", out)
	}
	// 未知歌手时无从校验歌手，仍按 iTunes 相关度取标题命中的首条（旧行为保留）
	out2, ok2 := itunesPick("千里之外", "未知歌手", tracks)
	if !ok2 || out2.Album != "依然范特西" {
		t.Fatalf("unknown-artist fallback changed: %+v ok=%v", out2, ok2)
	}
	// 歌手完全不匹配（本地标签写错）时，回落到标题完全相等的首条
	out3, ok3 := itunesPick("千里之外", "张三", tracks)
	if !ok3 || out3.Album != "世間情歌" {
		t.Fatalf("no-artist-match fallback should take the exact title: %+v ok=%v", out3, ok3)
	}
}
