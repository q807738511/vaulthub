package main

import (
	"archive/zip"
	"encoding/xml"
	"io"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

/* v0.9.70：EPUB 电子书解析端点
 *
 *   GET /api/media/document/epub?id=&path=
 *
 * 用户诉求：漫画/电子书阅读器要能读 PDF「等文档格式」，此前除 PDF/TXT/图片外的
 * 电子书（EPUB 最常见）只能显示「当前浏览器不支持直接解析」。EPUB 规范本身就是
 * 一个 ZIP 容器，因此不需要引入任何第三方依赖或额外容器即可自解析：
 *
 *   META-INF/container.xml → rootfile(OPF) → manifest/spine → 按阅读顺序读 XHTML
 *   → 去标签/去脚本样式/解实体 → 纯文本章节，交给现有 TXT/电子书阅读器渲染。
 *
 * 安全与稳健性（与归档页端点同源策略）：
 *   - readAuth + a.find + safeFile：未登录 401、库不存在 404、路径越界 404；
 *   - 只接受 .epub 扩展名，其它格式一律 400，不做「猜容器」；
 *   - zip 内路径必须规范化，`..`/绝对路径逃逸一律丢弃（不落盘、不读越界条目）；
 *   - 单条目、单章、全书正文、总扫描量、章节数均有硬上限，超出即截断并如实返回
 *     truncated，避免恶意/异常 EPUB 造成内存与 CPU 放大；
 *   - 无片头正文（chapters 为空）返回 422，前端给出准确的「无正文」提示，
 *     不再伪装成读取失败。
 */

const (
	epubMaxContainerBytes = 1 << 20  // container.xml 上限 1MB
	epubMaxOPFBytes       = 4 << 20  // OPF 上限 4MB
	epubMaxEntryBytes     = 4 << 20  // 单个 XHTML 条目上限 4MB
	epubMaxTextBytes      = 12 << 20 // 全书正文上限 12MB
	epubMaxSpineItems     = 2000     // 章节数上限
	epubMaxScanBytes      = 64 << 20 // 总读取上限 64MB
)

type epubChapter struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

type epubContainer struct {
	Rootfiles []struct {
		FullPath string `xml:"full-path,attr"`
	} `xml:"rootfiles>rootfile"`
}

type epubOPF struct {
	Metadata struct {
		Title string `xml:"title"`
	} `xml:"metadata"`
	Manifest struct {
		Items []struct {
			ID        string `xml:"id,attr"`
			Href      string `xml:"href,attr"`
			MediaType string `xml:"media-type,attr"`
		} `xml:"item"`
	} `xml:"manifest"`
	Spine struct {
		Items []struct {
			IDRef string `xml:"idref,attr"`
		} `xml:"itemref"`
	} `xml:"spine"`
}

// readZipEntryBounded 读取 zip 条目；声明大小超过 limit 时返回 ok=false。
// 注意：Go archive/zip 会校验声明大小与实际数据是否一致，不一致即报错，
// 因此「声明很小、实际解压很大」的条目在这里同样会被拒绝。
func readZipEntryBounded(zf *zip.File, limit int64) ([]byte, bool) {
	if zf == nil || limit <= 0 {
		return nil, false
	}
	if zf.UncompressedSize64 > uint64(limit) {
		return nil, false
	}
	rc, e := zf.Open()
	if e != nil {
		return nil, false
	}
	defer rc.Close()
	b, e := io.ReadAll(io.LimitReader(rc, limit))
	if e != nil {
		return nil, false
	}
	return b, true
}

func findZipEntry(zr *zip.Reader, name string) *zip.File {
	for _, f := range zr.File {
		if f.Name == name {
			return f
		}
	}
	return nil
}

// normalizeZipPath 规范化容器内相对路径；返回空串表示该路径不可用（逃逸/空）。
// 注意：返回值只用于在 **ZIP 索引内查找条目**，不会被拼进宿主文件系统路径，
// 因此即使调用方传入可疑字符串也不存在落盘或越界读取；仍然显式拒绝 `..`
// 是为了 fail-closed：解析结果可预期，且不会把父目录段带进后续逻辑。
func normalizeZipPath(p string) string {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	if p == "" {
		return ""
	}
	/* 显式拒绝任何父目录段：不依赖 path.Clean 的「钳制」语义，
	   避免 "a/../../b.txt" 被静默改写成容器内路径。 */
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return ""
		}
	}
	clean := path.Clean("/" + p)[1:]
	if clean == "" || clean == "." || clean == ".." {
		return ""
	}
	return clean
}

