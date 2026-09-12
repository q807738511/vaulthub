package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

/* v0.9.67：歌词「识别」—— 先读本地已有的，零网络成本。
 *
 * 现状（v0.9.66 及以前）：播放器能渲染 LRC（高亮/滚动），但没有任何自动填充来源，
 * 连「同名 .lrc」和「音频内嵌歌词」都读不到。本文件补齐读取侧：
 *   1) 同名 sidecar：<名>.lrc（大小写不限）—— 行业通用，Navidrome/Emby 同规则；
 *   2) MP3   ID3v2：USLT（非同步歌词）/ SYLT 之外的 USLT 是主流写入方式；
 *   3) FLAC/OGG Vorbis comment：LYRICS / UNSYNCEDLYRICS；
 *   4) M4A/MP4：©lyr 原子。
 * 文本编码按标签里的编码字节与 BOM 判定（UTF-8 / UTF-16LE/BE / Latin-1），
 * 避免中文歌词读成乱码（与 TXT 阅读器同类问题）。
 */

type lyricsResult struct {
	Lyrics       string `json:"lyrics,omitempty"`
	Synced       string `json:"synced_lyrics,omitempty"`
	Source       string `json:"lyrics_source,omitempty"`
	Instrumental bool   `json:"instrumental,omitempty"`
}

// sidecarLyrics 读取与音频同目录、同主文件名的 .lrc（大小写不限）。
func sidecarLyrics(absPath string) (lyricsResult, bool) {
	dir, stem := filepath.Dir(absPath), strings.TrimSuffix(filepath.Base(absPath), filepath.Ext(absPath))
	for _, name := range []string{stem + ".lrc", stem + ".LRC", stem + ".Lrc"} {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || len(b) == 0 {
			continue
		}
		text := decodeTagText(stripBOM(b), detectTextEncoding(b))
		if lyricsLooksValid(text) {
			return lyricsResult{Lyrics: text, Source: "local-lrc"}, true
		}
	}
	return lyricsResult{}, false
}

/* tagScanWindow / maxTagScanFile 限制标签解析的读取量。
   独立审查发现：早期实现用 os.ReadFile 整文件读入 —— 一个 2GB 的 .mp4 放进音频库后，
   每次请求都会分配 2GB；批量接口还能被用来反复触发，直接把容器打爆。
   歌词标签只出现在 ID3 头部、Vorbis comment 头部或 MP4 的 moov 原子（常在文件尾部），
   因此改为「首窗口 + 尾窗口」读取，内存上限固定为 2×8MB，与文件大小无关。 */
const (
	tagScanWindow  = 8 << 20
	maxTagScanFile = 2 << 30
)

func readTagWindows(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() > maxTagScanFile {
		return nil, os.ErrInvalid
	}
	if fi.Size() <= tagScanWindow {
		return io.ReadAll(io.LimitReader(f, tagScanWindow))
	}
	head := make([]byte, tagScanWindow)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.ErrUnexpectedEOF {
		return nil, err
	}
	buf := append([]byte{}, head[:n]...)
	if fi.Size() > tagScanWindow {
		tail := make([]byte, tagScanWindow)
		if m, err := f.ReadAt(tail, fi.Size()-tagScanWindow); err == nil || err == io.EOF {
			buf = append(buf, tail[:m]...)
		}
	}
	return buf, nil
}

// embeddedLyrics 按容器格式读取内嵌歌词标签（读取量有上限，见 readTagWindows）。
func embeddedLyrics(absPath string) (lyricsResult, bool) {
	b, err := readTagWindows(absPath)
	if err != nil {
		return lyricsResult{}, false
	}
	switch strings.ToLower(filepath.Ext(absPath)) {
	case ".mp3":
		if text, ok := id3USLT(b); ok && lyricsLooksValid(text) {
			return lyricsResult{Lyrics: text, Source: "local-id3"}, true
		}
	case ".flac", ".ogg", ".opus":
		if text, ok := vorbisLyrics(b); ok && lyricsLooksValid(text) {
			return lyricsResult{Lyrics: text, Source: "local-vorbis"}, true
		}
	case ".m4a", ".mp4", ".aac":
		if text, ok := mp4Lyrics(b); ok && lyricsLooksValid(text) {
			return lyricsResult{Lyrics: text, Source: "local-mp4"}, true
		}
	}
	return lyricsResult{}, false
}

