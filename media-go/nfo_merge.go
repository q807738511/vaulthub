package main

/* v1.0.3（需求2）：NFO 识别与「外置 NFO ↔ 内置刮削」合并写回。
 *
 * 旧行为（v0.9.89~v1.0.2）有两个缺口：
 *   1. 读取端只按精确大小写找 `movie.nfo` / `tvshow.nfo` —— Windows 工具写出的
 *      `Movie.NFO` / `TVSHOW.NFO` 在 Linux 上直接读不到（识别失败）；
 *      带 UTF-8 BOM 或 UTF-16（Windows 记事本另存）的 NFO 用 encoding/xml 解码会报错，
 *      于是「本地明明有 NFO，界面却是空的」。
 *   2. 写入端遇到「不是 VaultHub 写的」NFO 就整份保留（kept），内置刮削拿到的
 *      简介/评分/演职人员/类型一个都补不进去 —— 用户手写的 NFO 往往只有标题，
 *      结果详情页永远缺字段。
 *
 * v1.0.3 的处理原则（用户口径：冲突时保留原内容、互补缺失内容、合并结果存回 NFO）：
 *   · 外置 NFO（无 VaultHub 标记）→ **字段级合并**：原有非空字段一律保留，
 *     只把缺失/空字段用刮削结果补齐；两边都有值且不同 → 记入 conflicts 但**不覆盖**；
 *   · VaultHub 自己写的 NFO（有标记）或显式 overwrite → 按新刮削结果整份重写（保持旧语义）；
 *   · 无法解析 / 根标签未知 → 一个字节都不动，返回 kept（宁可不写，也不破坏用户文件）。
 *
 * 合并采用「文本级插入」而不是整树重排：用户的 <studio>、<tag>、<set>、注释、
 * CDATA 等本工具不认识的节点全部原样保留，只在根闭合标签前补缺失片段。
 */

import (
	"bytes"
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

type nfoMergeResult struct {
	Merged    []string `json:"merged"`    // 从刮削结果补进 NFO 的字段
	Conflicts []string `json:"conflicts"` // 两边都有值但不同（保留 NFO 原值）
	Changed   bool     `json:"changed"`
	Reason    string   `json:"reason,omitempty"` // 未合并/未写入的原因
}

// nfoDecodeText 把 BOM / UTF-16 的 NFO 统一成 UTF-8 字节（stdlib only）。
func nfoDecodeText(b []byte) []byte {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return b[3:]
	}
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE {
		u := make([]uint16, 0, len(b)/2)
		for i := 2; i+1 < len(b); i += 2 {
			u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
		}
		return []byte(string(utf16.Decode(u)))
	}
	if len(b) >= 2 && b[0] == 0xFE && b[1] == 0xFF {
		u := make([]uint16, 0, len(b)/2)
		for i := 2; i+1 < len(b); i += 2 {
			u = append(u, uint16(b[i])<<8|uint16(b[i+1]))
		}
		return []byte(string(utf16.Decode(u)))
	}
	return b
}

// nfoDetectRoot 找出 NFO 的根标签名（movie / tvshow / episodedetails / …）。
func nfoDetectRoot(text string) string {
	for _, r := range []string{"movie", "tvshow", "episodedetails", "musicvideo", "album", "artist"} {
		if strings.Contains(text, "</"+r+">") || strings.Contains(text, "</"+r+" >") {
			return r
		}
	}
	return ""
}

