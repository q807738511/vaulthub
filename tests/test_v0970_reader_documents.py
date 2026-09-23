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
    # v0.9.75：书架视图从「两态按钮」升级为四个分段标签（未读 / 喜欢 / 🕘 历史阅读 / 全部），
    # 过滤仍按同一个阅读进度阈值判断，只是判断入口换成了标签状态。
    "已读过滤仍按进度": 'if (bookShelfTab === "completed") return progress >= COMPLETED_PROGRESS;' in MEDIA
        and "return progress < COMPLETED_PROGRESS;" in MEDIA,
    "书架标签含历史阅读且保留旧入口": 'id: "completed", label: "🕘 历史阅读"' in MEDIA
        and "function setComicShelfView(view)" in MEDIA,
    "PDF 使用登录媒体流": 'else if (ext === "pdf")' in MEDIA and 'body = `<iframe src="${esc(url)}#view=FitH"' in MEDIA
        and 'url = mediaFileUrl(lib, path)' in MEDIA,
    "常见文档格式进入阅读器": '"epub"' in MEDIA and '"docx"' in MEDIA and 'MEDIA_FORMATS.book.includes(ext)' in MEDIA,
    # v0.9.75：原契约是「关闭阅读器强制回到未读视图」；用户报告从「历史阅读」点开一本
    # 再关闭会被踢回未读，看起来像条目被释放。新契约：保持当前视图并刷新。
    "关闭阅读器刷新书架视图": 'if (group === "comic")' in FEATURES and 'setComicShelfView(comicShelfView)' in FEATURES,
    "关闭释放阅读器监听": 'closeComicReader()' in FEATURES,
    "历史焦点检查仍存在": 'aria-modal="true"' in HTML and ':focus-visible' in CSS,
    "网易云默认关闭": 'NetEase' in MEDIA and '默认关闭' in MEDIA,
    "本版版本": 'VAULTHUB_ASSET_VERSION = "0.9.75"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "0.9.75"' in STATE,
}
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_EPUB = (ROOT / "media-go/document_epub.go").read_text(encoding="utf-8")
GO_EPUB_TEST = (ROOT / "media-go/v0970_epub_test.go").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.70.md").read_text(encoding="utf-8")

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

# ============ 历史遗留项检查（需求 4：只做检查与记录，不谎报已修） ============
FEATURES_ALL = "\n".join((ROOT / "web/js" / f).read_text(encoding="utf-8") for f in
                         ["01-state.js", "02-media.js", "03-features.js", "03-audio-zoom.js"])
WEB_ALL = "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / "web").rglob("*.js"))

checks.update({
    # 遗留 1：遮罩/阅读器的焦点语义与焦点归还（WCAG 2.4.3 相关）
    "遗留-遮罩对话框语义": 'role="dialog"' in HTML and 'aria-modal="true"' in HTML,
    "遗留-关闭后归还焦点": "focus({ preventScroll: true })" in FEATURES_ALL,
    "遗留-阅读器 Esc 关闭": 'ev.key === "Escape"' in MEDIA,
    "遗留-关闭释放阅读器监听": "closeComicReader()" in (ROOT / "web/js/03-features.js").read_text(encoding="utf-8"),
    # 遗留 2：不支持格式必须诚实回落，不得假装可读
    "遗留-不支持格式诚实提示": "当前浏览器不能直接解析" in MEDIA and "当前浏览器不支持直接解析" in MEDIA,
    "遗留-RAR 仍不解析": '"rar"' in MEDIA and "unrar" not in WEB_ALL and "rar.js" not in WEB_ALL,
    # 遗留 3：未捆绑 PDF.js，PDF 走浏览器内置查看器 + 登录保护
    "遗留-未捆绑 PDF.js": "pdfjs" not in WEB_ALL.lower() and "pdf.worker" not in WEB_ALL.lower(),
    "遗留-PDF 走登录流": 'mediaFileUrl(lib, path)' in MEDIA and 'iframe src="${esc(url)}#view=FitH"' in MEDIA,
})

# ============ 声明的真实性（审查 P2-3/P3 相关，避免只写在文档里） ============
checks.update({
    "服务端 limit 夹取与说明一致": 'if lim <= 0 || lim > 500 {' in GO_MAIN and 'lim = 100' in GO_MAIN
        and '静默' in NOTES and '截断分页' not in NOTES,
    "zip 注释不再宣称被证伪论断": ('纵深' in GO_EPUB or 'defense in depth' in GO_EPUB.lower())
        and ('ErrFormat' in GO_EPUB or 'ErrUnexpectedEOF' in GO_EPUB),
    "去标签黄金值守卫存在": 'TestHtmlToTextGolden' in GO_EPUB_TEST,
})

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: {len(failed)} checks")
print("PASS: v0.9.70 reader/document and legacy regression guards")
