# VaultHub 蜀鼠之家 v0.9.70

## 修复与阅读体验

- 修复漫画/电子书标记已读后进入「已读收藏」再返回时无法重新展开的问题：书刊筛选现在基于完整索引，避免超大分页请求被服务端截断。
- 漫画/电子书阅读器新增 **EPUB 正文解析**：服务端按 `container.xml → OPF → spine` 顺序解析章节目录，去标签/去 script+style/解实体后交给现有电子书阅读器渲染（章节下拉、进度恢复可用）。EPUB 本身是 ZIP 容器，实现只用 Go 标准库 `archive/zip`+`encoding/xml`，**未新增任何第三方依赖或容器**。
- PDF 继续走登录保护的 `/api/media/file` iframe 阅读路径（未登录一律 401），TXT/图片阅读路径保持原样。
- EPUB 解析设硬上限：单条目 4MB、全书正文 12MB、章节 2000、总扫描 64MB，超出则截断并返回 `truncated`；无正文返回 422 且前端提示「没有可读正文」。扫描量按**实际读取字节**累计（不信任 zip 头部声明），章节收集抽成纯函数 `epubChapters` 以便单元测试真实验证上限生效。
- 路径校验：容器内路径显式拒绝任何 `..` 父目录段（不依赖 `path.Clean` 钳制），且只保留真正存在于容器中的 manifest 条目。
- 补充阅读器关闭、焦点、PDF 保护流、已读收藏切换和版本一致性的回归契约测试。
- 检查历史遗留项：遮罩焦点语义与键盘关闭、播放器居中/层级、移动端布局与 PDF 阅读路径均纳入本版校验；RAR/CBR/7z 仍仅展示不解析。

## 渲染安全（实测）

用含 `<script>alert()</script>`、`onerror`/`onclick` 事件属性、`javascript:` URL 与实体转义的恶意 EPUB 做实测：

- 服务端返回的是**去标签后的纯文本**，事件属性与 `javascript:` 一律未出现在结果中；
- 书籍原文里本就存在的 `<script>` 字样（来自 `&lt;script&gt;` 实体）按原文保留为文本，渲染前由 `esc()` 转义（`& < > " '` 全覆盖），不会执行；
- Go 的 JSON 编码默认转义 HTML 字符（`<` → `\u003c`）作为额外一层。

## 明确不启用

- 不加入或启用网易云歌词/元数据源；现有可选实现继续保持默认关闭。

## 验证

- `python3 tests/test_v0970_reader_documents.py`（含 EPUB 端点/守卫/上限断言）
- `go test ./...`（含 `TestEpubSpineOrderAndContent`、`TestEpubPathAndSizeGuards`、`TestEpubEntityAndTagHandling`、`TestEpubCapsAreReal`、`TestEpubEntryAndSpineCaps`；后者用 12×2MB 正文真实触发 truncation）
- EPUB 守卫测试在编写过程中真实抓到两个缺陷并已修复：`..` 路径未被拒绝、`<script>/<style>` 内容泄漏进正文，另发现收尾标签名解析为空导致正文被整体跳过。
- 完整 Python 契约、JavaScript 语法、Go vet/test/race、容器 E2E 和独立安全审查在发布前执行并记录实际结果。
