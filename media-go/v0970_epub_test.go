package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
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