// epubRootFilePath 读取 META-INF/container.xml 得到 OPF 路径。
func epubRootFilePath(zr *zip.Reader) (string, bool) {
	b, ok := readZipEntryBounded(findZipEntry(zr, "META-INF/container.xml"), epubMaxContainerBytes)
	if !ok {
		return "", false
	}
	var c epubContainer
	if xml.Unmarshal(b, &c) != nil {
		return "", false
	}
	for _, rf := range c.Rootfiles {
		if p := normalizeZipPath(rf.FullPath); p != "" {
			return p, true
		}
	}
	return "", false
}

// epubSpinePaths 解析 OPF，返回书名与按 spine 顺序排列的 XHTML 条目路径。
func epubSpinePaths(zr *zip.Reader, opfPath string) (string, []string, bool) {
	b, ok := readZipEntryBounded(findZipEntry(zr, opfPath), epubMaxOPFBytes)
	if !ok {
		return "", nil, false
	}
	var opf epubOPF
	if xml.Unmarshal(b, &opf) != nil {
		return "", nil, false
	}
	base := path.Dir(opfPath)
	if base == "." {
		base = ""
	}
	readable := func(mt string) bool {
		mt = strings.ToLower(strings.TrimSpace(mt))
		return mt == "" || mt == "application/xhtml+xml" || mt == "text/html"
	}
	resolve := func(href string) string {
		rel, e := url.PathUnescape(strings.TrimSpace(href))
		if e != nil {
			rel = strings.TrimSpace(href)
		}
		rel = strings.SplitN(rel, "#", 2)[0]
		return normalizeZipPath(path.Join(base, rel))
	}
	byID := map[string]string{}
	var manifestOrder []string
	for _, it := range opf.Manifest.Items {
		if !readable(it.MediaType) {
			continue
		}
		full := resolve(it.Href)
		if full == "" || findZipEntry(zr, full) == nil {
			continue
		}
		byID[it.ID] = full
		manifestOrder = append(manifestOrder, full)
	}
	var order []string
	seen := map[string]bool{}
	for _, ir := range opf.Spine.Items {
		if h, ok := byID[ir.IDRef]; ok && !seen[h] {
			seen[h] = true
			order = append(order, h)
		}
	}
	if len(order) == 0 {
		/* spine 缺失或全部无效时退化为 manifest 顺序，保证「能读」优先。 */
		for _, h := range manifestOrder {
			if !seen[h] {
				seen[h] = true
				order = append(order, h)
			}
		}
	}
	return strings.TrimSpace(opf.Metadata.Title), order, true
}

func isBlockTag(name string) bool {
	switch name {
	case "p", "/p", "div", "/div", "br", "li", "/li", "tr", "/tr",
		"h1", "/h1", "h2", "/h2", "h3", "/h3", "h4", "/h4", "h5", "/h5", "h6", "/h6",
		"section", "/section", "article", "/article", "blockquote", "/blockquote",
		"table", "/table", "ul", "/ul", "ol", "/ol":
		return true
	}
	return false
}

/* parseTagAt 解析 src[at] 处的标签（at 必须指向 '<'）。
 *
 * v0.9.70 复审修复：旧实现只按「下一个 '>'」切标签，导致正文/脚本里的裸 '<'
 * （如 <script>if (a<b) {}</script>）会把紧随其后的 </script> 一起吞掉，
 * skip 状态永不复位 → 整章余下正文静默丢失（极端情况对合法书误报 422）。
 * 现在严格判定标签形状：'<' 后必须是 [/] 字母数字 名称，且名称后紧跟空白、'/' 或 '>'；
 * 不满足就把 '<' 当普通字符输出。同时识别自闭合标签（<script src="x.js"/>），
 * 自闭合元素没有子节点，不得进入跳过状态。
 */
