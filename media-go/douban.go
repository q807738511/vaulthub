package main

import (
	"context"
	"encoding/json"
	stdhtml "html"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* VaultHub v1.0.2（需求5「加入豆瓣评分获取及展示」/ 需求4「综合 TMDB 及豆瓣评分推荐」）
   豆瓣评分服务端代理。

   为什么必须在服务端做：豆瓣没有 CORS 头，浏览器直连 movie.douban.com 一定被拦；
   旧实现（web/js/02-media.js 里直连 https://movie.douban.com/j/subject_suggest）
   在浏览器里必然失败，剧名/评分永远拿不到。这里由 media-go 出网取回，前端只调本站。

   两个上游：
     1. 搜索  https://movie.douban.com/j/subject_suggest?q=<片名>
        → [{id,title,year,type,img}]，type 是 movie / tv；
     2. 详情  https://m.douban.com/rexxar/api/v2/{movie|tv}/<豆瓣id>?for_mobile=1
        → rating.value / rating.count（不需要 API Key，靠 UA + Referer 通过）。

   对外接口（都要登录态，与 /api/media/tmdb 一致）：
     GET  /api/media/douban?query=<片名>&year=<年>&type=series|movie
     POST /api/media/douban/batch   {"items":[{"title":..,"year":..,"type":..}, …]}
   命中结果按「类型|片名|年份」缓存 24 小时（内存 + 单飞），同一部剧不会反复外呼。 */

type doubanHit struct {
	Match     bool    `json:"match"`
	ID        string  `json:"id,omitempty"`
	Title     string  `json:"title,omitempty"`
	Year      string  `json:"year,omitempty"`
	Rating    float64 `json:"rating"`
	Votes     int     `json:"votes,omitempty"`
	Type      string  `json:"type,omitempty"`
	URL       string  `json:"url,omitempty"`
	Poster    string  `json:"poster,omitempty"`
	MatchNote string  `json:"match_note,omitempty"`
	Error     string  `json:"error,omitempty"`
	Cached    bool    `json:"cached,omitempty"`
}

type doubanCacheEntry struct {
	hit doubanHit
	at  time.Time
}

var (
	doubanCacheMu sync.Mutex
	doubanCache   = map[string]doubanCacheEntry{}
	/* 单飞：同一个 key 并发只外呼一次（剧集详情与推荐批量可能同时要同一部剧）。 */
	doubanInflight = map[string]*sync.WaitGroup{}
)

const (
	doubanCacheTTL   = 24 * time.Hour
	doubanRetryTTL   = 10 * time.Minute
	doubanMaxBatch   = 24
	doubanSearchURL  = "https://movie.douban.com/j/subject_suggest?q="
	doubanRexxarBase = "https://m.douban.com/rexxar/api/v2/"
	doubanUA         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
	doubanReferer    = "https://movie.douban.com/"
	/* 备用搜索通道：suggest 被限流时改走移动搜索页 */
	doubanMobileSearchURL = "https://m.douban.com/search/?query="
	doubanMobileUA        = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	doubanMobileReferer   = "https://m.douban.com/"
)

type doubanSuggestItem struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Year     string `json:"year"`
	Type     string `json:"type"`
	Img      string `json:"img"`
	SubTitle string `json:"sub_title"`
	/* 移动搜索页自带的评分（data-rating=97.0 → 9.7）。仅内部兜底用，不外发。 */
	Rating float64 `json:"-"`
}

type doubanRexxarDetail struct {
	Title  string `json:"title"`
	Year   string `json:"year"`
	Type   string `json:"type"`
	URL    string `json:"url"`
	Rating struct {
		Value float64 `json:"value"`
		Count int     `json:"count"`
	} `json:"rating"`
	Pic struct {
		Normal string `json:"normal"`
		Large  string `json:"large"`
	} `json:"pic"`
}

type doubanUpstreamError struct {
	status int
	body   string
}

func (e *doubanUpstreamError) Error() string {
	msg := e.body
	if len(msg) > 160 {
		msg = msg[:160]
	}
	return "HTTP " + strconv.Itoa(e.status) + " " + msg
}

