package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

/* v1.0.2 补丁单测：豆瓣 suggest 被限流（HTTP 200 + 空数组）时改走移动搜索页。
   下面的 HTML 按 2026-10 实测结构截取（去掉脚本/样式，保留模块名、条目、评分节点）。 */

const v1002MobileHTML = `<!DOCTYPE html><html><body>
<div class="search-bd">
  <ul class="search-results">
    <li class="search-module">
      <span class="search-results-modules-name">电影</span>
      <ul class="search_results_subjects">
        <li> <a href="/movie/subject/1292052/">
            <img src="https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2934829882.jpg"/>
          <div class="subject-info">
            <span class="subject-title">肖申克的救赎</span>
            <p class="rating"><span class="rating-stars" data-rating="97.0"><i></i></span><span>9.7</span></p>
          </div>
        </a> </li>
        <li> <a href="/movie/subject/35278770/">
            <img src="https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2722407675.jpg"/>
          <div class="subject-info"><span class="subject-title">正午阳光</span>
            <p class="rating"><span class="rating-stars" data-rating="0"></span><span>暂无评分</span></p>
          </div>
        </a> </li>
      </ul>
    </li>
    <li class="search-module">
      <span class="search-results-modules-name">电视剧</span>
      <ul class="search_results_subjects">
        <li> <a href="/movie/subject/26794435/">
            <img src="https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2558293338.jpg"/>
          <div class="subject-info"><span class="subject-title">东京喰种</span>
            <p class="rating"><span class="rating-stars" data-rating="81.0"></span><span>8.1</span></p>
          </div>
        </a> </li>
      </ul>
    </li>
    <li class="search-module">
      <span class="search-results-modules-name">图书</span>
      <ul class="search_results_subjects">
        <li> <a href="/book/subject/1084336/">
            <img src="https://img1.doubanio.com/x.jpg"/>
          <div class="subject-info"><span class="subject-title">肖申克的救赎（书）</span>
            <p class="rating"><span class="rating-stars" data-rating="92.0"></span><span>9.2</span></p>
          </div>
        </a> </li>
      </ul>
    </li>
  </ul>
</div></body></html>`

