package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* v0.9.71：弱网可用性 —— 服务端限码率音频流。
 *
 * 背景（Plex / Emby / Navidrome 的通行做法）：原始音轨常是 FLAC/APE/320k，
 * 在弱网（4G、远程访问、家里 Wi-Fi 边缘）下会频繁卡顿；成熟方案都是
 * 「服务端按需转码 + 客户端选码率档位」。Navidrome 用 opus/mp3 转码并按
 * 码率档位对外提供，Plex/Emby 用自适应码率与「自动质量」。
 *
 * 本实现（零新增依赖，复用镜像内的 ffmpeg）：
 *   GET /api/media/audio/stream?id=<lib>&path=<rel>&bitrate=96k|128k|192k|256k|320k[&fresh=1]
 *     - 首次请求用 ffmpeg 转成 MP3（libmp3lame，浏览器全平台可播），结果落到
 *       <MEDIA_CACHE_DIR>/audio-transcode/<sha1>.mp3；
 *     - 之后同一曲目/档位直接走 http.ServeContent：支持 Range（可拖动进度）
 *       与浏览器缓存，弱网下重播不再重复转码；
 *     - 转码走全局闸门 acquireTranscode（与视频/漫画转码共用，防 CPU/内存打爆），
 *       队列超时或客户端断开时返回 503 + Retry-After，由前端回落原文件直出。
 * 码率档位故意只接受白名单内的固定值：任意码率会让缓存碎片化，也会放大 CPU 开销。
 */

const (
	audioStreamCacheDirName = "audio-transcode"
	audioStreamCacheMaxAge  = 7 * 24 * time.Hour
	audioStreamCacheMaxFile = 512 << 20 // 单个缓存文件上限（防止异常大源）
)

// audioBitrateLadder 是允许的码率档位（kbps），弱网模式在「原文件」之外按它降级。
var audioBitrateLadder = []int{64, 96, 128, 160, 192, 256, 320}

// parseAudioBitrate 解析 bitrate 参数（"96k" / "96" / "96K"），只接受白名单档位。
func parseAudioBitrate(raw string) (int, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.TrimSuffix(value, "kbps")
	value = strings.TrimSuffix(value, "k")
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, errors.New("bitrate required")
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0, errors.New("invalid bitrate")
	}
	for _, allowed := range audioBitrateLadder {
		if n == allowed {
			return n, nil
		}
	}
	return 0, fmt.Errorf("bitrate %d not in ladder %v", n, audioBitrateLadder)
}

// audioStreamCacheKey 用「库内相对路径 + 修改时间 + 码率 + 编码器版本」做缓存键：
// 源文件被替换或码率档位变化都会自然失效。
func audioStreamCacheKey(abs string, mod time.Time, bitrate int) string {
	h := sha1.Sum([]byte(fmt.Sprintf("mp3|%d|%s|%d", bitrate, abs, mod.UnixNano())))
	return hex.EncodeToString(h[:])
}

func (a *App) audioStreamCacheDir() string {
	base := a.cacheDir
	if strings.TrimSpace(base) == "" {
		base = "/data/transcode-cache"
	}
	return filepath.Join(base, audioStreamCacheDirName)
}

/* pruneAudioStreamCache 按「总量超限就删最旧」清理音频转码缓存。
   独立于页面缓存配额，避免弱网听歌把漫画页缓存挤掉。 */
func (a *App) pruneAudioStreamCache(maxBytes int64) {
	dir := a.audioStreamCacheDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	items := make([]item, 0, len(entries))
	var total int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".mp3") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		items = append(items, item{path: filepath.Join(dir, entry.Name()), size: info.Size(), mod: info.ModTime()})
		total += info.Size()
	}
	if total <= maxBytes {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items {
		if total <= maxBytes {
			return
		}
		if time.Since(it.mod) < time.Hour { // 一小时内的新文件（可能正在被读取）不动
			continue
		}
		if os.Remove(it.path) == nil {
			total -= it.size
		}
	}
}

