#!/usr/bin/env python3
"""v0.9.70: shelf reopening, protected document reader, and legacy regression guards."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")

checks = {
    "完整索引用于书刊筛选": 'group === "comic" && data.status !== "indexing"' in MEDIA
        and "files = await fetchAllLibraryFiles(lib.id, data, offset)" in MEDIA,
    "不再发送超大已读分页": 'comicShelfView === "completed" ? 100000' not in MEDIA,
    "已读过滤仍按进度": 'comicShelfView === "completed" ? progress >= COMPLETED_PROGRESS : progress < COMPLETED_PROGRESS' in MEDIA,
    "已读收藏按钮可切回": 'setComicShelfView(comicShelfView === \\"completed\\" ? \\"shelf\\" : \\"completed\\")' in MEDIA,
    "PDF 使用登录媒体流": 'else if (ext === "pdf")' in MEDIA and 'body = `<iframe src="${esc(url)}#view=FitH"' in MEDIA
        and 'url = mediaFileUrl(lib, path)' in MEDIA,
    "常见文档格式进入阅读器": '"epub"' in MEDIA and '"docx"' in MEDIA and 'MEDIA_FORMATS.book.includes(ext)' in MEDIA,
    "关闭阅读器刷新收藏视图": 'if (group === "comic")' in FEATURES and 'setComicShelfView("shelf")' in FEATURES,
    "关闭释放阅读器监听": 'closeComicReader()' in FEATURES,
    "历史焦点检查仍存在": 'aria-modal="true"' in HTML and ':focus-visible' in CSS,
    "网易云默认关闭": 'NetEase' in MEDIA and '默认关闭' in MEDIA,
    "本版版本": 'VAULTHUB_ASSET_VERSION = "0.9.70"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "0.9.70"' in STATE,
}
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_EPUB = (ROOT / "media-go/document_epub.go").read_text(encoding="utf-8")
GO_EPUB_TEST = (ROOT / "media-go/v0970_epub_test.go").read_text(encoding="utf-8")

# ============ EPUB 文档支持（v0.9.70 新增） ============
checks.update({
    "EPUB 端点已注册": '"/api/media/document/epub"' in GO_MAIN and "a.epubDocument" in GO_MAIN,
    "EPUB 零新依赖": '"archive/zip"' in GO_EPUB and "golang.org/x/text" not in GO_EPUB
        and "golang.org/x/net" not in GO_EPUB,
    "EPUB 鉴权与路径校验": "readAuth(r)" in GO_EPUB and "safeFile(l, rel)" in GO_EPUB
        and 'filepath.Ext(rel), ".epub"' in GO_EPUB,
    "EPUB 拒绝父目录段": 'if seg == ".."' in GO_EPUB,
    "EPUB 跳过脚本样式": 'base == "script" || base == "style" || base == "head"' in GO_EPUB,
    "EPUB 严格标签解析": "func parseTagAt(src string, at int)" in GO_EPUB
        and 'return "/" + name, end, false, true' in GO_EPUB,
    "EPUB 元素跳过用收尾标签精确定位": "func skipElement(src string, from int, tag string) int" in GO_EPUB
        and 'needle := "</" + strings.ToLower(tag)' in GO_EPUB,
    "EPUB 自闭合不进跳过状态": '&& !selfClosing {' in GO_EPUB,
    "EPUB 裸小于号当普通字符": 'out.WriteString("<")' in GO_EPUB,
    "EPUB 标题定位不改字节": "func indexFold(s, needle string) int" in GO_EPUB
        and "tagNameOf" not in GO_EPUB,
    "EPUB 章节跳转守卫测试": (ROOT / "tests/test_v0970_epub_chapter_jump.py").exists()
        and "jumpEbookChapter" in (ROOT / "tests/test_v0970_epub_chapter_jump.py").read_text(encoding="utf-8"),
    "章节跳转按元素定位": 'scroller.querySelectorAll(".ebook-chapter-title")' in MEDIA.replace("scroller.querySelectorAll ? ", "")
        or "headings[Math.min(index, headings.length - 1)]" in MEDIA,
    "章节跳转不再产生 NaN": '} else if (Number.isFinite(Number(chapter.offset)))' in MEDIA,
    "EPUB 章节带累计偏移": 'let ebookOffset = 0;' in MEDIA and 'offset: ebookOffset' in MEDIA,
    "忽略 Python 编译产物": "__pycache__/" in (ROOT / ".gitignore").read_text(encoding="utf-8"),
    "EPUB 上限与截断标记": "epubMaxEntryBytes" in GO_EPUB and "epubMaxTextBytes" in GO_EPUB
        and "epubMaxSpineItems" in GO_EPUB and "epubMaxScanBytes" in GO_EPUB and '"truncated": truncated' in GO_EPUB,
    "EPUB 上限抽成可测函数": "func epubChapters(zr *zip.Reader, order []string)" in GO_EPUB
        and "chapters, total, truncated := epubChapters(" in GO_EPUB,
    "EPUB 扫描量按实际字节": "scanned += len(raw)" in GO_EPUB
        and "if scanned+int(zf.UncompressedSize64) > epubMaxScanBytes" in GO_EPUB,
    "EPUB 渲染前转义": "${esc(c.text)}" in MEDIA and "${esc(c.title)}" in MEDIA
        and "${esc(err.message)}" in MEDIA,
    "EPUB 上限有真实测试": "TestEpubCapsAreReal" in GO_EPUB_TEST and "TestEpubEntryAndSpineCaps" in GO_EPUB_TEST,
    "EPUB 只保留真实条目": "findZipEntry(zr, full) == nil" in GO_EPUB,
    "EPUB 无正文返回 422": 'errJSON(w, 422, "EPUB has no readable text")' in GO_EPUB,
    "前端 EPUB 阅读分支": 'ext === "epub"' in MEDIA and "/api/media/document/epub" in MEDIA
        and "restoreReaderProgress(viewer, lib.id, path)" in MEDIA,
    "EPUB 守卫测试存在": "TestEpubSpineOrderAndContent" in GO_EPUB_TEST
        and "TestEpubPathAndSizeGuards" in GO_EPUB_TEST and "TestEpubEntityAndTagHandling" in GO_EPUB_TEST,
})

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: {len(failed)} checks")
print("PASS: v0.9.70 reader/document and legacy regression guards")