// localLyrics 先 sidecar 后内嵌标签。
func localLyrics(absPath string) (lyricsResult, bool) {
	if r, ok := sidecarLyrics(absPath); ok {
		return r, true
	}
	return embeddedLyrics(absPath)
}

func detectTextEncoding(b []byte) string {
	if len(b) >= 2 {
		if b[0] == 0xFF && b[1] == 0xFE {
			return "utf16le"
		}
		if b[0] == 0xFE && b[1] == 0xFF {
			return "utf16be"
		}
	}
	if utf8.Valid(b) {
		return "utf8"
	}
	return "latin1"
}

func stripBOM(b []byte) []byte {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return b[3:]
	}
	if len(b) >= 2 && ((b[0] == 0xFF && b[1] == 0xFE) || (b[0] == 0xFE && b[1] == 0xFF)) {
		return b
	}
	return b
}

// decodeTagText 依编码把标签文本转为 UTF-8。
func decodeTagText(b []byte, enc string) string {
	switch enc {
	case "utf16le", "utf16be":
		if len(b) >= 2 && ((b[0] == 0xFF && b[1] == 0xFE) || (b[0] == 0xFE && b[1] == 0xFF)) {
			b = b[2:]
		}
		if len(b)%2 == 1 {
			b = b[:len(b)-1]
		}
		u := make([]uint16, 0, len(b)/2)
		for i := 0; i+1 < len(b); i += 2 {
			if enc == "utf16le" {
				u = append(u, binary.LittleEndian.Uint16(b[i:i+2]))
			} else {
				u = append(u, binary.BigEndian.Uint16(b[i:i+2]))
			}
		}
		out := string(utf16.Decode(u))
		return strings.TrimRight(out, "\x00")
	case "latin1":
		var sb strings.Builder
		for _, c := range b {
			sb.WriteRune(rune(c))
		}
		return sb.String()
	default:
		return strings.TrimRight(string(b), "\x00")
	}
}

// id3USLT 解析 ID3v2 的 USLT（非同步歌词）帧；无标签或解析失败返回 false。
func id3USLT(b []byte) (string, bool) {
	if len(b) < 10 || string(b[0:3]) != "ID3" {
		return "", false
	}
	flags := b[5]
	size := syncSafe(b[6:10])
	if size <= 0 || 10+size > len(b) {
		return "", false
	}
	body := b[10 : 10+size]
	// 仅处理「未同步」与「扩展头」之外的常见情形；带 unsynchronisation 的标签直接跳过，
	// 避免把未解码的字节当成歌词发给前端。
	if flags&0x80 != 0 || flags&0x40 != 0 {
		return "", false
	}
	for i := 0; i+10 <= len(body); {
		id := string(body[i : i+4])
		frameSize := int(binary.BigEndian.Uint32(body[i+4 : i+8]))
		if frameSize <= 0 || i+10+frameSize > len(body) {
			break
		}
		if id == "USLT" {
			f := body[i+10 : i+10+frameSize]
			if len(f) < 4 {
				return "", false
			}
			encByte := f[0]
			// f[1:4] 是 3 字节语言码，其后是 descriptor（以 0/0x0000 结尾）
			rest := f[4:]
			enc := "latin1"
			switch encByte {
			case 1:
				enc = "utf16le"
			case 2:
				enc = "utf16be"
			case 3:
				enc = "utf8"
			}
			// 跳过 descriptor
			if enc == "utf16le" || enc == "utf16be" {
				for j := 0; j+1 < len(rest); j += 2 {
					if rest[j] == 0 && rest[j+1] == 0 {
						rest = rest[j+2:]
						break
					}
				}
			} else {
				if idx := bytes.IndexByte(rest, 0); idx >= 0 {
					rest = rest[idx+1:]
				}
			}
			text := decodeTagText(stripBOM(rest), enc)
			if strings.TrimSpace(text) != "" {
				return text, true
			}
		}
		i += 10 + frameSize
	}
	return "", false
}