/* audioStream 提供限码率音频流；命中缓存时走 ServeContent（支持 Range 与缓存头）。 */
func (a *App) audioStream(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		errJSON(w, 405, "method not allowed")
		return
	}
	q := r.URL.Query()
	l, ok := a.find(q.Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	abs, st, err := safeFile(l, q.Get("path"))
	if err != nil {
		errJSON(w, 404, "file not found")
		return
	}
	if !isAudioMediaPath(abs) {
		errJSON(w, 400, "not an audio file")
		return
	}
	bitrate, err := parseAudioBitrate(q.Get("bitrate"))
	if err != nil {
		errJSON(w, 400, err.Error())
		return
	}
	dir := a.audioStreamCacheDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		errJSON(w, 500, "audio cache unavailable")
		return
	}
	cachePath := filepath.Join(dir, audioStreamCacheKey(abs, st.ModTime(), bitrate)+".mp3")
	if q.Get("fresh") == "" {
		if info, err := os.Stat(cachePath); err == nil && info.Size() > 0 {
			a.serveAudioStreamFile(w, r, cachePath, info, bitrate, "hit")
			return
		}
	}
	release, allowed := a.acquireTranscode(r.Context())
	if !allowed {
		// 转码队列拥塞或客户端已断开：让前端回落原文件直出，别把播放卡死在这里。
		w.Header().Set("Retry-After", "3")
		errJSON(w, 503, "transcode busy")
		return
	}
	defer release()
	if err := a.transcodeAudioToMP3(r.Context(), abs, cachePath, bitrate); err != nil {
		// 客户端取消（切歌/关闭）不算服务故障
		if r.Context().Err() != nil {
			return
		}
		errJSON(w, 500, "audio transcode failed")
		return
	}
	info, err := os.Stat(cachePath)
	if err != nil {
		errJSON(w, 500, "audio cache unavailable")
		return
	}
	a.serveAudioStreamFile(w, r, cachePath, info, bitrate, "miss")
}

// serveAudioStreamFile 用 ServeContent 输出缓存文件（自动支持 Range/If-Modified-Since）。
func (a *App) serveAudioStreamFile(w http.ResponseWriter, r *http.Request, path string, info os.FileInfo, bitrate int, state string) {
	f, err := os.Open(path)
	if err != nil {
		errJSON(w, 500, "audio cache unavailable")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Vaulthub-Audio-Bitrate", fmt.Sprintf("%dk", bitrate))
	w.Header().Set("X-Vaulthub-Audio-Cache", state)
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}

/* transcodeAudioToMP3 用 ffmpeg 转成固定码率 MP3，先写临时文件再原子改名，
   避免并发读到一个半截文件（同名并发由页面缓存同款的「临时文件唯一化 + publish 后改名」处理）。 */
func (a *App) transcodeAudioToMP3(ctx context.Context, src, dst string, bitrate int) error {
	if info, err := os.Stat(src); err != nil {
		return err
	} else if info.Size() > audioStreamCacheMaxFile {
		return errors.New("source too large")
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".audio-*.mp3")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	args := []string{
		"-hide_banner", "-loglevel", "error",
		"-i", src,
		"-vn",
		"-c:a", "libmp3lame",
		"-b:a", fmt.Sprintf("%dk", bitrate),
		"-f", "mp3",
		"-y", tmpPath,
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("ffmpeg: %v (%s)", err, strings.TrimSpace(stderr.String()))
	}
	out, err := os.Stat(tmpPath)
	if err != nil || out.Size() == 0 {
		return errors.New("ffmpeg produced no output")
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return err
	}
	a.pruneAudioStreamCache(a.audioStreamCacheLimit())
	return nil
}

// audioStreamCacheLimit 音频转码缓存上限：默认 min(2GiB, 主缓存配额/2)。
func (a *App) audioStreamCacheLimit() int64 {
	const maxAudio = 2 << 30
	limit := a.cacheMaxBytes / 2
	if limit <= 0 || limit > maxAudio {
		limit = maxAudio
	}
	return limit
}

/* weakProbe 是客户端下行带宽探测端点（弱网模式「自动」档位用）。
 *
 * 返回指定字节数的不可压缩数据（随机字节），并显式禁用压缩与缓存，
 * 让前端用「传输耗时 ÷ 字节数」得到真实下行速率。上限 2MiB，避免被当成放大器。
 * 随机数据由固定种子生成：内容恒定 → 测试可断言，且 gzip/zstd 压不动。
 */
func (a *App) weakProbe(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	if r.Method != http.MethodGet {
		errJSON(w, 405, "method not allowed")
		return
	}
	kb := 256
	if raw := strings.TrimSpace(r.URL.Query().Get("kb")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 8 || n > 2048 {
			errJSON(w, 400, "invalid kb (8..2048)")
			return
		}
		kb = n
	}
	size := kb * 1024
	payload := weakProbePayload(size)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Encoding", "identity")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("X-Vaulthub-Probe-Bytes", strconv.Itoa(size))
	w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(payload)
}

var (
	weakProbeOnce   sync.Once
	weakProbeBuffer []byte
)

// weakProbePayload 返回 size 字节的确定性伪随机数据（进程内缓存，重复请求零分配开销）。
func weakProbePayload(size int) []byte {
	weakProbeOnce.Do(func() {
		const capacity = 2048 * 1024
		buf := make([]byte, capacity)
		state := uint64(0x9E3779B97F4A7C15)
		for i := range buf {
			state ^= state << 13
			state ^= state >> 7
			state ^= state << 17
			buf[i] = byte(state >> 24)
		}
		weakProbeBuffer = buf
	})
	if size <= 0 || size > len(weakProbeBuffer) {
		return weakProbeBuffer
	}
	return weakProbeBuffer[:size]
}
