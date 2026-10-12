package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* ==================== v0.9.88：原盘（ISO / BDMV）读取支持 ====================
客户要求：「优化原盘文件(ISO/BDMV)读取和刮削」。

实测结论（容器内 ffmpeg 7.1.5，built with --enable-libbluray --enable-libdvdread
--enable-libdvdnav，另有 libudfread 0.1.0）：
  · ffmpeg -protocols 含 bluray；ffmpeg -demuxers 含 dvdvideo。
  · `ffprobe bluray:/x.iso`：镜像若为 **UDF**（蓝光原盘的正常格式），libbluray 会经
    udfread 直接读镜像内的 BDMV 结构（实测已读到 PLAYLIST，因测试镜像没有真实
    index.bdmv/MPLS 才在 BDMV 解析阶段失败）；**ISO9660 镜像**则报
    "failed opening UDF image" —— 即蓝光 ISO 不需要挂载就能读，关键是 UDF。
  · `ffprobe -f dvdvideo /x.iso`：DVD 镜像（VIDEO_TS）由 libdvdread 直接读 ISO。
  · 原实现只把 `.iso` 当普通文件交给 ffprobe，读到的是镜像裸字节（ISO 头部当成
    TS 流）—— 要么探测失败报「无法播放」，要么读到错流。

因此：探测与转码统一走「候选输入」链，命中即用并缓存：
  1. 蓝光镜像（.iso）      → bluray:<文件>  → dvdvideo:<文件> → 原文件
  2. BDMV 片段（…/BDMV/STREAM/*.m2ts）
                           → 原片段（既有可用路径，保持优先）
                           → bluray:<原盘目录>（片段本身读不了时的兜底）
  3. 其它                   → 原文件（行为完全不变）
*/

type discInputKind string

const (
	discInputPlain  discInputKind = "plain"
	discInputBluRay discInputKind = "bluray"
	discInputDVD    discInputKind = "dvd"
)

type discInput struct {
	// Spec 交给 ffmpeg/ffprobe 的输入（可能是 bluray:<路径> 这类协议写法）。
	Spec string        `json:"spec"`
	Kind discInputKind `json:"kind"`
	// File 始终是库内真实文件 —— 大小/时间戳/缓存键与流式读取都用它。
	File     string `json:"file"`
	DiscRoot string `json:"disc_root,omitempty"`
	/* v0.9.98：原盘播放菜单选中项。Playlist 是蓝光播放列表号（-playlist N），
	   Title 是 DVD 标题号（-title N）；0 表示按默认主影片播放。 */
	Playlist int `json:"playlist,omitempty"`
	Title    int `json:"title,omitempty"`
}

/* InputArgs 返回必须排在输入之前的解复用/协议参数。
   - DVD 镜像：-f dvdvideo（+ -title N）
   - 蓝光（BDMV / ISO）：-playlist N（协议级 AVOption）
   顺序要求：ffmpeg/ffprobe 把这些当**输入选项**，必须出现在输入 URL 之前。 */
func (in discInput) InputArgs() []string {
	args := []string{}
	if in.Kind == discInputDVD {
		args = append(args, "-f", "dvdvideo")
		if in.Title > 0 {
			args = append(args, "-title", strconv.Itoa(in.Title))
		}
		return args
	}
	if in.Kind == discInputBluRay && in.Playlist > 0 {
		args = append(args, "-playlist", strconv.Itoa(in.Playlist))
	}
	return args
}

/* DiscLabelFor 菜单里显示当前选中的标题（播放器状态行用）。 */
func (in discInput) SelectedRef() int {
	if in.Kind == discInputDVD {
		return in.Title
	}
	return in.Playlist
}

const (
	discInputProbeTimeout = 6 * time.Second
	discInputCacheTTL     = 10 * time.Minute
)

var (
	discInputCache  sync.Map // key: <abs>|<size>|<mtime> → discInputCacheEntry
	discProbeRunner = func(ctx context.Context, in discInput) bool {
		args := []string{"-v", "error", "-show_entries", "format=format_name", "-of", "default=nk=1:nw=1"}
		if in.Kind == discInputDVD {
			args = append(args, "-f", "dvdvideo")
		}
		args = append(args, in.Spec)
		out, err := exec.CommandContext(ctx, "ffprobe", args...).Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	}
)

type discInputCacheEntry struct {
	Input discInput
	At    time.Time
}

// isDiscImagePath：蓝光 / DVD 原盘镜像。
func isDiscImagePath(p string) bool {
	return strings.EqualFold(filepath.Ext(strings.TrimSpace(p)), ".iso")
}

// isBluRayFragment：原盘里的真实视频片段（BDMV/STREAM/00011.m2ts 这类）。
func isBluRayFragment(p string) bool {
	slash := strings.ToLower(filepath.ToSlash(p))
	if !strings.Contains(slash, "bdmv/stream/") {
		return false
	}
	switch strings.ToLower(filepath.Ext(slash)) {
	case ".m2ts", ".mts", ".mpg", ".mpeg", ".ts":
		return true
	}
	return false
}