/* 按路径分流：suggest 空 / 移动搜索页 HTML / rexxar 详情（可指定状态码）。 */
func v1002MobileStub(hits *int, suggestBody, mobileBody, detailBody string, detailStatus int) func(string) (*http.Client, error) {
	return func(string) (*http.Client, error) {
		return &http.Client{Transport: v1002RoundTrip(func(r *http.Request) (*http.Response, error) {
			*hits++
			status, body := 200, suggestBody
			switch {
			case strings.Contains(r.URL.Path, "/search/"):
				body = mobileBody
			case strings.Contains(r.URL.Path, "/rexxar/"):
				body, status = detailBody, detailStatus
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

func v1002WithStub(t *testing.T, stub func(string) (*http.Client, error)) {
	t.Helper()
	v1002ResetDoubanCache()
	old := outboundHTTPClient
	outboundHTTPClient = stub
	t.Cleanup(func() { outboundHTTPClient = old })
}

func TestV1002ParseDoubanMobileSearch(t *testing.T) {
	items := parseDoubanMobileSearch(v1002MobileHTML)
	if len(items) != 3 {
		t.Fatalf("应解析出 3 条（电影 2 + 电视剧 1，图书忽略），得到 %d：%+v", len(items), items)
	}
	byTitle := map[string]doubanSuggestItem{}
	for _, it := range items {
		byTitle[it.Title] = it
	}
	if _, bad := byTitle["肖申克的救赎（书）"]; bad {
		t.Fatalf("图书模块不该被解析：%+v", items)
	}
	if it, ok := byTitle["肖申克的救赎"]; !ok || it.ID != "1292052" || it.Type != "movie" || it.Rating != 9.7 {
		t.Fatalf("电影条目解析错误：%+v", it)
	}
	if it := byTitle["肖申克的救赎"]; !strings.Contains(it.Img, "p2934829882.jpg") {
		t.Fatalf("海报未带出：%+v", it)
	}
	if it := byTitle["正午阳光"]; it.Rating != 0 {
		t.Fatalf("无评分条目不应编分：%+v", it)
	}
	if it, ok := byTitle["东京喰种"]; !ok || it.ID != "26794435" || it.Type != "tv" || it.Rating != 8.1 {
		t.Fatalf("电视剧条目解析错误：%+v", it)
	}
}

func TestV1002DoubanMobileFallbackWhenSuggestEmpty(t *testing.T) {
	hits := 0
	detail := `{"title":"东京喰种","year":"2014","type":"tv","url":"https://movie.douban.com/subject/26794435/","rating":{"value":8.1,"count":58321},"pic":{"normal":"https://img/n.jpg"}}`
	v1002WithStub(t, v1002MobileStub(&hits, `[]`, v1002MobileHTML, detail, 200))

	a := &App{}
	hit := a.lookupDouban("东京喰种", "2014", "series")
	if !hit.Match || hit.ID != "26794435" {
		t.Fatalf("suggest 空时应从移动搜索页兜底命中：%+v", hit)
	}
	if hit.Rating != 8.1 || hit.Votes != 58321 {
		t.Fatalf("详情分应覆盖页面分：%+v", hit)
	}
	if !strings.Contains(hit.MatchNote, "搜索页兜底") {
		t.Fatalf("命中说明应标注兜底来源：%q", hit.MatchNote)
	}
}

func TestV1002DoubanMobileRatingWhenDetailFails(t *testing.T) {
	hits := 0
	v1002WithStub(t, v1002MobileStub(&hits, `[]`, v1002MobileHTML, `{"msg":"invalid_request_1284"}`, 400))

	a := &App{}
	hit := a.lookupDouban("东京喰种", "2014", "series")
	if !hit.Match || hit.ID != "26794435" {
		t.Fatalf("详情失败时应保留条目：%+v", hit)
	}
	if hit.Rating != 8.1 {
		t.Fatalf("详情失败时应用搜索页评分 8.1，得到 %v", hit.Rating)
	}
	if hit.Error != "" {
		t.Fatalf("有分兜底时不应报错：%+v", hit)
	}
	if !strings.Contains(hit.MatchNote, "评分取自搜索页") {
		t.Fatalf("应标注评分来源：%q", hit.MatchNote)
	}
	if hit.URL == "" || hit.Poster == "" {
		t.Fatalf("链接与封面应回填：%+v", hit)
	}
}

func TestV1002DoubanSuggestStillPrefersPrimary(t *testing.T) {
	hits := 0
	suggest := `[{"id":"1292052","title":"肖申克的救赎","year":"1994","type":"movie","img":"https://img/x.jpg"}]`
	detail := `{"title":"肖申克的救赎","year":"1994","type":"movie","url":"https://movie.douban.com/subject/1292052/","rating":{"value":9.7,"count":3350810},"pic":{"normal":"https://img/n.jpg"}}`
	v1002WithStub(t, v1002MobileStub(&hits, suggest, v1002MobileHTML, detail, 200))

	a := &App{}
	hit := a.lookupDouban("肖申克的救赎", "1994", "movie")
	if !hit.Match || hit.Rating != 9.7 {
		t.Fatalf("suggest 正常时不该走兜底：%+v", hit)
	}
	if strings.Contains(hit.MatchNote, "搜索页兜底") {
		t.Fatalf("suggest 命中不该标兜底：%q", hit.MatchNote)
	}
	if hits != 2 {
		t.Fatalf("suggest 命中应只外呼 2 次（搜索+详情），得到 %d", hits)
	}
}

func TestV1002DoubanMobileFallbackNoMatch(t *testing.T) {
	hits := 0
	v1002WithStub(t, v1002MobileStub(&hits, `[]`, v1002MobileHTML, `{}`, 200))

	a := &App{}
	hit := a.lookupDouban("完全不存在的片子XYZQ", "", "movie")
	if hit.Match {
		t.Fatalf("页面里没有的片名不该命中：%+v", hit)
	}
	if hit.MatchNote != "未命中" {
		t.Fatalf("未命中说明应为「未命中」：%q", hit.MatchNote)
	}
}