func parseTagAt(src string, at int) (name string, end int, selfClosing bool, ok bool) {
	if at >= len(src) || src[at] != '<' {
		return "", at, false, false
	}
	i := at + 1
	closing := false
	if i < len(src) && src[i] == '/' {
		closing = true
		i++
	}
	startName := i
	for i < len(src) && isTagNameByte(src[i]) {
		i++
	}
	if i == startName {
		return "", at, false, false // "<" 后不是名字 → 不是标签（例如 "< 3" 或 "a<b"）
	}
	name = strings.ToLower(src[startName:i])
	// 名字后必须是空白、'/' 或 '>'，否则是形如 <b> 的伪标签（如 "<brx..."）也接受，
	// 但像 "a<b=c" 这种在 HTML 里也会被浏览器当标签，这里保持同样宽松度。
	gt := strings.IndexByte(src[i:], '>')
	if gt < 0 {
		return "", at, false, false
	}
	end = i + gt + 1
	inner := src[i : i+gt]
	selfClosing = strings.HasSuffix(strings.TrimSpace(inner), "/")
	if closing {
		return "/" + name, end, false, true
	}
	return name, end, selfClosing, true
}

// skipElement 跳到 tag 元素的收尾标签之后；找不到收尾标签则返回 src 结束位置。
func skipElement(src string, from int, tag string) int {
	needle := "</" + strings.ToLower(tag)
	lower := strings.ToLower(src)
	idx := strings.Index(lower[from:], needle)
	if idx < 0 {
		return len(src)
	}
	pos := from + idx
	gt := strings.IndexByte(src[pos:], '>')
	if gt < 0 {
		return len(src)
	}
	return pos + gt + 1
}

func isTagNameByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == ':' || c == '_'
}

var epubEntities = map[string]string{
	"amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ",
	"mdash": "—", "ndash": "–", "hellip": "…", "middot": "·",
	"ldquo": "“", "rdquo": "”", "lsquo": "‘", "rsquo": "’", "copy": "©",
}

func decodeEntities(s string) string {
	if !strings.Contains(s, "&") {
		return s
	}
	var out strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '&' {
			out.WriteByte(s[i])
			i++
			continue
		}
		end := strings.IndexByte(s[i:], ';')
		if end < 0 || end > 12 {
			out.WriteByte(s[i])
			i++
			continue
		}
		body := s[i+1 : i+end]
		if strings.HasPrefix(body, "#") {
			var n int64
			var e error
			if strings.HasPrefix(body, "#x") || strings.HasPrefix(body, "#X") {
				n, e = strconv.ParseInt(body[2:], 16, 32)
			} else {
				n, e = strconv.ParseInt(body[1:], 10, 32)
			}
			if e == nil && n > 0 && n <= 0x10FFFF {
				out.WriteRune(rune(n))
				i += end + 1
				continue
			}
			out.WriteByte(s[i])
			i++
			continue
		}
		if rep, ok := epubEntities[strings.ToLower(body)]; ok {
			out.WriteString(rep)
			i += end + 1
			continue
		}
		out.WriteByte(s[i])
		i++
	}
	return out.String()
}

