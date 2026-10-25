#!/usr/bin/env python3
# v0.9.94 契约测试：9 项需求 + CI 简化 + 缓存卷 + 文档/版本（静态检查）
# 口径：断言「新实现存在」且「旧实现已不存在」，删掉功能不是只删测试。
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILED = []

def rd(p):
    with io.open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()

def check(label, cond, detail=""):
    if cond:
        print(f"  ✔ {label}")
    else:
        print(f"  ✗ {label}" + (f"  [{detail}]" if detail else ""))
        FAILED.append(label)

HTML = rd("index.html")
CSS = rd("web/css/main.css")
M = rd("web/js/02-media.js")
S = rd("web/js/01-state.js")
T = rd("web/js/07-topnav.js")
COMPOSE = rd("docker-compose.yml")
VALIDATE = rd(".gitea/workflows/validate.yml")
PUBLISH = rd(".gitea/workflows/publish-image.yml")
RELEASE_SH = rd("scripts/ci-release-gitea.sh")
MAIN_GO = rd("media-go/main.go")
DISK_GO = rd("media-go/v0986_container_disk.go")
STORE_GO = rd("media-go/scrape_store.go")

print("== 需求1 迷你播放器常驻顶栏（搜索框左侧） ==")
actions = HTML[HTML.find('<div class="tn-actions">'):HTML.find('<div class="tn-pop" id="topUserMenu"')]
check("1a 迷你播放器在 .tn-actions 内", 'id="playbackDock"' in actions)
check("1b 迷你播放器在搜索图标左侧", 0 <= actions.find('id="playbackDock"') < actions.find('id="tnSearchButton"'))
check("1c 搜索图标在通知喇叭左侧", 0 < actions.find('id="tnSearchButton"') < actions.find('class="tn-notify-wrap"'))
check("1d 顶栏外不再有第二个浮标", HTML.count('id="playbackDock"') == 1)
check("1e 浮标不再是固定定位的左下角浮层", "position:fixed" not in CSS.split(".playback-dock {")[1].split("}")[0])
check("1f 浮标显示条件：只在「播放面不可见」且未占满窗口时显示（v0.9.97 口径）",
      "const show = !!cur && !immersive && !surfaceVisible;" in S
      and 'typeof playbackSurfaceVisible === "function" ? !!playbackSurfaceVisible(cur) : false' in S
      and "player-immersive" in S.split("function updatePlaybackDock()")[1][:900])
check("1f2 v0.9.94 的「有播放就显示」旧条件已不存在",
      "const show = !!cur && !immersive;" not in S)
check("1g 回到播放/暂停/主动关闭三个入口仍在", all(k in HTML for k in ['returnToActivePlayback()', 'toggleActivePlayback()', 'stopActivePlayback()']))

print("== 需求2 搜索框→放大镜图标 + 搜索弹窗 ==")
check("2a 旧顶栏搜索框已移除", 'id="topSearch"' not in HTML and 'id="topSearchKbd"' not in HTML)
check("2b 放大镜图标按钮存在", 'id="tnSearchButton"' in HTML and "toggleMediaSearchModal()" in HTML)
check("2c 搜索弹窗存在且唯一", HTML.count('id="mediaSearchModal"') == 1)
check("2d 弹窗沿用原搜索输入/结果/徽标 id", all(k in HTML for k in ['id="mediaSearchInput"', 'id="mediaSearchResults"', 'id="mediaSearchBadge"']))
check("2e 弹窗带弹出动画", "@keyframes searchModalPop" in CSS and ".search-modal-mask.show .search-modal" in CSS)
check("2f 顶栏搜索框 CSS 已删除", ".tn-search {" not in CSS)
check("2g 弹窗开合 API 齐备", all(k in T for k in ["function openMediaSearchModal", "function closeMediaSearchModal", "function toggleMediaSearchModal", "function syncSearchButtonState"]))
check("2h Ctrl+K 打开弹窗、Esc/点遮罩关闭", "openMediaSearchModal();" in T and "closeMediaSearchModal();" in T and 'classList.contains("search-modal-mask")' in T)
check("2i 搜索词来源指向弹窗输入框", 'function topNavSearchBox() { return document.getElementById("mediaSearchInput"); }' in T)
check("2j openMediaSearch 打开弹窗（不再切视图）", "openMediaSearchModal();" in M.split("function openMediaSearch()")[1][:600])
check("2k 旧 #view-search 落点自动弹窗", 'if (v === "search" && typeof openMediaSearchModal === "function") openMediaSearchModal();' in S)