/* 归一化：去空白/标点，全角转半角，统一小写 —— 只用于片名比对。 */
func doubanNormTitle(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			r = r - 0xFEE0
		case r == 0x3000:
			r = ' '
		}
		if strings.ContainsRune(" \t-_\u00b7\u30fb:\uff1a!\uff01?\uff1f,\uff0c.\u3002'\"\u300a\u300b()\uff08\uff09[]\u3010\u3011\u301c~", r) {
			continue
		}
		if r >= 'A' && r <= 'Z' {
			r = r + 32
		}
		b.WriteRune(r)
	}
	return b.String()
}

func doubanKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "series", "tv", "show", "anime":
		return "tv"
	case "movie", "film":
		return "movie"
	}
	return ""
}

func doubanCacheKey(kind, title, year string) string {
	return kind + "|" + doubanNormTitle(title) + "|" + strings.TrimSpace(year)
}

func doubanCached(key string) (doubanHit, bool) {
	doubanCacheMu.Lock()
	defer doubanCacheMu.Unlock()
	e, ok := doubanCache[key]
	if !ok || time.Since(e.at) > doubanCacheTTL {
		return doubanHit{}, false
	}
	hit := e.hit
	hit.Cached = true
	return hit, true
}

func doubanStore(key string, hit doubanHit) {
	doubanCacheMu.Lock()
	defer doubanCacheMu.Unlock()
	if !hit.Match {
		/* 失败结果只记 10 分钟：一次网络抖动不该把一部剧锁死一整天。 */
		doubanCache[key] = doubanCacheEntry{hit: hit, at: time.Now().Add(doubanCacheTTL - doubanRetryTTL)}
		return
	}
	doubanCache[key] = doubanCacheEntry{hit: hit, at: time.Now()}
}

/*
豆瓣的出口顺序：**先直连**，直连不通才回落刮削代理。

	实测（生产环境）：配了走境外出口的 SCRAPER_PROXY（Clash 类代理）时，
	movie.douban.com 的 TLS 连接被直接重置（Go 侧报 EOF），豆瓣分永远取不到；
	同一容器里 curl 直连正常。豆瓣是国内站，直连既快又不被拦，代理只作为兜底。
*/
func (a *App) doubanClients() []*http.Client {
	a.mu.RLock()
	proxy := strings.TrimSpace(a.scraperProxy)
	a.mu.RUnlock()
	var out []*http.Client
	if c, err := outboundHTTPClient(""); err == nil {
		out = append(out, c)
	}
	if proxy != "" {
		if c, err := outboundHTTPClient(proxy); err == nil {
			out = append(out, c)
		}
	}
	return out
}

func (a *App) doubanGetJSON(client *http.Client, raw string, out any, limit int64) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", doubanUA)
	req.Header.Set("Referer", doubanReferer)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, limit))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return &doubanUpstreamError{status: res.StatusCode, body: strings.TrimSpace(string(body))}
	}
	return json.Unmarshal(body, out)
}

/* ---------- 备用搜索通道：m.douban.com 移动搜索页 ----------
   j/subject_suggest 被短时间内反复调用会被豆瓣限流：HTTP 200 但返回空数组 []，
   表现是「明明有豆瓣条目却永远查不到分」。移动搜索页走另一套网关，限流窗口不同，
   即使 suggest 空也能拿到「条目 id / 片名 / 海报 / 页面自带评分」。
   页面结构（2026-10 实测）：
     <span class="search-results-modules-name">电影</span>
     <ul class="search_results_subjects">
       <li><a href="/movie/subject/1292052/"><img src="…"/>
           <div class="subject-info"><span class="subject-title">肖申克的救赎</span>
             <p class="rating"><span class="rating-stars" data-rating="97.0">…</span><span>9.7</span></p>
           </div></a></li>
     </ul>
   只认「电影 / 电视剧 / 综艺 / 动漫」模块，其余（图书 / 音乐 / 小组 / 用户…）一律忽略。 */

var (
	doubanMobileModuleRe = regexp.MustCompile(`class="search-results-modules-name">([^<]*)<`)
	doubanMobileULRe     = regexp.MustCompile(`(?s)class="search_results_subjects">(.*?)</ul>`)
	doubanMobileItemRe   = regexp.MustCompile(`(?s)<a[^>]*href="[^"]*?/subject/([0-9]+)/?"[^>]*>(.*?)</a>`)
	doubanMobileTitleRe  = regexp.MustCompile(`(?s)class="subject-title">([^<]*)<`)
	doubanMobileImgRe    = regexp.MustCompile(`<img src="([^"]+)"`)
	doubanMobileRateRe   = regexp.MustCompile(`data-rating="([0-9]+(?:\.[0-9]+)?)"`)
)

