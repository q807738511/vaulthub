package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

/* v0.9.70：EPUB 解析守卫。
   这些用例直接构造最小 EPUB 容器验证解析顺序、去标签、实体解码与路径逃逸拒绝，
   不依赖任何外部样例文件。 */

func buildEPUB(t *testing.T) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, e := zw.Create(name)
		if e != nil {
			t.Fatalf("create %s: %v", name, e)
		}
		if _, e := w.Write([]byte(body)); e != nil {
			t.Fatalf("write %s: %v", name, e)
		}
	}
	add("mimetype", "application/epub+zip")
	add("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
	add("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试书</dc:title></metadata>
  <manifest>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="nav" href="../escape.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`)
	add("OEBPS/text/ch1.xhtml", `<html><head><title>第一章 标题</title><style>.x{color:red}</style></head>
<body><h1>第一章 开始</h1><p>你好&amp;世界</p><script>var bad=1;</script><p>第二段</p></body></html>`)
	add("OEBPS/text/ch2.xhtml", `<html><body><h2>第二章</h2><div>内容&#65;与&hellip;</div></body></html>`)
	if e := zw.Close(); e != nil {
		t.Fatalf("close zip: %v", e)
	}
	p := filepath.Join(t.TempDir(), "book.epub")
	if e := os.WriteFile(p, buf.Bytes(), 0o600); e != nil {
		t.Fatalf("write epub: %v", e)
	}
	return p
}

func TestEpubSpineOrderAndContent(t *testing.T) {
	p := buildEPUB(t)
	zr, e := zip.OpenReader(p)
	if e != nil {
		t.Fatalf("open epub: %v", e)
	}
	defer zr.Close()
	opf, ok := epubRootFilePath(&zr.Reader)
	if !ok || opf != "OEBPS/content.opf" {
		t.Fatalf("rootfile = %q ok=%v", opf, ok)
	}
	title, order, ok := epubSpinePaths(&zr.Reader, opf)
	if !ok {
		t.Fatal("spine parse failed")
	}
	if title != "测试书" {
		t.Errorf("book title = %q", title)
	}
	// spine 顺序优先，CSS 不参与，逃逸条目必须被丢弃。
	if len(order) != 2 || order[0] != "OEBPS/text/ch1.xhtml" || order[1] != "OEBPS/text/ch2.xhtml" {
		t.Fatalf("spine order = %#v", order)
	}
	for _, n := range order {
		if strings.Contains(n, "escape") {
			t.Fatalf("escaped path kept: %s", n)
		}
	}
	raw, ok := readZipEntryBounded(findZipEntry(&zr.Reader, order[0]), epubMaxEntryBytes)
	if !ok {
		t.Fatal("chapter read failed")
	}
	text := htmlToText(raw)
	if strings.Contains(text, "var bad") || strings.Contains(text, "color:red") {
		t.Errorf("script/style leaked into text: %q", text)
	}
	if !strings.Contains(text, "你好&世界") || !strings.Contains(text, "第二段") {
		t.Errorf("entities or body text lost: %q", text)
	}
	if got := epubChapterTitle(order[0], raw); got != "第一章 开始" {
		t.Errorf("chapter title = %q", got)
	}
}

func TestEpubPathAndSizeGuards(t *testing.T) {
	cases := map[string]string{
		"../secret":      "",
		"/etc/passwd":    "etc/passwd",
		"a/../../b.txt":  "",
		"":               "",
		".":              "",
		"text/./a.xhtml": "text/a.xhtml",
	}
	for in, want := range cases {
		if got := normalizeZipPath(in); got != want {
			t.Errorf("normalizeZipPath(%q) = %q, want %q", in, got, want)
		}
	}
	if _, ok := readZipEntryBounded(nil, 10); ok {
		t.Error("nil entry must not be readable")
	}
	big := &zip.File{FileHeader: zip.FileHeader{UncompressedSize64: 1 << 20}}
	if _, ok := readZipEntryBounded(big, 1024); ok {
		t.Error("oversized entry must be refused instead of truncated")
	}
}

func TestEpubEntityAndTagHandling(t *testing.T) {
	if got := decodeEntities("A&amp;B &#65; &#x42; &hellip; &unknown;"); got != "A&B A B … &unknown;" {
		t.Errorf("decodeEntities = %q", got)
	}
	text := htmlToText([]byte("<div>一</div><div>二</div>"))
	if text != "一\n二" {
		t.Errorf("block tags must become line breaks: %q", text)
	}
	if got := firstTagText("<html><h2>标题</h2></html>", "h1", "h2"); got != "标题" {
		t.Errorf("firstTagText = %q", got)
	}
	if got := firstTagText("<h1x>不是标题</h1x>", "h1"); got != "" {
		t.Errorf("prefix tag must not match: %q", got)
	}
}

// TestEpubCapsAreReal 验证「上限」不是注释里的声明：正文上限、条目上限与
// 扫描上限都必须真的截断，并且如实返回 truncated。
func TestEpubCapsAreReal(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, e := zw.Create(name)
		if e != nil {
			t.Fatalf("create %s: %v", name, e)
		}
		if _, e := w.Write([]byte(body)); e != nil {
			t.Fatalf("write %s: %v", name, e)
		}
	}
	add("mimetype", "application/epub+zip")
	add("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`)
	// 12 章 × 2MB 正文（共 24MB）明显超过 epubMaxTextBytes(12MB)，必须截断。
	const chunk = 2 << 20
	body := "<html><body><h1>第X章</h1><p>" + strings.Repeat("正", chunk/3) + "</p></body></html>"
	var manifest, spine strings.Builder
	for i := 1; i <= 12; i++ {
		name := "OEBPS/ch" + strconv.Itoa(i) + ".xhtml"
		add(name, strings.Replace(body, "第X章", "第"+strconv.Itoa(i)+"章", 1))
		manifest.WriteString(`<item id="c` + strconv.Itoa(i) + `" href="ch` + strconv.Itoa(i) + `.xhtml" media-type="application/xhtml+xml"/>`)
		spine.WriteString(`<itemref idref="c` + strconv.Itoa(i) + `"/>`)
	}
	add("OEBPS/content.opf", `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>大书</dc:title></metadata><manifest>`+manifest.String()+`</manifest><spine>`+spine.String()+`</spine></package>`)
	if e := zw.Close(); e != nil {
		t.Fatalf("close: %v", e)
	}
	path := filepath.Join(t.TempDir(), "big.epub")
	if e := os.WriteFile(path, buf.Bytes(), 0o600); e != nil {
		t.Fatalf("write: %v", e)
	}
	zr, e := zip.OpenReader(path)
	if e != nil {
		t.Fatalf("open: %v", e)
	}
	defer zr.Close()
	opf, ok := epubRootFilePath(&zr.Reader)
	if !ok {
		t.Fatal("rootfile missing")
	}
	_, order, ok := epubSpinePaths(&zr.Reader, opf)
	if !ok || len(order) != 12 {
		t.Fatalf("spine order = %d ok=%v", len(order), ok)
	}
	chapters, total, truncated := epubChapters(&zr.Reader, order)
	if !truncated {
		t.Errorf("12×2MB 正文必须触发 truncated")
	}
	if total > epubMaxTextBytes {
		t.Errorf("正文超上限未被拦截: %d > %d", total, epubMaxTextBytes)
	}
	if len(chapters) >= 12 {
		t.Errorf("超限后仍返回全部章节: %d", len(chapters))
	}
	if len(chapters) == 0 {
		t.Errorf("截断后应保留已解析的章节")
	}
}

// TestEpubEntryAndSpineCaps 验证单条目上限与章节数上限。
func TestEpubEntryAndSpineCaps(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("big.xhtml")
	_, _ = w.Write([]byte(strings.Repeat("a", 32)))
	if e := zw.Close(); e != nil {
		t.Fatalf("close: %v", e)
	}
	zr, e := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if e != nil {
		t.Fatalf("reader: %v", e)
	}
	if _, ok := readZipEntryBounded(findZipEntry(zr, "big.xhtml"), 16); ok {
		t.Error("单条目超过上限必须拒绝（而不是截断后当作完整内容）")
	}
	many := make([]string, 0, epubMaxSpineItems+10)
	for i := 0; i < epubMaxSpineItems+10; i++ {
		many = append(many, "missing-"+strconv.Itoa(i)+".xhtml")
	}
	chapters, _, truncated := epubChapters(zr, many)
	if !truncated {
		t.Error("超出章节数上限必须返回 truncated")
	}
	if len(chapters) != 0 {
		t.Errorf("不存在的条目不应产出章节: %d", len(chapters))
	}
}

// TestEpubSkipDoesNotSwallowBody 覆盖 v0.9.70 复审缺陷 P2-1：
// 跳过 script/style 时若元素内部出现裸 '<'（JS 比较式）或自闭合标签，
// 旧实现会把收尾标签一起吞掉，导致整章余下正文静默丢失。
func TestEpubSkipDoesNotSwallowBody(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
		not  []string
	}{
		{
			name: "脚本内含比较式",
			in:   `<body><p>前段</p><script>if (a<b) { alert(1) }</script><p>后段必须保留</p></body>`,
			want: []string{"前段", "后段必须保留"},
			not:  []string{"alert"},
		},
		{
			name: "自闭合 script",
			in:   `<body><p>前段</p><script src="x.js"/><p>自闭合后仍要保留</p></body>`,
			want: []string{"前段", "自闭合后仍要保留"},
			not:  []string{"x.js"},
		},
		{
			name: "样式含裸小于号",
			in:   `<body><style>p:before{content:"<"}</style><p>样式后的正文</p></body>`,
			want: []string{"样式后的正文"},
			not:  []string{"content:"},
		},
		{
			name: "正文裸小于号不当标签",
			in:   `<body><p>1 < 2 且 3 > 1</p><p>下一段</p></body>`,
			want: []string{"1 < 2", "下一段"},
		},
		{
			name: "head 跳过不吞 body",
			in:   `<html><head><title>T</title><script>var a=1<2;</script></head><body>正文在这里</body></html>`,
			want: []string{"正文在这里"},
			not:  []string{"var a"},
		},
	}
	for _, c := range cases {
		got := htmlToText([]byte(c.in))
		for _, w := range c.want {
			if !strings.Contains(got, w) {
				t.Errorf("%s: 丢失内容 %q，实际 %q", c.name, w, got)
			}
		}
		for _, n := range c.not {
			if strings.Contains(got, n) {
				t.Errorf("%s: 泄漏内容 %q，实际 %q", c.name, n, got)
			}
		}
	}
}