// tidyText 归一化换行、去掉行尾空白、压缩空行，避免把 XHTML 缩进带进正文。
func tidyText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.ReplaceAll(s, "\t", " ")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := 0
	for _, line := range lines {
		line = strings.TrimRight(line, " ")
		for strings.Contains(line, "  ") {
			line = strings.ReplaceAll(line, "  ", " ")
		}
		if strings.TrimSpace(line) == "" {
			blank++
			if blank > 1 {
				continue
			}
			out = append(out, "")
			continue
		}
		blank = 0
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// firstTagText 取第一个指定标签的文本（用于章节标题），找不到返回空串。
//
// v0.9.70 复审修复：旧实现用 strings.ToLower 后的下标去切原串，而 ToLower 可能
// 缩短 UTF-8 字节（如 'İ' U+0130 由 2 字节变 1 字节），导致标题被切错。现在只在
// 原串上定位（ASCII 大小写不敏感），切片始终作用于原串。
func firstTagText(html string, tags ...string) string {
	for _, tag := range tags {
		open := "<" + tag
		idx := indexFold(html, open)
		for idx >= 0 {
			after := idx + len(open)
			if after < len(html) && (html[after] == '>' || html[after] == ' ' || html[after] == '\t' || html[after] == '\n' || html[after] == '\r') {
				gt := strings.IndexByte(html[idx:], '>')
				if gt < 0 {
					break
				}
				start := idx + gt + 1
				closeIdx := indexFold(html[start:], "</"+tag)
				if closeIdx < 0 {
					break
				}
				txt := tidyText(decodeEntities(html[start : start+closeIdx]))
				txt = strings.ReplaceAll(txt, "\n", " ")
				if strings.TrimSpace(txt) != "" {
					return strings.TrimSpace(txt)
				}
			}
			nxt := indexFold(html[after:], open)
			if nxt < 0 {
				break
			}
			idx = after + nxt
		}
	}
	return ""
}

// indexFold 返回 needle 在 s 中首次出现的下标（仅 ASCII 大小写不敏感），
// 不改变字节长度，因此下标可直接用于原串切片。
func indexFold(s, needle string) int {
	if needle == "" {
		return 0
	}
	first := needle[0]
	for i := 0; i+len(needle) <= len(s); i++ {
		c := s[i]
		if c != first && !(isASCIILetter(c) && isASCIILetter(first) && lowerASCII(c) == lowerASCII(first)) {
			continue
		}
		match := true
		for j := 1; j < len(needle); j++ {
			a, b := s[i+j], needle[j]
			if a == b || (isASCIILetter(a) && isASCIILetter(b) && lowerASCII(a) == lowerASCII(b)) {
				continue
			}
			match = false
			break
		}
		if match {
			return i
		}
	}
	return -1
}

func isASCIILetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }
func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 32
	}
	return c
}

// htmlToText 把 XHTML 转成可读纯文本：丢弃 script/style/head 元素内容，块级标签转换行。
func htmlToText(raw []byte) string {
	src := decodeTagText(raw, detectTextEncoding(raw))
	var out strings.Builder
	lastNL := false // 避免块级标签首尾各产生一个换行，形成空段
	i := 0
	for i < len(src) {
		if src[i] != '<' {
			next := strings.IndexByte(src[i:], '<')
			var chunk string
			if next < 0 {
				chunk = src[i:]
				i = len(src)
			} else {
				chunk = src[i : i+next]
				i += next
			}
			if decoded := decodeEntities(chunk); decoded != "" {
				out.WriteString(decoded)
				lastNL = strings.HasSuffix(decoded, "\n")
			}
			continue
		}
		name, end, selfClosing, ok := parseTagAt(src, i)
		if !ok {
			/* 不是标签（正文里的裸 '<'，例如 "a < b" 或脚本比较式）：
			   按普通字符输出，绝不吃掉后续内容。 */
			out.WriteString("<")
			lastNL = false
			i++
			continue
		}
		i = end
		base := strings.TrimPrefix(name, "/")
		if (base == "script" || base == "style" || base == "head") && !selfClosing {
			/* 跳过整个元素（含内容），直到它的收尾标签。
			   用「收尾标签精确查找」而不是泛化切标签，避免元素内部出现
			   '<'（JS 比较式、CSS 选择器）时把收尾标签一并吞掉。 */
			if strings.HasPrefix(name, "/") {
				continue // 孤立收尾标签
			}
			i = skipElement(src, i, base)
			continue
		}
		if isBlockTag(name) {
			/* <br> 强制断行；其余块级标签只在上一输出不是换行时补一个，
			   这样 <div>一</div><div>二</div> 得到「一\n二」而不是空行分隔。 */
			if base == "br" && strings.HasPrefix(name, "/") == false {
				out.WriteString("\n")
				lastNL = true
			} else if !lastNL {
				out.WriteString("\n")
				lastNL = true
			}
		}
	}
	return tidyText(out.String())
}