func doubanMobileModuleKind(name string) string {
	switch strings.TrimSpace(name) {
	case "电影":
		return "movie"
	case "电视剧", "综艺", "动漫":
		return "tv"
	}
	return ""
}

/* 纯函数：把移动搜索页 HTML 解析成候选条目（便于单测）。 */
func parseDoubanMobileSearch(doc string) []doubanSuggestItem {
	marks := doubanMobileModuleRe.FindAllStringSubmatchIndex(doc, -1)
	var out []doubanSuggestItem
	for i, m := range marks {
		kind := doubanMobileModuleKind(doc[m[2]:m[3]])
		if kind == "" {
			continue
		}
		end := len(doc)
		if i+1 < len(marks) {
			end = marks[i+1][0]
		}
		ul := doubanMobileULRe.FindStringSubmatch(doc[m[1]:end])
		if ul == nil {
			continue
		}
		for _, it := range doubanMobileItemRe.FindAllStringSubmatch(ul[1], -1) {
			id := strings.TrimSpace(it[1])
			inner := it[2]
			title := ""
			if t := doubanMobileTitleRe.FindStringSubmatch(inner); t != nil {
				title = strings.TrimSpace(stdhtml.UnescapeString(t[1]))
			}
			if id == "" || title == "" {
				continue
			}
			item := doubanSuggestItem{ID: id, Title: title, Type: kind}
			if img := doubanMobileImgRe.FindStringSubmatch(inner); img != nil {
				item.Img = strings.TrimSpace(img[1])
			}
			if r := doubanMobileRateRe.FindStringSubmatch(inner); r != nil {
				if v, err := strconv.ParseFloat(r[1], 64); err == nil && v > 0 {
					if v > 10 {
						v = v / 10
					}
					item.Rating = math.Round(v*10) / 10
				}
			}
			out = append(out, item)
		}
	}
	return out
}

/*
片名拆候选：NFO / 文件夹常写成「黑鹰坠落 Black Hawk Down」这种中英混合串，

	整串丢给豆瓣一条也匹配不上（豆瓣条目名要么中文要么外文）。这里按分隔符拆词分组：
	中文段（豆瓣以中文条目为准，优先）→ 外文段。候选都来自这一部片自己的名字，
	不是拿别的片子顶替，匹配打分仍然是「片名一致才要」。
*/
func doubanTitleCandidates(title string) []string {
	t := strings.TrimSpace(title)
	if t == "" {
		return nil
	}
	out := []string{t}
	var han, latin []string
	for _, tok := range strings.FieldsFunc(t, func(r rune) bool {
		return r == ' ' || r == '\u3000' || r == '\u00b7' || r == '\u30fb' || r == '/' || r == '|' ||
			r == '_' || r == '-' || r == '\uff1a' || r == ':' || r == '\uff0c' || r == ',' || r == '(' || r == ')' ||
			r == '[' || r == ']' || r == '\u300a' || r == '\u300b'
	}) {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		isHan, hasLetter := false, false
		for _, r := range tok {
			switch {
			case r >= 0x3400 && r <= 0x9FFF:
				isHan = true
			case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
				hasLetter = true
			}
		}
		switch {
		case isHan:
			han = append(han, tok)
		case hasLetter:
			latin = append(latin, tok)
		}
	}
	if j := strings.Join(han, ""); j != "" && j != t {
		out = append(out, j)
	}
	if j := strings.Join(latin, " "); j != "" && j != t {
		out = append(out, j)
	}
	if len(out) > 3 {
		out = out[:3]
	}
	return out
}

func (a *App) doubanGetText(client *http.Client, raw, ua, referer string, limit int64) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Referer", referer)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, limit))
	if err != nil {
		return "", err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", &doubanUpstreamError{status: res.StatusCode, body: strings.TrimSpace(string(body))}
	}
	return string(body), nil
}

func (a *App) doubanSearchMobile(client *http.Client, title string) ([]doubanSuggestItem, error) {
	doc, err := a.doubanGetText(client, doubanMobileSearchURL+url.QueryEscape(title), doubanMobileUA, doubanMobileReferer, 3<<20)
	if err != nil {
		return nil, err
	}
	return parseDoubanMobileSearch(doc), nil
}