// vorbisLyrics 在 FLAC/OGG 的 Vorbis comment 区域里找 LYRICS / UNSYNCEDLYRICS。
// 采用「定位注释块 + 解析 KEY=VALUE」的务实做法：先找 "LYRICS=" 的键名，
// 避免整段 UTF-8 文本被误判。
func vorbisLyrics(b []byte) (string, bool) {
	for _, key := range []string{"UNSYNCEDLYRICS=", "LYRICS=", "unsyncedlyrics=", "lyrics="} {
		idx := bytes.Index(b, []byte(key))
		if idx < 0 {
			continue
		}
		start := idx + len(key)
		end := start
		limit := start + 64*1024
		if limit > len(b) {
			limit = len(b)
		}
		for end < limit {
			if b[end] == 0x00 {
				break
			}
			// Vorbis comment 的每个注释以长度前缀 + "KEY=VALUE" 存储；
			// 下一个注释起始处的 4 字节长度前缀通常是 0x00 或不可打印字节，
			// 这里用「连续可打印/换行」判定结束。
			if b[end] < 0x09 {
				break
			}
			end++
		}
		text := decodeTagText(stripBOM(b[start:end]), detectTextEncoding(b[start:end]))
		if lyricsLooksValid(text) {
			return text, true
		}
	}
	return "", false
}

// mp4Lyrics 解析 MP4/M4A 的 ©lyr 原子（其后紧跟一个 'data' 原子）。
// 布局：[4 字节 size]['data'][1 version][3 flags][4 locale][payload]
func mp4Lyrics(b []byte) (string, bool) {
	marker := []byte{0xA9, 'l', 'y', 'r'}
	offset := 0
	for {
		idx := bytes.Index(b[offset:], marker)
		if idx < 0 {
			return "", false
		}
		pos := offset + idx
		if pos+4 > len(b) {
			return "", false
		}
		dataIdx := bytes.Index(b[pos+4:], []byte("data"))
		if dataIdx < 0 {
			return "", false
		}
		d := pos + 4 + dataIdx // 'data' 起始
		if d < 4 || d+12 > len(b) {
			return "", false
		}
		dataSize := int(binary.BigEndian.Uint32(b[d-4 : d]))
		end := d - 4 + dataSize
		if dataSize < 16 || end > len(b) || end <= d+12 {
			end = len(b)
		}
		raw := b[d+12 : end]
		text := decodeTagText(stripBOM(raw), detectTextEncoding(raw))
		if lyricsLooksValid(text) {
			return text, true
		}
		offset = d + 4
	}
}

/* lyricsLooksValid 过滤「假歌词」：占位文案、纯乐器标记、过短内容。
   网易云等平台对无歌词曲目会返回「暂无歌词」「此歌曲为没有填词的纯音乐」。 */
func lyricsLooksValid(text string) bool {
	t := strings.TrimSpace(text)
	if len(t) < 10 {
		return false
	}
	compact := strings.NewReplacer(" ", "", "\r", "", "\n", "", "\t", "").Replace(t)
	for _, bad := range []string{"暂无歌词", "没有填词", "纯音乐", "纯音乐，请欣赏", "NoLyrics", "Instrumental"} {
		if strings.Contains(compact, bad) {
			return false
		}
	}
	// 去掉 LRC 时间轴后仍要有实际内容
	stripped := lrcStripTimestamps(t)
	return len(strings.TrimSpace(stripped)) >= 5
}

// lrcStripTimestamps 去掉 [mm:ss.xx] / [xx:xx] 时间轴标记，保留正文。
func lrcStripTimestamps(text string) string {
	var sb strings.Builder
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		for strings.HasPrefix(line, "[") {
			end := strings.IndexByte(line, ']')
			if end < 0 {
				break
			}
			tag := line[1:end]
			// 只剥时间轴与元信息标签，正文里的 [ 不处理
			if isLrcTag(tag) {
				line = strings.TrimSpace(line[end+1:])
				continue
			}
			break
		}
		if line != "" {
			sb.WriteString(line)
			sb.WriteString("\n")
		}
	}
	return sb.String()
}

func isLrcTag(tag string) bool {
	if tag == "" {
		return false
	}
	if strings.Contains(tag, ":") {
		return true // [00:12.34] / [ar:xxx] / [ti:xxx]
	}
	return false
}

func syncSafe(b []byte) int {
	if len(b) < 4 {
		return 0
	}
	return int(b[0]&0x7F)<<21 | int(b[1]&0x7F)<<14 | int(b[2]&0x7F)<<7 | int(b[3]&0x7F)
}
