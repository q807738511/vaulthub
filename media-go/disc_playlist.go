package main

import (
	"context"
	"net/http"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* ==================== v0.9.98：原盘（BDMV / ISO）播放菜单 ====================
客户要求：「优化 bdmv/ISO 等原盘刮削播放，增加针对 BDMV 文件的播放菜单选择
（刮削后将文件从多个项目变成单个项目，然后通过加入播放菜单选择进行选择播放），
针对原盘播放，在播放器中增加媒体菜单选项进行选择」。

实测结论（真实《黑鹰坠落》BDMV，容器内 ffmpeg 7.1.5 + libbluray）：
  · `ffprobe -v info bluray:<原盘根或ISO>` 时 libbluray 会把**整盘可用播放列表**
    打到 stderr，形如：

         [bluray @ 0x…] 8 usable playlists:
         [bluray @ 0x…] playlist 00012.mpls (2:29:17)
         [bluray @ 0x…] playlist 00004.mpls (2:23:42)
         [bluray @ 0x…] selected 00012.mpls

    所以**不需要自己解析 .mpls 二进制**（结构复杂、版本多），直接读这段日志即可拿到
    「有哪些标题 + 每个多长」，且对 BDMV 目录与蓝光 ISO 是同一段代码路径。
  · 指定标题播放：`ffprobe/ffmpeg -playlist <N> bluray:<原盘>`（协议级 AVOption，
    实测 `-playlist 4` 得到 8656s = 00004.mpls 的 2:24:16，与日志一致）。
  · DVD 镜像（VIDEO_TS）：`-f dvdvideo -title <N>`（解复用器 AVOption），
    实测 `-title 1` 给出时长、`-title 2` 返回 “Title 2 not found”，据此可枚举标题。

主影片判定：**时长最长的那个**（libbluray 的 selected 只作为「默认」提示一起返回）。
原盘里常见的「主影片 + 预告/花絮/不同剪辑版」因此一眼可辨。
*/

type discPlaylistEntry struct {
	Index        int     `json:"index"`
	Kind         string  `json:"kind"` // playlist（蓝光）/ title（DVD）
	Ref          int     `json:"ref"`  // -playlist N / -title N
	File         string  `json:"file,omitempty"`
	Label        string  `json:"label"`
	Seconds      float64 `json:"seconds"`
	DurationText string  `json:"duration_text"`
	Main         bool    `json:"main"`
	Selected     bool    `json:"selected"`
}

type discPlaylistInfo struct {
	OK        bool                `json:"ok"`
	Kind      string              `json:"kind"` // bluray / dvd / none
	DiscRoot  string              `json:"disc_root,omitempty"`
	DiscTitle string              `json:"disc_title,omitempty"`
	Selected  int                 `json:"selected,omitempty"`
	Items     []discPlaylistEntry `json:"items"`
	Notes     []string            `json:"notes,omitempty"`
}

const discPlaylistTTL = 10 * time.Minute

var (
	discPlaylistCache sync.Map // key: <abs>|<size>|<mtime> → discPlaylistCacheEntry
	discPlaylistRun   = func(ctx context.Context, args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "ffprobe", args...)
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
)

type discPlaylistCacheEntry struct {
	Info discPlaylistInfo
	At   time.Time
}

var (
	discPlaylistLineRe = regexp.MustCompile(`playlist (\d{5})\.mpls \((\d+):(\d{2}):(\d{2})\)`)
	discSelectedLineRe = regexp.MustCompile(`selected (\d{5})\.mpls`)
	discDurationOutRe  = regexp.MustCompile(`duration=([0-9.]+)`)
)

/* discPlaylistsFromLog 解析 libbluray 打印的播放列表清单。
   输入是 ffprobe 的合并输出（日志在 stderr，探测结果在 stdout，一起喂进来即可）。 */
func discPlaylistsFromLog(log string) ([]discPlaylistEntry, int) {
	items := []discPlaylistEntry{}
	selected := 0
	for _, line := range strings.Split(log, "\n") {
		if m := discPlaylistLineRe.FindStringSubmatch(line); m != nil {
			hours, _ := strconv.Atoi(m[2])
			mins, _ := strconv.Atoi(m[3])
			secs, _ := strconv.Atoi(m[4])
			total := float64(hours*3600 + mins*60 + secs)
			items = append(items, discPlaylistEntry{
				Kind:         "playlist",
				Ref:          atoiSafe(m[1]),
				File:         m[1] + ".mpls",
				Seconds:      total,
				DurationText: discDurationText(total),
			})
		}
		if m := discSelectedLineRe.FindStringSubmatch(line); m != nil {
			selected = atoiSafe(m[1])
		}
	}
	return items, selected
}

/* discDurationsFromOutput 从 `-show_entries format=duration` 的输出里取时长。 */
func discDurationsFromOutput(out string) float64 {
	if m := discDurationOutRe.FindStringSubmatch(out); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil && v > 0 {
			return v
		}
	}
	return 0
}