func (a *App) doubanSearch(client *http.Client, title string) ([]doubanSuggestItem, error) {
	var items []doubanSuggestItem
	if err := a.doubanGetJSON(client, doubanSearchURL+url.QueryEscape(title), &items, 1<<20); err != nil {
		return nil, err
	}
	return items, nil
}

func (a *App) doubanDetail(client *http.Client, id, kind string) (doubanRexxarDetail, error) {
	var d doubanRexxarDetail
	if kind != "tv" {
		kind = "movie"
	}
	raw := doubanRexxarBase + kind + "/" + url.PathEscape(id) + "?for_mobile=1"
	if err := a.doubanGetJSON(client, raw, &d, 2<<20); err != nil {
		return d, err
	}
	return d, nil
}

/*
打分选最佳匹配：片名完全相等 100 分，包含关系 60 分，年份命中 +25，类型命中 +15。

	低于 60 分视为没匹配上 —— 宁可不出分，也不要拿别的片子顶替（历史教训：
	一次错误匹配的剧名会被同步给整部剧，演职人员与推荐一起废掉）。
*/
func doubanBest(items []doubanSuggestItem, wantType, wantYear, title string) (doubanSuggestItem, string) {
	target := doubanNormTitle(title)
	type hitScore struct {
		item  doubanSuggestItem
		score int
	}
	var scored []hitScore
	for _, it := range items {
		name := doubanNormTitle(it.Title)
		if name == "" || target == "" {
			continue
		}
		score := 0
		switch {
		case name == target:
			score = 100
		case strings.Contains(name, target) || strings.Contains(target, name):
			score = 60
		default:
			continue
		}
		if wantYear != "" && strings.TrimSpace(it.Year) == strings.TrimSpace(wantYear) {
			score += 25
		}
		if wantType != "" && doubanKind(it.Type) == wantType {
			score += 15
		}
		scored = append(scored, hitScore{item: it, score: score})
	}
	if len(scored) == 0 {
		return doubanSuggestItem{}, ""
	}
	sort.SliceStable(scored, func(i, j int) bool { return scored[i].score > scored[j].score })
	best := scored[0]
	note := "片名一致"
	if best.score < 100 {
		note = "片名近似"
	}
	if wantYear != "" && strings.TrimSpace(best.item.Year) != "" && strings.TrimSpace(best.item.Year) != strings.TrimSpace(wantYear) {
		note += "·年份不同(" + best.item.Year + ")"
	}
	return best.item, note
}

func (a *App) lookupDouban(title, year, kind string) doubanHit {
	title = strings.TrimSpace(title)
	kind = doubanKind(kind)
	if title == "" {
		return doubanHit{Error: "empty query"}
	}
	if r := []rune(title); len(r) > 120 {
		title = string(r[:120])
	}
	key := doubanCacheKey(kind, title, year)
	if hit, ok := doubanCached(key); ok {
		return hit
	}
	doubanCacheMu.Lock()
	if wg, ok := doubanInflight[key]; ok {
		doubanCacheMu.Unlock()
		wg.Wait()
		if hit, ok := doubanCached(key); ok {
			return hit
		}
		return doubanHit{Title: title, Error: "并发查询未完成"}
	}
	wg := &sync.WaitGroup{}
	wg.Add(1)
	doubanInflight[key] = wg
	doubanCacheMu.Unlock()
	hit := a.fetchDouban(title, year, kind)
	doubanStore(key, hit)
	doubanCacheMu.Lock()
	delete(doubanInflight, key)
	doubanCacheMu.Unlock()
	wg.Done()
	return hit
}

