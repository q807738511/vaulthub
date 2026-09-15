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