func atoiSafe(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

/* discDurationText 时长文本（与 libbluray 日志口径一致：H:MM:SS）。 */
func discDurationText(sec float64) string {
	if sec <= 0 {
		return ""
	}
	total := int(sec + 0.5)
	h := total / 3600
	m := (total % 3600) / 60
	s := total % 60
	return strconv.Itoa(h) + ":" + pad2(m) + ":" + pad2(s)
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

/* discPlaylistLabel 给条目起一个人话名字：主影片 / 标题 N（含时长）。 */
func discPlaylistLabel(main bool, ref int, seconds float64) string {
	if main {
		return "主影片"
	}
	if seconds > 0 {
		return "标题 " + strconv.Itoa(ref)
	}
	return "标题 " + strconv.Itoa(ref)
}

/* finalizeDiscPlaylists 排序 + 标记主影片（最长者）与 libbluray 默认项。 */
func finalizeDiscPlaylists(items []discPlaylistEntry, selected int) []discPlaylistEntry {
	if len(items) == 0 {
		return items
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Seconds != items[j].Seconds {
			return items[i].Seconds > items[j].Seconds
		}
		return items[i].Ref < items[j].Ref
	})
	for i := range items {
		items[i].Index = i
		items[i].Selected = selected > 0 && items[i].Ref == selected
	}
	items[0].Main = true
	if selected > 0 && !items[0].Selected {
		// libbluray 的默认项与「最长」不一致时也标出来，菜单里能看出差别。
		for i := range items {
			items[i].Selected = items[i].Ref == selected
		}
	}
	for i := range items {
		items[i].Label = discPlaylistLabel(items[i].Main, items[i].Ref, items[i].Seconds)
		if items[i].Selected && !items[i].Main {
			items[i].Label += "（默认）"
		}
	}
	return items
}

/* discPlaylistScan：枚举原盘可用播放列表 / DVD 标题。
   abs 可以是蓝光 ISO、BDMV 里的片段，或 BDMV 目录本身。 */
func (a *App) discPlaylistScan(ctx context.Context, abs string) discPlaylistInfo {
	abs = filepath.ToSlash(abs)
	key := discInputCacheKey(abs)
	if v, ok := discPlaylistCache.Load(key); ok {
		if entry, ok := v.(discPlaylistCacheEntry); ok && time.Since(entry.At) < discPlaylistTTL {
			return entry.Info
		}
	}
	info := a.discPlaylistScanUncached(ctx, abs)
	discPlaylistCache.Store(key, discPlaylistCacheEntry{Info: info, At: time.Now()})
	return info
}

func (a *App) discPlaylistScanUncached(ctx context.Context, abs string) discPlaylistInfo {
	info := discPlaylistInfo{OK: true, Kind: "none", Items: []discPlaylistEntry{}}
	discRoot := ""
	switch {
	case isDiscImagePath(abs):
		discRoot = abs
	case isBluRayFragment(abs):
		discRoot = bluRayDiscRootOf(abs)
	case strings.Contains(strings.ToLower(abs), "/bdmv"):
		discRoot = bluRayDiscRootOf(filepath.Join(abs, "x.m2ts"))
	}
	if discRoot == "" && !isDiscImagePath(abs) {
		info.Notes = append(info.Notes, "该路径不是原盘镜像或 BDMV 片段，无需播放菜单")
		return info
	}
	info.DiscRoot = discRoot
	info.DiscTitle = discTitleFromRoot(discRoot)

	// ① 蓝光：libbluray 的播放列表清单（BDMV 目录与蓝光 ISO 同一路径）。
	if spec := "bluray:" + discRoot; discRoot != "" {
		pctx, cancel := context.WithTimeout(ctx, discPlaylistTimeout)
		out, _ := discPlaylistRun(pctx, "-v", "info", "-show_entries", "format=duration", "-of", "default=nw=1", spec)
		cancel()
		items, selected := discPlaylistsFromLog(out)
		if len(items) > 0 {
			info.Kind = "bluray"
			info.Selected = selected
			info.Items = finalizeDiscPlaylists(items, selected)
			info.Notes = append(info.Notes, "播放列表来自 libbluray 的原盘清单（主影片=时长最长者）")
			return info
		}
	}
	// ② DVD 镜像：逐个标题探测（-title N），连续 3 次找不到即停。
	if isDiscImagePath(abs) {
		items, notes := a.discScanDVDTitles(ctx, abs)
		if len(items) > 0 {
			info.Kind = "dvd"
			info.Items = finalizeDiscPlaylists(items, items[0].Ref)
			info.Notes = append(info.Notes, notes...)
			return info
		}
		info.Notes = append(info.Notes, notes...)
	}
	info.OK = false
	if len(info.Notes) == 0 {
		info.Notes = append(info.Notes, "未能列出原盘标题（原盘可能不完整或没有可播放清单），播放时将按默认主影片处理")
	}
	return info
}

const (
	discPlaylistTimeout  = 25 * time.Second
	discDVDTitleTimeout  = 12 * time.Second
	discDVDTitleMaxProbe = 12
)

/* discScanDVDTitles 枚举 DVD 镜像里的标题（VIDEO_TS）。 */
func (a *App) discScanDVDTitles(ctx context.Context, iso string) ([]discPlaylistEntry, []string) {
	items := []discPlaylistEntry{}
	notes := []string{}
	misses := 0
	for n := 1; n <= discDVDTitleMaxProbe && misses < 3; n++ {
		pctx, cancel := context.WithTimeout(ctx, discDVDTitleTimeout)
		out, _ := discPlaylistRun(pctx, "-v", "error", "-f", "dvdvideo", "-title", strconv.Itoa(n),
			"-show_entries", "format=duration", "-of", "default=nw=1", iso)
		cancel()
		sec := discDurationsFromOutput(out)
		if sec <= 0 {
			misses++
			continue
		}
		misses = 0
		items = append(items, discPlaylistEntry{
			Kind: "title", Ref: n, Seconds: sec, DurationText: discDurationText(sec),
		})
	}
	if len(items) > 0 {
		notes = append(notes, "标题来自 DVD 镜像逐个探测（-title N）；标题名 DVD 里没有标准化字段，按时长区分")
	} else {
		notes = append(notes, "DVD 镜像未探测到可播放标题（缺 VIDEO_TS / 加密盘 / 探测超时）")
	}
	return items, notes
}

/* discTitleFromRoot 用原盘目录名当展示标题（刮削与卡片都用它，
   否则 BDMV 条目会显示成 00005 这种片段编号）。 */
func discTitleFromRoot(root string) string {
	root = strings.TrimSpace(filepath.ToSlash(root))
	if root == "" {
		return ""
	}
	base := filepath.Base(root)
	if strings.Contains(strings.ToLower(root), "/bdmv") {
		// 传进来的是片段/结构路径时向上取到原盘目录
		if idx := strings.Index(strings.ToLower(root), "/bdmv"); idx > 0 {
			base = filepath.Base(root[:idx])
		}
	}
	if isDiscImagePath(base) {
		base = strings.TrimSuffix(base, filepath.Ext(base))
	}
	return strings.TrimSpace(base)
}

/* discPlaylistArg 读取请求里的「播放哪个标题」参数（0=默认主影片）。 */
func discPlaylistArg(r *http.Request) int {
	if r == nil {
		return 0
	}
	if n := atoiSafe(r.URL.Query().Get("disc_playlist")); n > 0 && n < 100000 {
		return n
	}
	return 0
}

/* discPlaylistHandler：GET /api/media/disc/playlists?id=<lib>&path=<rel>
   播放器「媒体菜单」的数据源。 */
func (a *App) discPlaylistHandler(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	lib, ok := a.find(strings.TrimSpace(r.URL.Query().Get("id")))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	p, _, err := safeFile(lib, rel)
	if err != nil {
		errJSON(w, 404, "media not found")
		return
	}
	/* v0.9.98 修：原先写成 discPlaylistTimeout + discDVDTitleTimeout*float64ToDuration(N)，
	   Go 的 Duration 是 int64 命名类型，Duration*Duration 合法但会**溢出**（12s×12s≈1.44e20 纳秒），
	   结果预算变成负数 → 上下文立即过期 → ffprobe 刚启动就被杀，永远读不到播放列表
	   （真实原盘验证时抓到：接口返回 kind=none）。改成显式乘系数并抽成函数，附带单测。 */
	ctx, cancel := context.WithTimeout(r.Context(), discPlaylistBudget())
	defer cancel()
	info := a.discPlaylistScan(ctx, p)
	writeJSON(w, 200, info)
}

/* discPlaylistBudget：处理一次原盘清单请求的总预算 = 蓝光枚举 + DVD 逐个标题探测。
   必须是「时长 × 次数」（int64 纳秒级别的乘法量），不能写 Duration*Duration —— 会溢出。 */
func discPlaylistBudget() time.Duration {
	return discPlaylistTimeout + time.Duration(discDVDTitleMaxProbe)*discDVDTitleTimeout
}

/* resetDiscPlaylistCache 清空原盘清单缓存（测试用）。 */
func resetDiscPlaylistCache() {
	discPlaylistCache.Range(func(k, _ any) bool {
		discPlaylistCache.Delete(k)
		return true
	})
}