print("== 需求3 去除视频播放器随机/重复 ==")
check("3a 重复/随机按钮已删除", "data-video-repeat-button" not in M and "data-video-shuffle-button" not in M)
check("3b 重复/随机函数与状态已删除", not any(k in M for k in ["cycleVideoRepeat", "toggleVideoShuffle", "VIDEO_REPEAT_ORDER", "videoRepeatMode", "videoShuffleOn"]))
check("3c body 上的 repeat/shuffle 标记已删除", 'data-video-repeat=' not in M and 'data-video-shuffle=' not in M)
check("3d i18n 里的 vpRepeat/vpShuffle 已删除（3 语言）", not any(k in S for k in ["vpRepeat", "vpShuffle"]))
check("3e 播完仍自动连播下一集（剧集），电影停结尾", "videoPlaybackEnded(root, video)" in M and "root.dataset.videoPlaylistEligible !== \"true\"" in M)

print("== 需求4 小窗态缩放 + 还原按钮 + 最大化位置 ==")
check("4a 顶栏不再放全屏按钮", '<div class="vc-top">' in M and M.split('<div class="vc-top">')[1][:400].count("vc-fullscreen") == 0)
vcright = M.split('class="vc-right"')[1][:1400]
order = [vcright.find('data-video-panel-button="playlist"'), vcright.find('data-video-panel-button="settings"'),
         vcright.find("vc-fullscreen"), vcright.find('data-video-panel-button="more"')]
check("4b 右下角顺序：播放列表 → 设置 → 最大化 → 更多", all(x >= 0 for x in order) and order == sorted(order))
# v0.9.99（需求3）：小窗高度 138 → 112，控制器进一步收紧（24px）。
check("4c 小窗态控制器按钮同步缩小", ".video-controller-docked .vc-icon { width:24px; height:24px; }" in CSS)
check("4d 小窗视频尺寸收紧到 132x74", "width:132px; height:74px" in CSS)
# v0.9.99（需求3）：还原按钮改为常显可点（客户反馈：缩小后按钮消失、无法还原）。
check("4e 还原按钮位于左侧视频画面上方且常显可点",
      ".video-minimized.video-controller-docked .vc-restore {" in CSS
      and "opacity:1; visibility:visible; pointer-events:auto;" in CSS)
check("4f 触屏无 hover 时直接显示还原按钮", "@media (hover: none)" in CSS)

print("== 需求5 VCD 双实心三角快进/快退 ==")
check("5a 快退为双实心左三角", 'back10: \'<path d="M11.4 5.6 4.6 12l6.8 6.4Z"' in M)
check("5b 快进为双实心右三角", 'fwd10: \'<path d="M12.6 5.6 19.4 12l-6.8 6.4Z"' in M)
check("5c 旧的圆弧旋转箭头已不存在", "13.4 4.5a8 8 0 1 1-7.9 8.6" not in M and "10.6 4.5a8 8 0 1 0 7.9 8.6" not in M)