// bluRayDiscRootOf：由片段路径回溯原盘根目录（BDMV 的上一级）。
func bluRayDiscRootOf(p string) string {
	slash := filepath.ToSlash(p)
	idx := strings.LastIndex(strings.ToLower(slash), "/bdmv/")
	if idx <= 0 {
		return ""
	}
	root := slash[:idx]
	if !strings.Contains(root, "/") {
		return ""
	}
	return root
}

// discInputCandidates 给出该文件的输入候选（按优先级）。
func discInputCandidates(abs string) []discInput {
	abs = filepath.ToSlash(abs)
	out := make([]discInput, 0, 3)
	if isDiscImagePath(abs) {
		// 蓝光镜像优先（UDF 直读），再 DVD 镜像，最后退回裸文件。
		out = append(out, discInput{Spec: "bluray:" + abs, Kind: discInputBluRay, File: abs})
		out = append(out, discInput{Spec: abs, Kind: discInputDVD, File: abs})
		out = append(out, discInput{Spec: abs, Kind: discInputPlain, File: abs})
		return out
	}
	out = append(out, discInput{Spec: abs, Kind: discInputPlain, File: abs})
	if isBluRayFragment(abs) {
		if root := bluRayDiscRootOf(abs); root != "" {
			out = append(out, discInput{Spec: "bluray:" + root, Kind: discInputBluRay, File: abs, DiscRoot: root})
		}
	}
	return out
}

func discInputCacheKey(abs string) string {
	key := filepath.ToSlash(abs)
	if st, err := os.Stat(abs); err == nil {
		key += "|" + strconv.FormatInt(st.Size(), 10) + "|" + strconv.FormatInt(st.ModTime().UnixNano(), 10)
	}
	return key
}

// resolveDiscInput 依次探测候选，命中即用；任何情况下都会返回一个可用输入
// （最差是裸文件），并把结果缓存 10 分钟，避免每个请求都探测一遍。
func (a *App) resolveDiscInput(ctx context.Context, abs string) discInput {
	candidates := discInputCandidates(abs)
	if len(candidates) == 1 {
		return candidates[0] // 普通文件：完全不做额外探测，行为与旧版一致
	}
	key := discInputCacheKey(abs)
	if v, ok := discInputCache.Load(key); ok {
		if entry, ok := v.(discInputCacheEntry); ok && time.Since(entry.At) < discInputCacheTTL {
			return entry.Input
		}
	}
	chosen := candidates[len(candidates)-1]
	for _, cand := range candidates {
		pctx, cancel := context.WithTimeout(ctx, discInputProbeTimeout)
		ok := discProbeRunner(pctx, cand)
		cancel()
		if ok {
			chosen = cand
			break
		}
	}
	discInputCache.Store(key, discInputCacheEntry{Input: chosen, At: time.Now()})
	return chosen
}

/* resolveDiscInputWithPlaylist：在自动解析结果上叠加「用户在原盘菜单里选的标题」。
   playlist<=0 时与 resolveDiscInput 行为完全一致（老调用点零风险）。 */
func (a *App) resolveDiscInputWithPlaylist(ctx context.Context, abs string, playlist int) discInput {
	auto := a.resolveDiscInput(ctx, abs)
	if playlist <= 0 {
		return auto
	}
	switch auto.Kind {
	case discInputDVD:
		auto.Title = playlist
		return auto
	case discInputBluRay:
		auto.Playlist = playlist
		return auto
	}
	/* 自动解析落到「裸文件」（例如 BDMV 片段自身可读）时，选了标题就意味着
	   要按原盘口径播放 —— 用库内真实文件当 File（大小/缓存键不变），
	   输入换成 bluray:<原盘根> + -playlist N。 */
	if root := bluRayDiscRootOf(abs); root != "" {
		return discInput{Spec: "bluray:" + root, Kind: discInputBluRay, File: abs, DiscRoot: root, Playlist: playlist}
	}
	if isDiscImagePath(abs) {
		return discInput{Spec: "bluray:" + abs, Kind: discInputBluRay, File: abs, Playlist: playlist}
	}
	return auto
}

// discProbeHint 给用户的排查提示（比 "media probe failed" 有用得多）。
func discProbeHint(abs string) string {
	switch {
	case isDiscImagePath(abs):
		return "原盘镜像无法解析：蓝光镜像需为 UDF 结构（内含 BDMV/），DVD 镜像需含 VIDEO_TS"
	case strings.Contains(strings.ToLower(filepath.ToSlash(abs)), "bdmv/"):
		return "原盘片段无法解析：请在媒体库里改用同目录 BDMV/STREAM 下的 .m2ts 片段，或检查该原盘是否完整"
	}
	return ""
}

// ffprobeInputArgs 按输入类型补齐解复用参数（bluray: 协议自带解复用器）。
func ffprobeInputArgs(kind discInputKind) []string {
	if kind == discInputDVD {
		return []string{"-f", "dvdvideo"}
	}
	return nil
}

// resetDiscInputCache 清空解析缓存（测试用；生产路径靠 TTL 过期）。
func resetDiscInputCache() {
	discInputCache.Range(func(k, _ any) bool {
		discInputCache.Delete(k)
		return true
	})
}
