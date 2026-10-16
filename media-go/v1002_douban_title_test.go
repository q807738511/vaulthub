package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

/* v1.0.2 补丁单测：混合中英片名（NFO 常写「黑鹰坠落 Black Hawk Down」）拆候选再查豆瓣。
   整串丢给豆瓣一条也匹配不上，拆出中文段后可正常取分；候选都来自同一部片的名字，
   仍然是「片名一致才要」，不拿别的片子顶替。 */

func TestV1002DoubanTitleCandidates(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"黑鹰坠落 Black Hawk Down", []string{"黑鹰坠落 Black Hawk Down", "黑鹰坠落", "Black Hawk Down"}},
		{"黑鹰坠落", []string{"黑鹰坠落"}},
		{"Spirited Away 千与千寻", []string{"Spirited Away 千与千寻", "千与千寻", "Spirited Away"}},
		{"  东京喰种  ", []string{"东京喰种"}},
		{"", nil},
	}
	for _, c := range cases {
		got := doubanTitleCandidates(c.in)
		if len(got) != len(c.want) {
			t.Fatalf("doubanTitleCandidates(%q) = %v，期望 %v", c.in, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("doubanTitleCandidates(%q) = %v，期望 %v", c.in, got, c.want)
			}
		}
	}
}

/* 查询串敏感的桩：整串查不到、中文段能查到（实测形态）。 */
func v1002TitleStub(seen *[]string, suggest map[string]string, detail string) func(string) (*http.Client, error) {
	return func(string) (*http.Client, error) {
		return &http.Client{Transport: v1002RoundTrip(func(r *http.Request) (*http.Response, error) {
			q := r.URL.Query().Get("q")
			if q == "" {
				q = r.URL.Query().Get("query")
			}
			*seen = append(*seen, q)
			body, status := `[]`, 200
			switch {
			case strings.Contains(r.URL.Path, "/rexxar/"):
				body = detail
			case strings.Contains(r.URL.Path, "/search/"):
				body = v1002MobileHTML
			default:
				if b, ok := suggest[q]; ok {
					body = b
				}
			}
			return &http.Response{
				StatusCode: status,
				Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
				Body:       io.NopCloser(strings.NewReader(body)),
				Request:    r,
				Status:     "x",
			}, nil
		})}, nil
	}
}

const v1002BlackHawkDetail = `{"title":"黑鹰坠落","year":"2001","type":"movie","url":"https://movie.douban.com/subject/1291824/","rating":{"value":8.7,"count":165432},"pic":{"normal":"https://img/n.jpg"}}`

func TestV1002DoubanMixedTitleSplitLookup(t *testing.T) {
	seen := []string{}
	v1002WithStub(t, v1002TitleStub(&seen, map[string]string{
		"黑鹰坠落": `[{"id":"1291824","title":"黑鹰坠落","year":"2001","type":"movie","img":"https://img/x.jpg"}]`,
	}, v1002BlackHawkDetail))

	a := &App{}
	hit := a.lookupDouban("黑鹰坠落 Black Hawk Down", "2001", "movie")
	if !hit.Match || hit.ID != "1291824" {
		t.Fatalf("中英混合片名应拆出中文段命中：%+v（查了 %v）", hit, seen)
	}
	if hit.Rating != 8.7 || hit.Votes != 165432 {
		t.Fatalf("评分/票数不对：%+v", hit)
	}
	if !strings.Contains(hit.MatchNote, "按拆分片名取分") {
		t.Fatalf("应标注按拆分片名取分：%q", hit.MatchNote)
	}
	if len(seen) == 0 || seen[0] != "黑鹰坠落 Black Hawk Down" {
		t.Fatalf("应先查整串：%v", seen)
	}
}

func TestV1002DoubanMixedTitleFallsToLatinCandidate(t *testing.T) {
	seen := []string{}
	v1002WithStub(t, v1002TitleStub(&seen, map[string]string{
		"Black Hawk Down": `[{"id":"1291824","title":"Black Hawk Down","year":"2001","type":"movie","img":"https://img/x.jpg"}]`,
	}, v1002BlackHawkDetail))

	a := &App{}
	hit := a.lookupDouban("黑鹰坠落 Black Hawk Down", "2001", "movie")
	if !hit.Match || hit.ID != "1291824" || hit.Rating != 8.7 {
		t.Fatalf("中文段未命中时应继续试外文段：%+v（查了 %v）", hit, seen)
	}
	var uniq []string
	for _, q := range seen {
		if q == "" {
			continue
		}
		if len(uniq) == 0 || uniq[len(uniq)-1] != q {
			uniq = append(uniq, q)
		}
	}
	if len(uniq) != 3 || uniq[0] != "黑鹰坠落 Black Hawk Down" || uniq[1] != "黑鹰坠落" || uniq[2] != "Black Hawk Down" {
		t.Fatalf("候选顺序应为 整串 → 中文段 → 外文段：%v（原始 %v）", uniq, seen)
	}
}

func TestV1002DoubanSingleTitleNoExtraQuery(t *testing.T) {
	seen := []string{}
	v1002WithStub(t, v1002TitleStub(&seen, map[string]string{
		"肖申克的救赎": `[{"id":"1292052","title":"肖申克的救赎","year":"1994","type":"movie","img":"https://img/x.jpg"}]`,
	}, `{"title":"肖申克的救赎","year":"1994","type":"movie","url":"https://movie.douban.com/subject/1292052/","rating":{"value":9.7,"count":3350810},"pic":{"normal":"https://img/n.jpg"}}`))

	a := &App{}
	hit := a.lookupDouban("肖申克的救赎", "1994", "movie")
	if !hit.Match || hit.Rating != 9.7 {
		t.Fatalf("纯中文片名应一次命中：%+v", hit)
	}
	if strings.Contains(hit.MatchNote, "按拆分片名取分") {
		t.Fatalf("单段片名不该标注拆分：%q", hit.MatchNote)
	}
	if len(seen) != 2 {
		t.Fatalf("应只查搜索+详情两次：%v", seen)
	}
}