print("== 需求6 音频模式弹窗禁用（只在循环图标内展示） ==")
cycle = M.split("function cycleAudioLoop()")[1][:200]
check("6a 切换模式不再弹窗（无 toast）", "toast(" not in cycle)
check("6b 四个模式四个图标", 'const AUDIO_LOOP_ICON = { sequence: "sequence", list: "repeat", single: "repeatOne", random: "shuffle" };' in M)
check("6c 顺序播放图标已补充", "sequence: '<path d=\"M4.4 6.6h11.2" in M)
check("6d 模式写进 data-loop-mode（可断言/可用样式）", "button.dataset.loopMode = audioLoopMode;" in M)

print("== 需求7 设置按钮 = 斜向一大一小两个齿轮 ==")
settings_icon = M.split("settings: '<circle cx=\"9.5\" cy=\"14\"")[1][:400] if "settings: '<circle cx=\"9.5\" cy=\"14\"" in M else ""
check("7a 大齿轮（左下）+ 小齿轮（右上）", 'cx="9.5" cy="14" r="3.3"' in M and 'cx="17.6" cy="8.4" r="2.05"' in M)
check("7b 旧单齿轮图标已替换", 'settings: \'<circle cx="12" cy="12" r="2.9"' not in M)
check("7c 头像菜单的系统设置也用同一双齿轮", 'class="ic ic-gear"' in HTML and 'cx="17.6" cy="8.4"' in HTML)

print("== 需求8 缓存走独立映射卷，不落主 /data ==")
check("8a compose 给出独立缓存卷挂载", "/data/transcode-cache" in COMPOSE and re.search(r"-\s+\S+:/data/transcode-cache", COMPOSE) is not None)
check("8b compose 显式声明 MEDIA_CACHE_DIR", "MEDIA_CACHE_DIR=/data/transcode-cache" in COMPOSE)
check("8c Go 默认值仍是 /data/transcode-cache", 'a.cacheDir = env("MEDIA_CACHE_DIR", "/data/transcode-cache")' in MAIN_GO)
check("8d 启动自检缓存卷并打印结论", "func (a *App) reportCacheVolume()" in MAIN_GO and "a.reportCacheVolume()" in MAIN_GO)
check("8e cacheDisk 判定独立卷（比对设备）", "func cacheDisk(" in DISK_GO and "out.Separate = out.Device != \"\" && out.DataDevice != \"\" && out.Device != out.DataDevice" in DISK_GO)
check("8f 设置快照与硬件卡上报缓存卷", '"cache_dir_separate"' in MAIN_GO and '"cache_disk": cacheDisk(' in MAIN_GO)

print("== 需求9 多季度分离刮削（标签关联） ==")
check("9a 季标签解析函数存在", "function parseSeriesSeasonTag(text)" in M and "function seriesSeasonTagOf(path)" in M)
check("9b 支持 S0N / 第N季 两种写法", "SERIES_SEASON_TAG_RE" in M and "SERIES_SEASON_TAG_CN_RE" in M)
check("9c 归组键支持标签剧名（多季归一张卡）", 'return ("tag:" + seasonTag.show).toLowerCase();' in M)
check("9d 卡片名回落标签剧名", "show.title = String(tagShow || parsed.show" in M)
check("9e 刮削查询词用标签剧名", "const searchTitle = seasonTag && seasonTag.show ? seasonTag.show : title;" in M)
check("9f 按季取详情并写回季名/季简介/季海报/分集名", "async function fetchSeriesSeason(" in M and "patch.season_tag = seasonTag.show + seasonTag.tag;" in M)
check("9g 有季标签时跳过 TVDB 分支", "scraperStatus.tvdb_enabled && !seasonTag" in M)
check("9h 季字段进持久化白名单", all(k in M.split("MOVIE_SCRAPE_STORE_FIELDS")[1][:600] for k in ['"season_num"', '"season_tag"', '"season_name"', '"season_overview"']))
check("9i Go 结果库结构含季字段并做限长", all(k in STORE_GO for k in ["SeasonNum", "SeasonTag", "SeasonName", "SeasonOverview"]) and "clipScrapeText(in.SeasonTag, scrapeCacheMaxSmall)" in STORE_GO)
check("9j TMDB 代理放开 tv/{id}/season/{n} 且季号校验", 'endpoint = "tv/" + id + "/season/" + strconv.Itoa(n)' in MAIN_GO and '"invalid TMDB season"' in MAIN_GO)
check("9k 季端点不带 append_to_response", 'if !strings.Contains(endpoint, "/season/") {' in MAIN_GO)
check("9l 编辑弹窗说明标签写法", 'id="mediaEditTags"' in HTML and "剧名S04" in HTML and 'data-i18n="editSeasonHint"' in HTML)

