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
    "EPUB 跳过脚本样式": 'case "script", "style", "head":' in GO_EPUB,
    "EPUB 收尾标签可解析": 'closing := strings.HasPrefix(s, "/")' in GO_EPUB,
    "EPUB 上限与截断标记": "epubMaxEntryBytes" in GO_EPUB and "epubMaxTextBytes" in GO_EPUB
        and "epubMaxSpineItems" in GO_EPUB and "epubMaxScanBytes" in GO_EPUB and '"truncated": truncated' in GO_EPUB,
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
