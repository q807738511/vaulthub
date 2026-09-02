#!/usr/bin/env python3
"""v0.8.6 契约：前端静态资源必须带版本号，且不能被浏览器长期缓存。

背景（真实故障）：v0.8.3 → v0.8.5 的前端修改（删除播放器设置/标记已读/下载按钮、
删除书架页电子书/漫画切换按钮）在服务端已经生效，但用户浏览器仍然执行 v0.8.3 的
/web/js/02-media.js。原因是 index.html 引用的是无版本号的固定路径，而 Caddy 的
静态响应没有 Cache-Control，浏览器按启发式规则复用了旧脚本。

因此本文件锁定三条约束：
1. index.html 引用的每个 js/css 都必须带 ?v=<版本> 查询串；
2. Caddyfile 必须让 HTML 入口 no-store，让带版本号的 /web/ 资源 immutable；
3. 前端必须有运行时版本一致性校验，脚本版本与页面版本不符时强制绕过缓存重载一次。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.9.16"

failures = []


def check(ok, message):
    if not ok:
        failures.append(message)


index_html = (ROOT / "index.html").read_text(encoding="utf-8")
caddyfile = (ROOT / "Caddyfile").read_text(encoding="utf-8")
boot = (ROOT / "web" / "js" / "04-boot.js").read_text(encoding="utf-8")
state = (ROOT / "web" / "js" / "01-state.js").read_text(encoding="utf-8")
media = (ROOT / "web" / "js" / "02-media.js").read_text(encoding="utf-8")

# ---- 1. 资源引用必须带版本号 ----
asset_refs = re.findall(r'(?:src|href)="(/web/(?:js|css)/[^"]+)"', index_html)
check(asset_refs, "index.html 未找到任何 /web/js 或 /web/css 引用")
for ref in asset_refs:
    check("?v=" in ref, f"资源引用缺少版本查询串，浏览器会继续用旧缓存：{ref}")
    check(
        ref.endswith(f"?v={VERSION}"),
        f"资源引用版本号与 v{VERSION} 不一致：{ref}",
    )

# 五个脚本 + 一个样式都必须在列
for name in ("01-state.js", "02-media.js", "03-features.js", "05-home.js", "04-boot.js", "main.css"):
    check(
        any(name in ref for ref in asset_refs),
        f"index.html 缺少 {name} 的带版本引用",
    )

# 脚本顺序不能被破坏
js_order = [ref for ref in asset_refs if ref.endswith(f"?v={VERSION}") and "/js/" in ref]
expected_order = [
    "/web/js/01-state.js",
    "/web/js/02-media.js",
    "/web/js/03-features.js",
    "/web/js/05-home.js",
    "/web/js/04-boot.js",
]
check(
    [ref.split("?")[0] for ref in js_order] == expected_order,
    f"脚本加载顺序被破坏：{[r.split('?')[0] for r in js_order]}",
)

# ---- 2. Caddy 缓存策略 ----
check("@versioned_asset" in caddyfile, "Caddyfile 未针对版本化静态资源设置缓存策略")
check("immutable" in caddyfile, "Caddyfile 未给带版本号的静态资源设置 immutable")
check(
    re.search(r'Cache-Control\s+"no-store', caddyfile) is not None,
    "Caddyfile 未让 HTML 入口 no-store，新版本入口页可能继续被缓存",
)
# /web/* 必须由独立的嵌套 handle 处理：Caddy 的指令排序把 try_files 排在 handle
# 之前，若 try_files 留在外层，缺失的 /web/ 资源会被改写成 index.html 再当脚本缓存。
check("handle /web/* {" in caddyfile, "Caddyfile 必须用独立的 handle /web/* 处理静态资源")
check(
    caddyfile.count("try_files {path} /index.html") == 1
    and caddyfile.index("handle /web/* {") < caddyfile.index("try_files {path} /index.html"),
    "SPA 回落必须只存在于 /web/* 之后的入口 handle 内",
)
check("@web_miss not file" in caddyfile, "Caddyfile 必须对缺失的 /web 资源禁用缓存")
# 版本串必须是语义版本，空值或 latest 之类不能拿到 immutable。
check(
    "[0-9]+" in caddyfile and "query v=*" not in caddyfile,
    "版本化匹配必须用语义版本正则，避免空 ?v= 或 ?v=latest 被长缓存",
)

# ---- 2b. 已存在安装的迁移 ----
# 容器优先使用持久化的 /data/Caddyfile，只换镜像不会带来新缓存头，
# 因此 manager 必须在启动时把策略迁移进去。
manager = (ROOT / "manager" / "main.go").read_text(encoding="utf-8")
check("cachePolicyMarker" in manager, "manager 必须带缓存策略迁移标记")
check("injectCachePolicy" in manager, "manager 必须在启动时迁移缓存策略到 /data/Caddyfile")
check(
    "handle /web/*" in manager and "max-age=31536000" in manager,
    "manager 注入的策略内容必须与镜像内 Caddyfile 一致",
)
check(
    'trimmed == "try_files {path} /index.html"' in manager,
    "迁移时必须移除旧的顶层 try_files，否则 /web/ 仍会回落成 index.html",
)

# ---- 3. 运行时版本一致性校验 ----
check(
    'VAULTHUB_ASSET_VERSION' in index_html,
    "index.html 未声明 VAULTHUB_ASSET_VERSION，前端无法自查资源版本",
)
check(
    f'VAULTHUB_ASSET_VERSION = "{VERSION}"' in index_html
    or f"VAULTHUB_ASSET_VERSION='{VERSION}'" in index_html
    or f'VAULTHUB_ASSET_VERSION="{VERSION}"' in index_html,
    f"index.html 的 VAULTHUB_ASSET_VERSION 必须是 {VERSION}",
)
check(
    f'VAULTHUB_SCRIPT_VERSION = "{VERSION}"' in state,
    f"01-state.js 必须声明 VAULTHUB_SCRIPT_VERSION = \"{VERSION}\"",
)
check(
    "ensureFreshAssets" in boot,
    "04-boot.js 缺少 ensureFreshAssets()，版本不一致时不会自动重载",
)
check(
    "ensureFreshAssets" in state,
    "01-state.js 缺少 ensureFreshAssets() 实现",
)
check(
    "sessionStorage" in state and "vaulthub_asset_reload" in state,
    "ensureFreshAssets() 必须用 sessionStorage 做一次性守卫，避免无限重载",
)
check(
    "location.replace" in state,
    "ensureFreshAssets() 必须触发重载",
)
# sessionStorage 可能被隐私模式/企业策略禁用，setItem 静默失败会导致无限刷新，
# 因此必须同时用 URL 上的 _vh 参数做第二道守卫。
check(
    'searchParams.get("_vh")' in state,
    "ensureFreshAssets() 必须同时用 URL 参数守卫，防止 sessionStorage 不可用时无限重载",
)
check(
    'searchParams.delete("_vh")' in state and "history.replaceState" in state,
    "版本对齐后必须把内部参数 _vh 从地址栏清掉",
)
# 04-boot.js 整个启动流程被包进 if/else 块。零缩进（文件顶层）的 const/let 会被
# 块作用域困住，其他文件读不到；块内部带缩进的局部声明是安全的。
for match in re.finditer(r"^(const|let|var)\s", boot, re.M):
    failures.append(f"04-boot.js 不能有文件顶层 {match.group(1)} 声明（会被块作用域困住）")

# H1：裸调用 ensureFreshAssets() 在「新 04-boot.js + 旧 01-state.js」的混合缓存
# 组合下会抛 ReferenceError，整个前端白屏。必须用 typeof 守卫。
check(
    'typeof ensureFreshAssets !== "function"' in boot or 'typeof ensureFreshAssets === "function"' in boot,
    "04-boot.js 必须用 typeof 守卫 ensureFreshAssets，避免混合缓存下 ReferenceError 白屏",
)
check(
    boot.index("typeof ensureFreshAssets") < boot.index("loadSettings();"),
    "typeof 守卫必须在任何初始化调用之前",
)

# WASM Worker 内部 importScripts 的 vendor 资产透传版本号
worker = (ROOT / "web" / "vendor" / "ffmpeg" / "worker.js").read_text(encoding="utf-8")
check(
    "ASSET_VERSION" in worker or "searchParams.get" in worker,
    "worker.js 必须把版本号透传给 importScripts / locateFile 的 vendor 资产",
)

# Worker 也是自有代码，必须带版本号，否则升级后短缓存内仍执行旧 Worker。
check(
    'worker.js?v=${encodeURIComponent(VAULTHUB_SCRIPT_VERSION)}' in media,
    "WASM Worker 的 URL 必须带 ?v=<版本>",
)

# ---- 4. 回归：旧 UI 不能复活 ----
check("setBookTypeView" not in media, "书架页电子书/漫画切换按钮不能回归")
check("↓ 下载" not in media, "播放器/阅读器不能保留下载按钮")
check("openMovieDetails" in media, "影视海报必须进入详情页")
check("movie-poster-settings" in media, "影视海报右下角必须有状态按钮")

# 视频播放器顶栏只允许关闭按钮：设置按钮关联异常、标记已读已内置到海报、下载已删除。
# 图书阅读器仍然需要「标记已读」，因此只约束 video 分支。
video_branch = re.search(r"const actions = video \?(.+?):\s*`\$\{toolbar\}", media, re.S)
check(video_branch is not None, "未找到 viewerShell() 的 video 分支")
if video_branch:
    branch = video_branch.group(1)
    check("media-reader-close" in branch, "视频播放器顶栏必须保留关闭按钮")
    for banned in ("settingsModal", "markReaderCompleted", "download"):
        check(banned not in branch, f"视频播放器顶栏不能再出现 {banned}")

# ---- 5. 版本文本 ----
check(
    index_html.count(f"v{VERSION}") >= 2,
    f"index.html 侧栏与关于页版本文本必须是 v{VERSION}",
)

if failures:
    print(f"FAIL: {len(failures)} 项 v{VERSION} 契约未满足")
    for item in failures:
        print("  -", item)
    sys.exit(1)

print(f"PASS: v{VERSION} 资源版本化与缓存策略契约通过")