func (a *App) fetchDouban(title, year, kind string) doubanHit {
	clients := a.doubanClients()
	if len(clients) == 0 {
		return doubanHit{Error: "outbound client: 不可用"}
	}
	var best doubanSuggestItem
	note, noteFallback := "", ""
	var serr error
candLoop:
	for i, cand := range doubanTitleCandidates(title) {
		for _, client := range clients {
			items, qerr := a.doubanSearch(client, cand)
			via := ""
			if len(items) == 0 {
				/* suggest 被限流时是「HTTP 200 + 空数组」，所以空结果同样要走备用通道。 */
				if mitems, merr := a.doubanSearchMobile(client, cand); merr == nil && len(mitems) > 0 {
					items, via = mitems, "·搜索页兜底"
				} else if qerr != nil {
					serr = qerr
				} else if merr != nil {
					serr = merr
				}
			}
			if len(items) == 0 {
				continue
			}
			b, n := doubanBest(items, kind, year, cand)
			if strings.TrimSpace(b.ID) == "" {
				/* 这个出口给了候选列表但没匹配上 → 不再换出口，换下一个候选串。 */
				break
			}
			best, note, noteFallback = b, n, via
			if i > 0 {
				note += "·按拆分片名取分(" + cand + ")"
			}
			break candLoop
		}
	}
	if strings.TrimSpace(best.ID) == "" {
		if serr != nil {
			return doubanHit{Error: "豆瓣搜索失败：" + serr.Error()}
		}
		return doubanHit{Title: title, MatchNote: "未命中"}
	}
	note += noteFallback
	var detail doubanRexxarDetail
	detailOK := false
	var derr error
	for _, client := range clients {
		d, e := a.doubanDetail(client, best.ID, firstNonEmpty(doubanKind(best.Type), kind))
		if e == nil {
			detail, detailOK = d, true
			derr = nil
			if d.Rating.Value > 0 {
				break
			}
			continue
		}
		if derr == nil {
			derr = e
		}
	}
	out := doubanHit{
		Match:     true,
		ID:        strings.TrimSpace(best.ID),
		Title:     strings.TrimSpace(firstNonEmpty(detail.Title, best.Title)),
		Year:      strings.TrimSpace(firstNonEmpty(detail.Year, best.Year)),
		Type:      strings.TrimSpace(firstNonEmpty(doubanKind(detail.Type), doubanKind(best.Type))),
		URL:       strings.TrimSpace(firstNonEmpty(detail.URL, "https://movie.douban.com/subject/"+best.ID+"/")),
		Poster:    strings.TrimSpace(firstNonEmpty(detail.Pic.Normal, detail.Pic.Large, best.Img)),
		MatchNote: note,
	}
	if detailOK && detail.Rating.Value > 0 {
		out.Rating = detail.Rating.Value
		out.Votes = detail.Rating.Count
		return out
	}
	/* 详情取不到（或条目暂无评分）时，用搜索页自带的评分兜底 —— 仍是豆瓣自己的数。 */
	if best.Rating > 0 {
		out.Rating = best.Rating
		out.MatchNote = note + "·评分取自搜索页"
		return out
	}
	if !detailOK && derr != nil {
		/* 搜索命中了、详情取不到、页面也没分：保留条目与链接，评分留 0（前端显示「暂缺」）。 */
		out.Error = "豆瓣详情失败：" + derr.Error()
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (a *App) douban(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "GET only")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("query"))
	if q == "" {
		errJSON(w, 400, "query is required")
		return
	}
	hit := a.lookupDouban(q, strings.TrimSpace(r.URL.Query().Get("year")), r.URL.Query().Get("type"))
	writeJSON(w, 200, hit)
}

type doubanBatchItem struct {
	Title string `json:"title"`
	Year  string `json:"year"`
	Type  string `json:"type"`
}

type doubanBatchRequest struct {
	Items []doubanBatchItem `json:"items"`
}

/*
批量取分：推荐列表一次要 8~12 条的豆瓣分，逐条发请求太慢 —— 这里并发 3 路，

	命中缓存直接返回。上限 24 条，超出的丢弃（前端也只传前 24 条）。
	返回值的 key 与前端传入的「类型|片名|年份」缓存键一致（前端用 doubanKeyOf 复算）。
*/
func (a *App) doubanBatch(w http.ResponseWriter, r *http.Request) {
	if !writeAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodPost {
		errJSON(w, 405, "POST only")
		return
	}
	var req doubanBatchRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 256<<10)).Decode(&req); err != nil {
		errJSON(w, 400, "invalid json")
		return
	}
	out := map[string]doubanHit{}
	if len(req.Items) == 0 {
		writeJSON(w, 200, map[string]any{"items": out})
		return
	}
	if len(req.Items) > doubanMaxBatch {
		req.Items = req.Items[:doubanMaxBatch]
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	for _, it := range req.Items {
		title := strings.TrimSpace(it.Title)
		if title == "" {
			continue
		}
		key := doubanCacheKey(doubanKind(it.Type), title, it.Year)
		wg.Add(1)
		go func(key, title, year, kind string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			hit := a.lookupDouban(title, year, kind)
			mu.Lock()
			out[key] = hit
			mu.Unlock()
		}(key, title, it.Year, it.Type)
	}
	wg.Wait()
	writeJSON(w, 200, map[string]any{"items": out})
}
