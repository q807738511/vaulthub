#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.91 静态契约：解/转码风向标、下滑自动翻页、刮削剧名修复、长会话（转码缓存 + 内存治理）。
与 tests/v0991_behavior.js（真实执行源码）互补：这里只做静态落点与文档一致性检查。"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.91.md").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_PLAY = (ROOT / "media-go/playback.go").read_text(encoding="utf-8")
GO_SCRAPE = (ROOT / "media-go/scrape_store.go").read_text(encoding="utf-8")
CI = (ROOT / ".gitea/workflows/validate.yml").read_text(encoding="utf-8")

OK = 0
FAILS = []


def check(name, cond, extra=None):
    global OK
    if cond:
        OK += 1
        print("PASS:", name)
    else:
        FAILS.append(name)
        print("FAIL:", name, "" if extra is None else extra)


print("v0.9.91 契约检查")

# ============ 1) 解/转码风向标 ============
check("1a 设置页新增服务端转/解码开关 + 风向标徽标 + 说明",
      'id="serverTranscode"' in HTML and 'id="transcodeCompass"' in HTML
      and 'id="transcodeCompassHint"' in HTML and "saveServerTranscode()" in HTML
      and 'data-i18n="stHint"' in HTML)
check("1b 前端设置：默认 auto、载入校验、保存函数、风向标渲染",
      'serverTranscode: "auto"' in STATE
      and 'if (["auto","off"].includes(s.serverTranscode))' in STATE
      and "function saveServerTranscode()" in STATE
      and "function updateTranscodeCompass(" in STATE)
check("1c 三语文案齐全（各 18 个新键 → setSt/stCompassFmt/vpDecodePath/stWeak 各 3 处）",
      STATE.count("setSt:") == 3 and STATE.count("stAuto:") == 3 and STATE.count("stOff:") == 3
      and STATE.count("stCompassFmt:") == 3 and STATE.count("vpDecodePath:") == 3
      and STATE.count("stWeak:") == 3 and STATE.count("pagerScrollHint:") == 3)
check("1d 前端策略开关与请求字段",
      "function serverTranscodeDisabled()" in MEDIA and "function serverTranscodePolicy()" in MEDIA
      and re.search(r"server_transcode:\s*serverTranscodePolicy\(\)", MEDIA) is not None)
check("1e 客户端解码标签 + 解码路径行 + 禁用时拒绝切兼容流",
      "本机设备解码 · 原画直放" in MEDIA and "function setVideoDecodePath(" in MEDIA
      and 'data-video-decode' in MEDIA
      and re.search(r"const useCompat = \(reason, url=compat\) => \{\s*\n\s*if \(serverTranscodeDisabled\(\)\)", MEDIA) is not None)
check("1f 后端：请求字段 + 强制原画直连 + 原盘 409 + warn 提醒",
      'ServerTranscode string `json:"server_transcode"`' in GO_PLAY
      and "func forceClientDirectPlan(" in GO_PLAY
      and 'plan.Hardware = "client"' in GO_PLAY
      and "原盘镜像无法本地直接播放" in GO_PLAY
      and 'Warn string `json:"warn,omitempty"`' in GO_MAIN)
check("1g 硬件探测暴露核数与弱算力提示",
      '"cores":         runtime.NumCPU()' in GO_MAIN and '"weak_cpu":' in GO_MAIN
      and '"software_only":' in GO_MAIN and '"runtime"' in GO_MAIN)
check("1h 风向标徽标样式（含告警态）", ".badge.warn" in CSS and ".status-decode" in CSS)

# ============ 2) 下滑自动翻页 ============
check("2a 翻页状态机与两种模式（window / offset）",
      "const mediaPagingState" in MEDIA and "function mediaPagingSet(" in MEDIA
      and "function mediaAutoPage(" in MEDIA
      and 'mode: more ? "window" : ""' in MEDIA and 'mode: "offset", group' in MEDIA
      and 'if (direction > 0 && st.mode === "window")' in MEDIA)
check("2b 到底/到顶判定 + 冷却窗口常量",
      "function mediaPagingEdge(" in MEDIA and "MEDIA_SCROLL_TRIGGER_PX" in MEDIA
      and "MEDIA_SCROLL_SETTLE_MS" in MEDIA
      and "now - Number(st.at || 0) < MEDIA_SCROLL_SETTLE_MS" in MEDIA)
check("2c 单一全局监听器（滚轮 + 键盘）且幂等",
      "function installMediaScrollPaging()" in MEDIA
      and "installMediaScrollPaging.done" in MEDIA
      and 'document.addEventListener("wheel"' in MEDIA
      and 'document.addEventListener("keydown"' in MEDIA)
check("2d 不抢播放器/阅读器键盘语义",
      'target.closest("[data-video-panel]")' in MEDIA and 'target.closest(".media-video-body")' in MEDIA
      and 'target.closest(".media-viewer-doc")' in MEDIA and 'target.closest(".comic-reader")' in MEDIA)
check("2e 书刊架与分页器都有下滑提示 + 提示样式",
      'esc(t("pagerScrollHint"))' in MEDIA and 'class="page-scroll-hint"' in MEDIA and ".page-scroll-hint" in CSS)
check("2f 渲染路径登记翻页状态（书刊架 / 重绘 / 分页）",
      MEDIA.count("mediaPagingSet({") >= 4 and "mediaPagingReset()" in MEDIA)
