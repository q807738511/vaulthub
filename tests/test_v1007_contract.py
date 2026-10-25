#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.9 契约测试（L1 静态层）：冻结 P0 对外面 + 端点收紧 + 播放进度持久化。

覆盖八组：
  1. 契约文档：docs/api/ 三件套入库，且勘误项已改（subtitle 鉴权、2*time.Minute、cover 决策）；
  2. 无鉴权面收紧：libraries GET / index/status / probe / hardware / scrapers 五个 handler
     必须在校验通过前不产出数据（readAuth 在前）；
  3. 播放进度持久化：路由注册、文件存储（MEDIA_PLAYBACK_PROGRESS）、钳制/完成态、幂等删除；
  4. 前端配套：未登录跳过启动拉取、登录后补拉、首页轮询门槛、播放器写/读服务端进度；
  5. 契约字符串与别名：错误文案不变、archive/caddyfile 别名 canonical 标注；
  6. 跨服务隐式契约：media-go 只认 /api/session/check 的 200；
  7. 版本纪律：1.0.9 全链路一致（bump 后本文件跟随当前版本）；
  8. 禁用字面量：内网地址 / 容器卷路径不得进源码。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
GOMAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GOPROG = (ROOT / "media-go/playback_progress.go").read_text(encoding="utf-8")
GOPROGTEST = (ROOT / "media-go/v1007_playback_progress_test.go").read_text(encoding="utf-8")
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text(encoding="utf-8")
INVENTORY = (ROOT / "docs/api/ROUTE_INVENTORY.md").read_text(encoding="utf-8")
CTESTS = (ROOT / "docs/api/CONTRACT_TESTS.md").read_text(encoding="utf-8")
VERSION = "1.0.9"

checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))


# ---------------- 1. 契约文档入库与勘误 ----------------
for f in ("openapi.yaml", "ROUTE_INVENTORY.md", "CONTRACT_TESTS.md"):
    check(f"1 文档入库 {f}", (ROOT / "docs/api" / f).is_file())
check("1a openapi 覆盖 P0 核心路径",
      all(p in OPENAPI for p in ("/api/login", "/api/media/files", "/api/media/playback/plan",
                                 "/api/media/playback/sessions", "/api/media/reading/progress",
                                 "/api/media/subtitles/search", "/api/media/playback/progress")))
check("1b subtitle 鉴权勘误已改（不再声称零校验）",
      "完全不校验" not in INVENTORY and "sessionOK()" in INVENTORY)
check("1c 字幕 download 不再标 security: []",
      "当前服务自身无鉴权" not in OPENAPI)
check("1d L1 样例心跳断言已勘误为 -2 * time.Minute",
      '"-2 * time.Minute" in PLAYBACK' in CTESTS and '"2*time.Minute" in PLAYBACK' not in CTESTS)
check("1e cover 公开为显式决策",
      "有意决策" in OPENAPI and "分享" in OPENAPI)

# ---------------- 2. 五端点收紧 ----------------
# 注：注释里的版本号是历史标注（收紧发生在 v1.0.9），断言只认「契约收紧」这个标记本身。
check("2a libraries GET 需会话",
      'if r.Method == "GET" {\n\t\t/* v' in GOMAIN and "契约收紧" in GOMAIN.split('func (a *App) libraries(')[1][:400]
      and "readAuth(r)" in GOMAIN.split('func (a *App) libraries(')[1][:400])
check("2b indexStatus 需会话",
      "func (a *App) indexStatus(w http.ResponseWriter, r *http.Request) {\n\t/* v" in GOMAIN
      and "readAuth(r)" in GOMAIN.split("func (a *App) indexStatus(")[1][:400])
check("2c probe 需会话",
      'mux.HandleFunc("/api/media/probe", func(w http.ResponseWriter, r *http.Request) {\n\t\t/* v' in GOMAIN
      and "readAuth(r)" in GOMAIN.split('mux.HandleFunc("/api/media/probe"')[1][:400])
check("2d hardware 需会话",
      'mux.HandleFunc("/api/media/hardware", func(w http.ResponseWriter, r *http.Request) {\n\t\t/* v' in GOMAIN
      and "readAuth(r)" in GOMAIN.split('mux.HandleFunc("/api/media/hardware"')[1][:400])
check("2e scrapers 需会话",
      'mux.HandleFunc("/api/media/scrapers", func(w http.ResponseWriter, r *http.Request) {\n\t\t/* v' in GOMAIN
      and "readAuth(r)" in GOMAIN.split('mux.HandleFunc("/api/media/scrapers"')[1][:400])
check("2f 收紧后五个端点均在鉴权后才产出数据",
      all(seg.split("login required")[0].count("readAuth") >= 1
          for seg in [GOMAIN.split('mux.HandleFunc("/api/media/probe"')[1][:300],
                      GOMAIN.split('mux.HandleFunc("/api/media/hardware"')[1][:300],
                      GOMAIN.split('mux.HandleFunc("/api/media/scrapers"')[1][:300]]))

# ---------------- 3. 播放进度持久化 ----------------
check("3a 路由已注册", 'mux.HandleFunc("/api/media/playback/progress", a.playbackProgress)' in GOMAIN)
check("3b 存储可配置且有默认路径",
      'MEDIA_PLAYBACK_PROGRESS' in GOPROG and "/data/media-playback-progress.json" in GOPROG)
check("3c 鉴权门在业务逻辑之前",
      GOPROG.index("if !writeAuth(r)") < GOPROG.index("a.find(r.URL.Query().Get(\"id\"))"))
