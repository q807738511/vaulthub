package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

/* v0.9.97：多季剧集刮削的服务端入口。
 *
 *   GET /api/media/series/plan?lib=<库ID>
 *       返回整库的 Plex 口径多季方案：剧 → 季（含特别篇 Season 00）→ 集，
 *       每集带合规判定 / 中文问题清单 / 建议规范路径；另有全库诊断汇总。
 *       这是「命名体检」与前端季集展示的唯一数据来源，避免前端各自猜规则。
 *
 *   GET /api/media/series/missing?lib=<库ID>&dir=<剧根目录>[&tmdb=<TMDB ID>][&title=<剧名>]
 *       逐季拉取 TMDB 的官方集数，与本地已有集号比对 → 缺失集清单
 *       （对应指南里的 PlexMissingEpisodes：批量校验缺季缺集）。
 *       TMDB 未配置或某季在 TMDB 不存在时如实返回 official_count=0（不猜）。
 *
 * 两个端点都要求登录会话（readAuth），与其它媒体读接口一致。
 */

// seriesPlanResponse 是多季方案的接口响应。
type seriesPlanResponse struct {
	OK    bool      `json:"ok"`
	Lib   string    `json:"lib"`
	Plan  *plexPlan `json:"plan"`
	Notes []string  `json:"notes"`
}

/* seriesPlan 输出整库的多季方案。文件清单直接读索引表，不重新遍历磁盘 ——
   与列表页看到的条目完全一致（索引没扫到的文件不会凭空出现在诊断里）。 */
func (a *App) seriesPlan(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("lib"))
	if id == "" {
		errJSON(w, 400, "lib is required")
		return
	}
	lib, ok := a.find(id)
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	rows, err := a.db.Query(`SELECT path FROM files WHERE lib=? ORDER BY path`, lib.ID)
	if err != nil {
		errJSON(w, 500, "index query failed")
		return
	}
	defer rows.Close()
	paths := []string{}
	for rows.Next() {
		var p string
		if e := rows.Scan(&p); e != nil {
			errJSON(w, 500, "index scan failed")
			return
		}
		paths = append(paths, p)
	}
	if e := rows.Err(); e != nil {
		errJSON(w, 500, "index read failed")
		return
	}
	plan := plexPlanFromPaths(paths)
	notes := []string{}
	if lib.Type != "series" {
		notes = append(notes, "该库类型不是「剧集」，方案只统计符合剧集命名（季目录或 sXXeYY 标记）的条目。")
	}
	if plan.IssueNum > 0 {
		notes = append(notes, fmt.Sprintf("发现 %d 条不符合 Plex 命名规范的条目，已给出建议路径；改名后重扫即可回到规范结构。", plan.IssueNum))
	}
	if plan.MultiSeasonNum > 0 {
		notes = append(notes, fmt.Sprintf("识别到 %d 部多季剧集，季目录优先于文件名里的季号（Plex 口径）。", plan.MultiSeasonNum))
	}
	writeJSON(w, 200, seriesPlanResponse{OK: true, Lib: lib.ID, Plan: plan, Notes: notes})
}

// seriesMissingResponse 是缺失集比对的接口响应。
type seriesMissingResponse struct {
	OK            bool               `json:"ok"`
	Lib           string             `json:"lib"`
	Show          string             `json:"show"`
	Year          string             `json:"year"`
	Dirs          []string           `json:"dirs"`
	TMDB          string             `json:"tmdb"`
	Seasons       []plexSeasonMissing `json:"seasons"`
	MissingTotal  int                `json:"missing_total"`
	Complete      bool               `json:"complete"`
	Notes         []string           `json:"notes"`
}

/* seriesMissing 逐季比对官方集数。季号来源是本地方案（不是猜的），
   官方集数来自 TMDB 的 tv/{id}/season/{n}；TMDB 明确没有该季时按未知处理。 */