// TestEpubTitleNoByteDrift 覆盖复审 P3-6：标题定位必须作用于原串字节，
// 不能依赖 strings.ToLower 的下标（ToLower 可能缩短 UTF-8 字节）。
func TestEpubTitleNoByteDrift(t *testing.T) {
	cases := map[string]string{
		"<p>İ</p><h1>Bölüm</h1>":      "Bölüm",
		"<p>İİİİİİ</p><h2>第二章 İ</h2>": "第二章 İ",
		"<H1>大写标签也要认</H1>":            "大写标签也要认",
		"<h1x>伪标签</h1x><h1>真标题</h1>":  "真标题",
	}
	for in, want := range cases {
		if got := firstTagText(in, "h1", "h2", "h3", "title"); got != want {
			t.Errorf("firstTagText(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestEpubScanBudgetGuard 覆盖复审 P3-5（M8/M9）：扫描量上限必须真的生效。
// 做法：2000 章、每章声明 50KB（合计 100MB > 64MB 上限），内容高度可压缩，
// 因此临时文件很小但「声明大小」预算必然被触发。
func TestEpubScanBudgetGuard(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, e := zw.Create(name)
		if e != nil {
			t.Fatalf("create: %v", e)
		}
		if _, e := w.Write([]byte(body)); e != nil {
			t.Fatalf("write: %v", e)
		}
	}
	add("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`)
	payload := strings.Repeat("a", 50<<10) // 50KB 声明大小
	var manifest, spine strings.Builder
	const n = epubMaxSpineItems
	for i := 0; i < n; i++ {
		name := "c" + strconv.Itoa(i) + ".xhtml"
		add(name, "<html><body><h1>章"+strconv.Itoa(i)+"</h1><p>"+payload+"</p></body></html>")
		manifest.WriteString(`<item id="i` + strconv.Itoa(i) + `" href="` + name + `" media-type="application/xhtml+xml"/>`)
		spine.WriteString(`<itemref idref="i` + strconv.Itoa(i) + `"/>`)
	}
	add("c.opf", `<package version="3.0"><metadata><title>大书</title></metadata><manifest>`+manifest.String()+`</manifest><spine>`+spine.String()+`</spine></package>`)
	if e := zw.Close(); e != nil {
		t.Fatalf("close: %v", e)
	}
	path := filepath.Join(t.TempDir(), "scan.epub")
	if e := os.WriteFile(path, buf.Bytes(), 0o600); e != nil {
		t.Fatalf("write: %v", e)
	}
	zr, e := zip.OpenReader(path)
	if e != nil {
		t.Fatalf("open: %v", e)
	}
	defer zr.Close()
	opf, ok := epubRootFilePath(&zr.Reader)
	if !ok {
		t.Fatal("rootfile missing")
	}
	_, order, ok := epubSpinePaths(&zr.Reader, opf)
	if !ok || len(order) != n {
		t.Fatalf("spine=%d ok=%v", len(order), ok)
	}
	chapters, total, truncated := epubChapters(&zr.Reader, order)
	if !truncated {
		t.Errorf("声明总量 %dMB 必须触发扫描预算截断", (n*50)>>10)
	}
	if len(chapters) >= n {
		t.Errorf("扫描预算未生效，仍返回全部 %d 章", len(chapters))
	}
	if total > epubMaxTextBytes {
		t.Errorf("正文超过 12MB 上限: %d", total)
	}
}

// TestHtmlToTextGolden 固化 htmlToText 对普通 HTML 的输出（已知与 v0.9.69 旧实现逐例一致，
// 见本版「旧实现副本对比」验证）。未来任何去标签改动都必须显式更新这里。
func TestHtmlToTextGolden(t *testing.T) {
	golden := map[string]string{
		`<b>粗体</b><i>斜体</i><span>行内</span>`:                                "粗体斜体行内",
		`<blockquote>引用</blockquote><article>文章</article>`:                 "引用\n文章",
		`<body><p>A&amp;B</p><p>&#65;&hellip;</p></body>`:                  "A&B\nA…",
		`<div><div><p>嵌套</p></div></div>`:                                  "嵌套",
		`<div>一</div><div>二</div>`:                                         "一\n二",
		`<h1>标题</h1><p>正文</p>`:                                             "标题\n正文",
		`<html><head><title>T</title></head><body><p>正文</p></body></html>`: "正文",
		`<p>a</p><br><p>b</p>`:                                             "a\n\nb",
		`<p>尾部实体&nbsp;结束</p>`:                                              "尾部实体 结束",
		`<p>第一段</p><p>第二段</p>`:                                             "第一段\n第二段",
		`<table><tr><td>1</td><td>2</td></tr></table>`:                     "12",
		`<ul><li>甲</li><li>乙</li></ul>`:                                    "甲\n乙",
	}
	for in, want := range golden {
		if got := htmlToText([]byte(in)); got != want {
			t.Errorf("htmlToText(%q) = %q, want %q", in, got, want)
		}
	}
}