func nfoEsc(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// nfoMergeIntoExisting 把刮削结果 doc 合并进已有 NFO 文本。
// 返回合并后的字节、合并报告、以及是否可安全合并（false = 原文件不可解析/结构未知）。
func nfoMergeIntoExisting(existing []byte, doc nfoWriteDoc) ([]byte, nfoMergeResult, bool) {
	res := nfoMergeResult{Merged: []string{}, Conflicts: []string{}}
	raw := nfoDecodeText(existing)
	text := string(raw)
	root := nfoDetectRoot(text)
	if root == "" {
		res.Reason = "root-not-found"
		return nil, res, false
	}
	var cur nfoDocument
	if err := xml.Unmarshal([]byte(text), &cur); err != nil {
		res.Reason = "parse-failed"
		return nil, res, false
	}

	// ---- 闭合标签位置与缩进（用于插入） ----
	closeTag := "</" + root + ">"
	ci := strings.LastIndex(text, closeTag)
	if ci < 0 {
		res.Reason = "close-tag-not-found"
		return nil, res, false
	}
	lineStart := strings.LastIndex(text[:ci], "\n") + 1
	baseIndent := text[lineStart:ci]
	if strings.TrimSpace(baseIndent) != "" { // 闭合标签与内容同一行 → 不做缩进
		baseIndent = ""
	}
	childIndent := baseIndent + "  "
	deepIndent := childIndent + "  "

	var frags []string
	addScalar := func(tag, have, want, label string) {
		want = strings.TrimSpace(want)
		if want == "" {
			return
		}
		have = strings.TrimSpace(have)
		if have != "" {
			if have != want {
				res.Conflicts = append(res.Conflicts, label)
			}
			return
		}
		frags = append(frags, childIndent+"<"+tag+">"+nfoEsc(want)+"</"+tag+">")
		res.Merged = append(res.Merged, label)
	}

	addScalar("title", cur.Title, doc.Title, "title")
	addScalar("originaltitle", cur.OriginalTitle, doc.OriginalTitle, "originaltitle")
	addScalar("showtitle", cur.ShowTitle, doc.ShowTitle, "showtitle")
	addScalar("year", cur.Year, doc.Year, "year")
	addScalar("premiered", cur.Premiered, doc.Premiered, "premiered")
	addScalar("plot", cur.Plot, doc.Plot, "plot")
	addScalar("outline", cur.Outline, doc.Outline, "outline")
	addScalar("runtime", cur.Runtime, doc.Runtime, "runtime")
	addScalar("rating", cur.Rating, doc.Rating, "rating")

	// ---- 可重复元素：按语义键去重后追加 ----
	haveGenre := map[string]bool{}
	for _, g := range cur.Genres {
		haveGenre[strings.ToLower(strings.TrimSpace(g))] = true
	}
	for _, g := range doc.Genres {
		g = strings.TrimSpace(g)
		k := strings.ToLower(g)
		if g == "" || haveGenre[k] {
			continue
		}
		haveGenre[k] = true
		frags = append(frags, childIndent+"<genre>"+nfoEsc(g)+"</genre>")
		res.Merged = append(res.Merged, "genre:"+g)
	}

	haveActor := map[string]bool{}
	for _, a := range cur.Actors {
		haveActor[strings.ToLower(strings.TrimSpace(a.Name))] = true
	}
	for _, a := range doc.Actors {
		name := strings.TrimSpace(a.Name)
		k := strings.ToLower(name)
		if name == "" || haveActor[k] {
			continue
		}
		haveActor[k] = true
		var b strings.Builder
		b.WriteString(childIndent + "<actor>\n")
		b.WriteString(deepIndent + "<name>" + nfoEsc(name) + "</name>\n")
		if role := strings.TrimSpace(a.Role); role != "" {
			b.WriteString(deepIndent + "<role>" + nfoEsc(role) + "</role>\n")
		}
		if thumb := strings.TrimSpace(a.Thumb); thumb != "" {
			b.WriteString(deepIndent + "<thumb>" + nfoEsc(thumb) + "</thumb>\n")
		}
		b.WriteString(childIndent + "</actor>")
		frags = append(frags, b.String())
		res.Merged = append(res.Merged, "actor:"+name)
	}

	haveUID := map[string]bool{}
	for _, u := range cur.UniqueIDs {
		haveUID[strings.ToLower(strings.TrimSpace(u.Type))+"="+strings.TrimSpace(u.Value)] = true
	}
	for _, u := range doc.UniqueIDs {
		t := strings.ToLower(strings.TrimSpace(u.Type))
		v := strings.TrimSpace(u.Value)
		if t == "" || v == "" || haveUID[t+"="+v] {
			continue
		}
		haveUID[t+"="+v] = true
		frags = append(frags, childIndent+"<uniqueid type=\""+nfoEsc(t)+"\">"+nfoEsc(v)+"</uniqueid>")
		res.Merged = append(res.Merged, "uniqueid:"+t)
	}
	// 有的刮削器只认 <tmdbid>/<tvdbid>：NFO 用这种写法时同步补上。
	if strings.Contains(text, "<tmdbid") {
		addScalar("tmdbid", cur.TMDBID, nfoUniqueValue(doc, "tmdb"), "tmdbid")
	}
	if strings.Contains(text, "<tvdbid") {
		addScalar("tvdbid", cur.TVDBID, nfoUniqueValue(doc, "tvdb"), "tvdbid")
	}

	haveThumb := map[string]bool{}
	for _, t := range cur.Thumbs {
		haveThumb[strings.ToLower(strings.TrimSpace(t.Aspect))+"="+strings.TrimSpace(t.Value)] = true
	}
	for _, t := range doc.Thumbs {
		a := strings.ToLower(strings.TrimSpace(t.Aspect))
		v := strings.TrimSpace(t.Value)
		if v == "" || haveThumb[a+"="+v] {
			continue
		}
		haveThumb[a+"="+v] = true
		if a == "" {
			frags = append(frags, childIndent+"<thumb>"+nfoEsc(v)+"</thumb>")
		} else {
			frags = append(frags, childIndent+"<thumb aspect=\""+nfoEsc(a)+"\">"+nfoEsc(v)+"</thumb>")
		}
		res.Merged = append(res.Merged, "thumb:"+a)
	}
	if len(doc.FanartThumbs) > 0 && !strings.Contains(text, "<fanart") {
		var b strings.Builder
		b.WriteString(childIndent + "<fanart>\n")
		for _, f := range doc.FanartThumbs {
			if f = strings.TrimSpace(f); f != "" {
				b.WriteString(deepIndent + "<thumb>" + nfoEsc(f) + "</thumb>\n")
			}
		}
		b.WriteString(childIndent + "</fanart>")
		frags = append(frags, b.String())
		res.Merged = append(res.Merged, "fanart")
	}

	if len(frags) == 0 {
		return nil, res, true // 可合并，但没有需要补的内容
	}
	res.Changed = true
	insert := strings.Join(frags, "\n") + "\n" + baseIndent
	out := text[:lineStart] + insert + text[lineStart:]
	return []byte(out), res, true
}

func nfoUniqueValue(doc nfoWriteDoc, typ string) string {
	for _, u := range doc.UniqueIDs {
		if strings.EqualFold(strings.TrimSpace(u.Type), typ) {
			return strings.TrimSpace(u.Value)
		}
	}
	return ""
}

// nfoAtomicWrite 原子写 NFO（临时文件 + fsync + rename，0644，上限 512 KB）。
func nfoAtomicWrite(path string, buf []byte) error {
	if len(buf) > nfoWriteMaxBytes {
		return os.ErrInvalid
	}
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".vaulthub-nfo-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(buf); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Chmod(tmp, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