func (a *App) seriesMissing(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	q := r.URL.Query()
	id := strings.TrimSpace(q.Get("lib"))
	if id == "" {
		errJSON(w, 400, "lib is required")
		return
	}
	lib, ok := a.find(id)
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	tmdbID := strings.TrimSpace(q.Get("tmdb"))
	if tmdbID != "" {
		if _, e := strconv.ParseInt(tmdbID, 10, 64); e != nil {
			errJSON(w, 400, "invalid TMDB id")
			return
		}
	}
	rows, err := a.db.Query(`SELECT path FROM files WHERE lib=? ORDER BY path`, lib.ID)
	if err != nil {
		errJSON(w, 500, "index query failed")
		return
	}
	defer rows.Close()
	paths := []string{}
	for rows.Next() {
		var p string
		if e := rows.Scan(&p); e != nil {
			errJSON(w, 500, "index scan failed")
			return
		}
		paths = append(paths, p)
	}
	plan := plexPlanFromPaths(paths)
	show := plexFindShow(plan, strings.TrimSpace(q.Get("key")), strings.TrimSpace(q.Get("dir")), strings.TrimSpace(q.Get("title")))
	if show == nil {
		errJSON(w, 404, "show not found in index")
		return
	}
	resp := seriesMissingResponse{OK: true, Lib: lib.ID, Show: show.Title, Year: show.Year, Dirs: show.Dirs, TMDB: tmdbID, Notes: []string{}}
	official := map[int]int{}
	if tmdbID == "" {
		resp.Notes = append(resp.Notes, "未指定 TMDB ID：只能列出本地集号，无法比对官方集数。先在剧集卡片上完成刮削匹配，或手工填 TMDB ID。")
	} else {
		a.mu.RLock()
		hasKey := a.tmdbAPIKey != ""
		a.mu.RUnlock()
		if !hasKey {
			resp.Notes = append(resp.Notes, "服务端未配置 TMDB_API_KEY：缺失集比对需要联网查官方集数，已跳过（本地集号仍完整列出）。")
		} else {
			ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
			defer cancel()
			failed := []string{}
			for _, season := range show.Seasons {
				nums, maxNum, e := a.tmdbSeasonEpisodeNumbers(ctx, tmdbID, season.Season)
				if e != nil {
					failed = append(failed, fmt.Sprintf("%s（%v）", season.Tag, e))
					continue
				}
				if len(nums) == 0 && maxNum <= 0 {
					/* TMDB 明确没有这一季：不当作「本地多出」，也不编造官方集数。 */
					resp.Notes = append(resp.Notes, fmt.Sprintf("TMDB 上没有 %s 这一季的数据（可能是特别季或季号错配）。", season.Tag))
					continue
				}
				official[season.Season] = maxNum
			}
			if len(failed) > 0 {
				resp.Notes = append(resp.Notes, "以下季查询 TMDB 失败："+strings.Join(failed, "；"))
			}
		}
	}
	resp.Seasons = plexSeasonMissingReport(show, official)
	for _, s := range resp.Seasons {
		resp.MissingTotal += len(s.Missing)
	}
	resp.Complete = resp.MissingTotal == 0 && len(resp.Seasons) > 0
	writeJSON(w, 200, resp)
}

/* tmdbSeasonEpisodeNumbers 取某一季的官方集号列表与最大集号。
   最大集号当作「官方集数」比 len(episodes) 稳健：TMDB 偶尔把 0 集（特别篇占位）
   也算进数组里，会导致误报缺集。返回 error 时调用方按「未知」处理，不猜。 */
func (a *App) tmdbSeasonEpisodeNumbers(ctx context.Context, tmdbID string, season int) ([]int, int, error) {
	a.mu.RLock()
	key, base, proxy := a.tmdbAPIKey, a.tmdbAPIBase, a.scraperProxy
	a.mu.RUnlock()
	if key == "" {
		return nil, 0, fmt.Errorf("TMDB_API_KEY 未配置")
	}
	if season < 0 || season > 99 {
		return nil, 0, fmt.Errorf("季号非法")
	}
	lang := "zh-CN"
	a.mu.RLock()
	region := a.scrapeRegion
	a.mu.RUnlock()
	if l := scrapeRegionLanguage(region); l != "" {
		lang = l
	}
	u := strings.TrimRight(base, "/") + "/tv/" + url.PathEscape(tmdbID) + "/season/" + strconv.Itoa(season) + "?language=" + url.QueryEscape(lang)
	if !tmdbIsBearerToken(key) {
		u += "&api_key=" + url.QueryEscape(key)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("请求构造失败")
	}
	if tmdbIsBearerToken(key) {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("Accept", "application/json")
	client, cerr := outboundHTTPClient(proxy)
	if cerr != nil {
		return nil, 0, fmt.Errorf("代理不可用")
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("网络不可达")
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return nil, 0, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, 0, fmt.Errorf("TMDB HTTP %d", res.StatusCode)
	}
	var payload struct {
		Episodes []struct {
			EpisodeNumber int `json:"episode_number"`
		} `json:"episodes"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, 0, fmt.Errorf("TMDB 返回不可解析")
	}
	nums := []int{}
	maxNum := 0
	for _, ep := range payload.Episodes {
		if ep.EpisodeNumber > 0 {
			nums = append(nums, ep.EpisodeNumber)
			if ep.EpisodeNumber > maxNum {
				maxNum = ep.EpisodeNumber
			}
		}
	}
	sort.Ints(nums)
	return nums, maxNum, nil
}
