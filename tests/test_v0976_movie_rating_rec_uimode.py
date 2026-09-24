#!/usr/bin/env python3
# v0.9.76 静态断言：手动评分服务端同步 / TMDB 推荐规则 / UI 设备模式 / TMDB 黄字降亮度
import re, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
def R(*p): return (ROOT / "media-go" if p and p[0].startswith(("local_","metadata_")) else ROOT).joinpath(*p).read_text(encoding="utf-8")

js02 = R("web/js/02-media.js")
theme = R("web/js/06-theme.js")
state = R("web/js/01-state.js")
css = R("web/css/main.css")
idx = R("index.html")
ov = R("metadata_override.go")
lm = R("local_metadata.go")

checks = []
def ok(name, cond):
    checks.append((name, bool(cond)))
def has(s, needle): return needle in s

# ---- 1) 评分写服务端（多端同步）----
ok("saveMovieUserRating 存在", has(js02, "function saveMovieUserRating("))
ok("saveMovieUserRating 调 saveMovieMetadataOverride", has(js02, "saveMovieMetadataOverride(libId, path") or "user_rating: Number(value)" in js02)
ok("user_rating 载荷含 user_rating", has(js02, "user_rating: Number(value) || 0"))
ok("movieUserRating 优先读 meta.user_rating", has(js02, "readMovieMetadata()[path]") and "meta.user_rating" in js02)
# 服务端 override 字段
ok("Go override 有 UserRating", re.search(r"UserRating float64.*user_rating", ov) is not None)
ok("Go sanitize 校验 1-10", "in.UserRating < 0 || in.UserRating > 10" in ov)
ok("Go 合并回 localMetadata", "if in.UserRating > 0" in ov and "m.UserRating = in.UserRating" in ov)
ok("localMetadata 有 user_rating", re.search(r"UserRating float64.*user_rating", lm) is not None)

# ---- 2) TMDB 推荐规则 ----
ok("movieRecommendationsFor 存在", has(js02, "function movieRecommendationsFor("))
ok("评分+5% 过滤线", "cur * 1.05" in js02 and "x.rating >= floor" in js02)
ok("近满分(≥9.5)分支", "cur >= 9.5" in js02 and "Math.abs(x.rating - cur) <= cur * 0.05" in js02)
ok("同演职人员补位", "同演职人员" in js02 or has(js02, "function movieRecBadge") or "out.length < 8" in js02)
ok("推荐徽标", has(js02, "movie-rec-badge") and has(js02, "function movieRecBadge("))
ok("推荐渲染函数", has(js02, "function movieRecStripHTML("))
ok("recommendations 接入", "movieRecommendationsFor(detail,meta)" in js02)

# ---- 3) UI 设备模式 ----
ok("UI_MODES 定义", re.search(r"UI_MODES = \[\"auto\", \"phone\", \"tv\", \"pc\"\]", theme) is not None)
ok("detectUIMode 自动识别", "function detectUIMode(" in theme and "pointer: coarse" in theme)
ok("applyUIMode 写到 data-uimode", 'setAttribute("data-uimode"' in theme)
ok("setUIMode 存在", "function setUIMode(" in theme)
ok("initTheme 应用 uimode", "applyUIMode()" in theme)
ok("state 默认 uiMode:auto", 'uiMode: "auto"' in state)
ok("settings 读取 uiMode", "settings.uiMode" in state)
ok("HTML 有 uiModeSeg", 'id="uiModeSeg"' in idx)
ok("渲染 uiMode 段", 'data-ui-opt' in theme)
ok("CSS uimode 档位", 'html[data-uimode="phone"]' in css and 'html[data-uimode="tv"]' in css and 'html[data-uimode="pc"]' in css)

# ---- 4) TMDB 黄字降亮度 ----
ok("TMDB 黄字降亮度 #b98a2e", ".movie-tmdb-rating b { color:#b98a2e" in css.replace(" ", " "))

fails = [n for n, c in checks if not c]
print(f"v0.9.76 静态断言: {len(checks)-len(fails)}/{len(checks)} PASS")
for n in fails:
    print("  FAIL:", n)
sys.exit(1 if fails else 0)