// epubChapterTitle 章节标题：优先 h1/h2/h3，其次 title，最后退回文件名。
func epubChapterTitle(name string, raw []byte) string {
	src := decodeTagText(raw, detectTextEncoding(raw))
	if t := firstTagText(src, "h1", "h2", "h3", "title"); t != "" {
		return t
	}
	base := path.Base(name)
	return strings.TrimSuffix(base, path.Ext(base))
}

// epubChapters 按 spine 顺序收集章节文本，并强制执行条目/正文/章节/扫描量上限。
// 抽成纯函数是为了让这些上限可以被单元测试真实验证，而不只是写在注释里。
func epubChapters(zr *zip.Reader, order []string) (chapters []epubChapter, total int, truncated bool) {
	chapters = make([]epubChapter, 0, 32)
	scanned := 0
	for i, name := range order {
		if i >= epubMaxSpineItems {
			truncated = true
			break
		}
		zf := findZipEntry(zr, name)
		if zf == nil {
			continue
		}
		/* 先用声明大小快速拒绝明显超量的归档，再按实际读取字节累计。
		   说明：Go 的 archive/zip 在「声明大小与实际不符」时会直接报错
		   （ErrFormat / ErrUnexpectedEOF），readZipEntryBounded 因此返回 false
		   并拒绝该条目，所以这里不是唯一的放大防线；按实际字节记账属纵深防御，
		   保证将来换成其它 zip 实现时预算依然成立。 */
		if scanned+int(zf.UncompressedSize64) > epubMaxScanBytes {
			truncated = true
			break
		}
		raw, ok := readZipEntryBounded(zf, epubMaxEntryBytes)
		if !ok {
			continue
		}
		scanned += len(raw)
		if scanned > epubMaxScanBytes {
			truncated = true
			break
		}
		text := htmlToText(raw)
		if strings.TrimSpace(text) == "" {
			continue
		}
		if total+len(text) > epubMaxTextBytes {
			truncated = true
			break
		}
		total += len(text)
		chapters = append(chapters, epubChapter{Title: epubChapterTitle(name, raw), Text: text})
	}
	return chapters, total, truncated
}

func (a *App) epubDocument(w http.ResponseWriter, r *http.Request) {
	if !readAuth(r) {
		errJSON(w, 401, "login required")
		return
	}
	l, ok := a.find(r.URL.Query().Get("id"))
	if !ok {
		errJSON(w, 404, "library not found")
		return
	}
	rel := r.URL.Query().Get("path")
	if !strings.EqualFold(filepath.Ext(rel), ".epub") {
		errJSON(w, 400, "not an EPUB file")
		return
	}
	p, _, e := safeFile(l, rel)
	if e != nil {
		errJSON(w, 404, "file not found")
		return
	}
	zr, e := zip.OpenReader(p)
	if e != nil {
		errJSON(w, 400, "not an EPUB container")
		return
	}
	defer zr.Close()

	opfPath, ok := epubRootFilePath(&zr.Reader)
	if !ok {
		errJSON(w, 400, "EPUB container.xml missing or invalid")
		return
	}
	bookTitle, order, ok := epubSpinePaths(&zr.Reader, opfPath)
	if !ok {
		errJSON(w, 400, "EPUB OPF missing or invalid")
		return
	}
	if len(order) == 0 {
		errJSON(w, 422, "EPUB has no readable documents")
		return
	}
	chapters, total, truncated := epubChapters(&zr.Reader, order)
	if len(chapters) == 0 {
		errJSON(w, 422, "EPUB has no readable text")
		return
	}
	writeJSON(w, 200, map[string]any{
		"title":     bookTitle,
		"chapters":  chapters,
		"count":     len(chapters),
		"bytes":     total,
		"truncated": truncated,
	})
}