check("2g keepCount 语义生效（审查项：死代码）",
      "opts.keepCount !== true" in MEDIA and "keepCount: true" in MEDIA)

# ============ 3) 刮削剧名修复 ============
check("3a 服务端刮削结果库保留 show_title（结构体 + 清洗 + 空判定）",
      'ShowTitle string  `json:"show_title,omitempty"`' in GO_SCRAPE
      and "ShowTitle: clipScrapeText(in.ShowTitle, scrapeCacheMaxTitle)," in GO_SCRAPE
      and 'it.Title == "" && it.ShowTitle == ""' in GO_SCRAPE)
check("3b 前端上传字段白名单保留 show_title",
      re.search(r'MOVIE_SCRAPE_STORE_FIELDS = \["title", "show_title"', MEDIA) is not None)
check("3c 剧名修复函数 + 两条水合路径接入",
      "function repairSeriesShowTitle(" in MEDIA and MEDIA.count("repairSeriesShowTitle(") >= 3)
check("3d 展示链路优先 show_title（剧集聚合与播放器标题）",
      "meta.show_title || parsed.show" in MEDIA and "meta.show_title ? meta.title : \"\"" in MEDIA)

# ============ 4) 长会话：转码缓存 + 内存 ============
check("4a 兜底清理间隔 + 单条目上限常量",
      "cacheCleanupFallback = 10 * time.Minute" in GO_MAIN
      and "cacheEntryMaxShare   = 4" in GO_MAIN
      and "if interval > cacheCleanupFallback {" in GO_MAIN)
check("4b 单条目超配额直接丢弃 + 构建后立即清理",
      "budget/cacheEntryMaxShare" in GO_MAIN and "compat cache entry exceeds per-entry budget" in GO_MAIN
      and GO_MAIN.count("a.cleanCache()") >= 3)
check("4c 中断残留分片回收 + 新写入宽限期",
      'strings.Contains(name, ".mp4.")' in GO_MAIN and "staleCutoff" in GO_MAIN
      and "cacheFreshGrace" in GO_MAIN)
check("4d 缓存用量暴露给设置页",
      '"cache_bytes": a.cacheBytes' in GO_MAIN and '"cache_files": a.cacheFiles' in GO_MAIN
      and '"cache_cleaned_at": a.cacheCleanedAt' in GO_MAIN
      and "cacheBytes     int64" in GO_MAIN)
check("4e 前端只保留当前库的重型缓存（切库即释放）",
      "function releaseMediaHeavyCaches(" in MEDIA
      and "function readingStateIndexRelease(" in MEDIA
      and re.search(r"async function loadLocalFiles\(group, lib, offset = 0\) \{[\s\S]{0,200}releaseMediaHeavyCaches\(lib\.id\)", MEDIA) is not None)

# ============ 5) 版本与文档 ============
check("5a 资源版本号已升至本版（≥10 处）", HTML.count("?v=0.9.97") >= 10)
check("5b ASSET_VERSION / SCRIPT_VERSION = 0.9.91",
      'window.VAULTHUB_ASSET_VERSION = "0.9.97";' in HTML
      and 'const VAULTHUB_SCRIPT_VERSION = "0.9.97";' in STATE)
slogans = re.findall(r"v0\.9\.9\d · [^<\"]+", HTML)
check("5c 三处标语完全一致（审查项：断言强度，不只是前缀）",
      len(slogans) == 3 and len(set(slogans)) == 1, sorted(set(slogans)))
check("5d 更新日志顶部为 v0.9.97", LOG.lstrip().startswith("# VaultHub 蜀鼠之家 v0.9.97"))
check("5e 发布说明存在且覆盖四项反馈",
      (ROOT / ".github/RELEASE_NOTES_0.9.91.md").is_file()
      and "解/转码风向标" in NOTES and "下滑自动翻页" in NOTES
      and "刮削后的媒体名称展示规则没生效" in NOTES and "打开时间较长后媒体及页面失去响应" in NOTES)
check("5f Compose 仍跟随 Docker Hub latest（主仓库未变）",
      "image: docker.io/q807738511/vaulthub:latest" in COMPOSE)
check("5g 审查项：面板提示行重置旧胶囊底色",
      re.search(r"\.video-status-panel \.status-compat \{[\s\S]{0,260}background:none; padding:0; border-radius:0;", CSS) is not None)
# v0.9.94（客户要求）：CI 只做「静态校验 + 构建推送」，不在 CI 跑前端测试套件
# （前端/行为测试在发布流程内于 Hermes 侧跑完再推 tag）。旧断言要求 CI 里有
# python3 测试步骤，与现行要求相反，改写到新口径并要求旧实现已删除。
check("5h CI 只做校验与推送，不再跑前端测试套件",
      "前端测试套件" not in CI.split("# GitHub 原版")[0]
      and 'for f in tests/test_*.py' not in CI
      and "command -v python3" not in CI
      and "检查 JavaScript 语法" in CI and "检查 Go 服务" in CI)

print(f"\n==================== v0.9.91 契约: {OK} checks, FAIL={len(FAILS)}")
if FAILS:
    print("FAILED:", ", ".join(FAILS))
    raise SystemExit(1)
print("PASS: v0.9.91 契约全部通过")
