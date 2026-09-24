#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.76 影视详情契约：分享可用 / 十分制五星图示评分 / TMDB 评分展示 / 收藏可取消 / 圆形头像演职人员。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HTMLF = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")

passed = failed = 0
def check(name, ok, extra=""):
    global passed, failed
    if ok: passed += 1; print("PASS:", name)
    else: failed += 1; print("FAIL:", name, extra)

# --- A. 分享修复：三级降级 + 可见反馈 ---
check("A1 分享安全上下文优先系统分享", "if (navigator.share && window.isSecureContext)" in MEDIA and "navigator.share({ title, text, url })" in MEDIA)
check("A2 剪贴板仅在安全上下文使用", "navigator.clipboard && window.isSecureContext" in MEDIA)
check("A3 execCommand 复制兜底（http 环境可用）", "function copyTextFallback(text)" in MEDIA and 'document.execCommand("copy")' in MEDIA)
check("A4 分享面板是兜底可用方式（链接可选中 + 复制按钮）", "function openShareDialog(info)" in MEDIA and 'id="shareLinkInput"' in MEDIA and "function copyShareLink(button)" in MEDIA)
check("A4b 复制失败有可见反馈（不再静默吞错）", "浏览器拒绝自动复制" in MEDIA and "请手动选中链接框里的地址" in MEDIA)
check("A4c 分享入口真的调用面板（不只是定义）", "openShareDialog({ libId, path, title, url, external, reachable })" in MEDIA and "async function shareMovie(libId, path, title)" in MEDIA)
check("A5 分享文案带库与路径定位", '"?media=movie&lib="' in MEDIA and '"&path="' in MEDIA)
check("A6 分享按钮传 libId/path/title", "shareMovie(${jsAttrArg(lib.id)},${jsAttrArg(path)},${jsAttrArg(meta.title)})" in MEDIA)
check("A7 内网默认用当前访问地址，配置外网地址后优先", "function shareBaseURL()" in MEDIA and "scraperStatus.share_public_base" in MEDIA and "location.origin" in MEDIA)
check("A8 外网地址分享前可达性探测（不可达仅提示不阻断）", "function verifyShareReachable(base)" in MEDIA and "AbortSignal.timeout(2000)" in MEDIA and "外网地址暂不可达" in MEDIA)
check("A9 分享面板区分内外网并提示可达性", "内网分享：使用当前访问的 IP:端口" in MEDIA and "使用系统设置中的外网地址" in MEDIA)

# --- B. 十分制五星图示评分（鼠标跟踪）---
check("B1 五星半星步进渲染（movieStarsFor）", "function movieStarsFor(value)" in MEDIA and 'class="movie-star-fill"' in MEDIA)
check("B2 鼠标悬停跟踪预览", "function movieStarHover(event, host)" in MEDIA and "onmousemove=\"movieStarHover(event,this)\"" in MEDIA)
check("B3 移出恢复已存评分", "function movieStarLeave(host)" in MEDIA and "onmouseleave=\"movieStarLeave(this)\"" in MEDIA)
check("B4 点击落定并写 localStorage", "function movieStarClick(event, host)" in MEDIA and 'localStorage.setItem(movieStateKey("rating"' in MEDIA)
check("B5 旧 prompt 输入已移除", 'prompt("请为该视频评分' not in MEDIA)
check("B6 分值换算：每星 2 分、过半才 +1（正中按半星）", "(Number(target.dataset.star) * 2 - 1) + (rel > 0.5 ? 1 : 0)" in MEDIA)
check("B7 五星图示 CSS（黄色软星）", ".movie-star-fill" in CSS and "#f5b301" in CSS and ".movie-stars" in CSS)

# --- C. TMDB 评分展示 ---
check("C1 hero 有 TMDB 评分徽标", 'class="movie-tmdb-rating"' in MEDIA and "TMDB" in MEDIA)
check("C2 徽标用 meta.rating 渲染、无分不显示", "meta.rating ? `<b>⭐ ${meta.rating.toFixed(1)}</b><small>TMDB</small>`" in MEDIA)
check("C3 TMDB 徽标 CSS", ".movie-tmdb-rating" in CSS)

# --- D. 收藏可取消 ---
check("D1 收藏切换写回 localStorage（0/1）", 'movieStateKey("favorite",libId,path),next?"1":"0"' in MEDIA)
check("D2 取消收藏有反馈且 aria-pressed 同步", "已取消收藏" in MEDIA and 'button.setAttribute("aria-pressed"' in MEDIA)

# --- E. 演职人员圆形头像 ---
check("E1 演职人员头像结构（圆形 + 下方文字）", 'class="movie-cast-card"' in MEDIA and 'class="movie-cast-avatar"' in MEDIA)
check("E2 TMDB profile_path 头像 / 缺图首字占位", "profile_path" in MEDIA and "movie-cast-avatar-fallback" in MEDIA)
check("E3 头像 CSS 圆形", ".movie-cast-avatar" in CSS and "border-radius:50%" in CSS)
check("E3b 演职人员专用容器（不被方框条样式覆盖）", 'class="movie-detail-strip movie-cast-strip"' in MEDIA and ".movie-detail-strip article.movie-cast-card" in CSS and "border:none" in CSS.split(".movie-detail-strip article.movie-cast-card")[1][:200])
check("E4 演职人员仍显示姓名与角色", "<b>${esc(x.name||\"\")}</b><small>${esc(x.character||\"\")}</small>" in MEDIA)

# --- F. 分享外网地址（后端 + 设置页） ---
check("F1 RuntimeConfig 含 share_public_base", 'SharePublicBase' in open(ROOT / "media-go/main.go", encoding="utf-8").read())
check("F2 校验 http(s)://host[:port] 无路径", "func validSharePublicBase" in open(ROOT / "media-go/main.go", encoding="utf-8").read())
check("F3 设置页有外网分享地址输入框", 'id="sharePublicBase"' in HTMLF)
check("F4 设置读取/保存接线", 'sharePublicBase:c.share_public_base' in MEDIA and 'share_public_base:value("sharePublicBase")' in MEDIA)
check("F4b 读设置时同步刷新本机缓存（分享地址改动即时生效）", "scraperStatus = { ...scraperStatus, ...c, default: c.scraper_mode || scraperStatus.default };" in MEDIA)
check("F5 支持显式清空外网地址（share_public_base_set）", "SharePublicBaseSet" in open(ROOT / "media-go/main.go", encoding="utf-8").read() and "share_public_base_set:true" in MEDIA and "c.SharePublicBase == \"\" && !c.SharePublicBaseSet" in open(ROOT / "media-go/main.go", encoding="utf-8").read())

print(f"\nSUMMARY {passed}/{passed+failed} PASS")
if failed: raise SystemExit("FAIL: v0.9.76 契约测试未通过")
print("PASS: v0.9.76 影视详情契约（分享 / 五星评分 / TMDB / 收藏 / 圆形头像）全部满足")