print("== CI：只做校验与推送，不跑前端测试套件 ==")
check("c1 validate.yml 不再有「前端测试套件」步骤",
      "- name: 前端测试套件" not in VALIDATE and "for f in tests/test_*.py" not in VALIDATE.split("# GitHub 原版")[0])
check("c2 publish-image.yml 不再有「前端测试套件」步骤", "- name: 前端测试套件" not in PUBLISH)
check("c3 工作流不再依赖 python3（无 command -v python3 / 无 python3 命令调用）",
      "command -v python3" not in VALIDATE and "command -v python3" not in PUBLISH
      and not re.search(r"^\s*python3\s", VALIDATE, re.M) and not re.search(r"^\s*python3\s", PUBLISH, re.M)
      and "for t in sh git node gcc make go docker curl" in PUBLISH)
check("c4 仍然做静态校验（shell/JS/Go/C/compose）", all(k in VALIDATE for k in ["检查 shell 脚本语法", "检查 JavaScript 语法", "检查 Go 服务", "检查遗留 C 源码", "校验 Compose 与 Caddyfile"]))
check("c5 推送与 Release 步骤仍在", "构建并推送镜像到 Docker Hub" in PUBLISH and "在 Gitea 上创建 / 更新 Release" in PUBLISH)
check("c6 Release JSON 转义优先用 node", 'if command -v node >/dev/null 2>&1; then\n    node -e' in RELEASE_SH)

print("== 版本 / 文档 ==")
# 与版本号无关：所有 ?v= 都必须是本版，且恰好 10 处（下一版不会因此改测试）。
check("v1 资源缓存键全部为本版且无历史残留",
      set(re.findall(r"\?v=([0-9.]+)", HTML)) == {"1.0.11"} and len(re.findall(r"\?v=1\.0\.11", HTML)) >= 10,
      sorted(set(re.findall(r"\?v=([0-9.]+)", HTML))))
check("v2 资源版本常量", 'window.VAULTHUB_ASSET_VERSION = "1.0.11";' in HTML and 'const VAULTHUB_SCRIPT_VERSION = "1.0.11";' in S)
SLOGAN = "v1.0.11 · NFO 补全 · 音乐随点随开 · 大库不卡"
check("v3 标语三处整串一致", HTML.count(SLOGAN) == 3)
import re as _re
_CUR = _re.search(r'VAULTHUB_ASSET_VERSION = "([0-9.]+)"', HTML).group(1)
_NOTES_PATH = os.path.join(ROOT, f".github/RELEASE_NOTES_{_CUR}.md")
check("v4 发布说明文件存在且够长（版本无关：按 index.html 里的当前版本找）",
      os.path.exists(_NOTES_PATH) and len(open(_NOTES_PATH, encoding="utf-8").read()) >= 500)
log = rd("Update Log.md")
check("v5 Update Log 有 v0.9.97 段", "0.9.97" in log and "顶栏迷你播放器" in log)
check("v6 i18n 新键三语言齐备", S.count("searchLead:") == 3 and S.count("editSeasonHint:") == 3)

print()
if FAILED:
    print(f"未通过 {len(FAILED)} 项：")
    for f in FAILED:
        print("  -", f)
    sys.exit(1)
print("v0.9.94 契约测试全部通过")