check("3d 位置钳制到 duration", "in.PositionMS > in.DurationMS" in GOPROG and "in.PositionMS = in.DurationMS" in GOPROG)
check("3e 负数拒绝", "in.PositionMS < 0" in GOPROG and "invalid playback progress" in GOPROG)
check("3f 完成态推断（≥95%）", "0.95*float64(in.DurationMS)" in GOPROG)
check("3g 删除幂等（removed=false 也 200）",
      '"removed": false' in GOPROG and "method not allowed" in GOPROG)
check("3h 路径包含性校验复用 safeFile", "safeFile(lib, mediaPath)" in GOPROG)
check("3i 原子落盘（tmp + rename）", 'store + ".tmp"' in GOPROG and "os.Rename(tmp, store)" in GOPROG)
check("3j Go 侧单测覆盖往返/钳制/删除/鉴权/重启",
      all(t in GOPROGTEST for t in ("TestPlaybackProgressRoundTrip", "TestPlaybackProgressClampsAndCompletes",
                                    "TestPlaybackProgressDeleteAndPathGuard", "TestPlaybackProgressRequiresSession",
                                    "TestPlaybackProgressPersistsAcrossInstances")))
check("3k openapi 记录新端点三方法",
      "/api/media/playback/progress:" in OPENAPI and "PlaybackProgressEntry" in OPENAPI
      and "PlaybackProgressWrite" in OPENAPI)

# ---------------- 4. 前端配套 ----------------
check("4a 未登录不拉硬件能力",
      'if (typeof vaultHubAuthenticated === "function" && vaultHubAuthenticated()) refreshHardwareStatus();' in BOOT)
check("4b 登录后补拉链路存在",
      "async function bootAfterLogin" in BOOT and "refreshMediaLibraries(false)" in BOOT)
check("4c 登录成功触发补拉",
      'if(typeof bootAfterLogin==="function") bootAfterLogin();' in STATE)
check("4d 首页轮询加登录门槛",
      "!vaultHubAuthenticated()) return;" in HOME)
check("4e 播放器进度落服务端（PUT playback/progress）",
      "/api/media/playback/progress?id=" in MEDIA and "method: \"PUT\"" in MEDIA)
check("4f 跨设备恢复断点（GET playback/progress）",
      "entry.position_ms" in MEDIA and "entry.completed" in MEDIA)
check("4g 关闭/暂停播放器强制落库",
      re.search(r"saveVideoPlaybackState\(\s*(video|vp)\s*,\s*true\s*\)", MEDIA) is not None)
check("4h 15s 节流避免每 250ms 写盘",
      "15000" in MEDIA.split("function saveVideoPlaybackState")[1][:800])

# ---------------- 5. 契约字符串与别名 ----------------
check("5a 错误文案契约字符串仍在",
      all(s in GOMAIN for s in ('"login required"', '"invalid media path"', '"library not found"', '"file not found"')))
check("5b archive 别名 canonical 标注", "2.2b 别名与 canonical" in INVENTORY
      and "`/api/media/archive/zip`" in INVENTORY and "`/api/media/zip`" in INVENTORY)
check("5c caddyfile 别名 canonical 标注", "`/api/admin/caddyfile`" in INVENTORY and "`/api/admin/caddy/config`" in INVENTORY)
check("5d 字幕双注册在契约里有说明", "双注册" in INVENTORY)

# ---------------- 6. 跨服务隐式契约 ----------------
check("6a media-go 回环校验 session/check",
      "/api/session/check" in GOMAIN and "http.StatusOK" in GOMAIN)

# ---------------- 7. 版本纪律 ----------------
check("7a index.html 资源查询串全部 1.0.9",
      HTML.count("?v=1.0.9") >= 12 and "?v=1.0.6" not in HTML)
check("7b 资源版本常量", f'VAULTHUB_ASSET_VERSION = "{VERSION}"' in HTML or f"VAULTHUB_ASSET_VERSION='{VERSION}'" in HTML
      or f'VAULTHUB_ASSET_VERSION = \'{VERSION}\'' in HTML or f'"{VERSION}"' in HTML.split("VAULTHUB_ASSET_VERSION")[1][:40])
check("7c 脚本版本常量", f'VAULTHUB_SCRIPT_VERSION = "{VERSION}"' in STATE)
check("7d 页尾标语含当前版本", "v1.0.9 ·" in HTML and ("刮削落盘" in HTML or "大库不卡" in HTML))

# ---------------- 8. 禁用字面量 ----------------
FORBIDDEN = [r"enged\.top", r"192\.168\.", r"/vol[1-4]"]
sources = [HTML, STATE, MEDIA, HOME, BOOT, GOPROG, GOMAIN, OPENAPI, INVENTORY, CTESTS]
hits = []
for idx, src in enumerate(sources):
    for pat in FORBIDDEN:
        if re.search(pat, src):
            hits.append(f"src{idx}:{pat}")
check("8a 源码与文档无内网地址/容器卷路径", not hits, ",".join(hits))

failed = [(n, d) for n, ok, d in checks if not ok]
for name, ok, detail in checks:
    print(("PASS: " if ok else "FAIL: ") + name + (f"  [{detail}]" if detail and not ok else ""))
print(f"\nSUMMARY {len(checks) - len(failed)}/{len(checks)} PASS")
if failed:
    raise SystemExit("FAIL: v1.0.9 契约测试未通过")
print("PASS: v1.0.9 契约（文档入库 / 端点收紧 / 播放进度持久化 / 前端配套）全部满足")
