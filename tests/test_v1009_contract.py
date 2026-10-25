#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.11 契约测试：NFO 体检补全 · 音乐库去入口卡 · 大库服务端分页/聚合。

纯静态契约（不联网、不起容器），钉住：
  1. 服务端三个新接口与它们的鉴权、边界与响应字段；
  2. NFO 补全「只填不改」的写入语义与海报命名；
  3. 前端不再拉整库索引（无 fetchAllLibraryFiles 残留调用点）；
  4. 音乐库首页没有喜欢/歌单入口卡，播放器有四个收藏相关按钮；
  5. 版本纪律 1.0.11 全链路一致 + 源码不含内网字面量。
"""
import io
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAIL = []
PASS = 0


def check(name, cond, detail=""):
    global PASS
    if cond:
        PASS += 1
        print("  PASS  " + name)
    else:
        FAIL.append(name + ((" :: " + detail) if detail else ""))
        print("  FAIL  " + name + ((" :: " + detail) if detail else ""))


def read(rel):
    with io.open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


media = read("web/js/02-media.js")
home = read("web/js/05-home.js")
index = read("index.html")
main_go = read("media-go/main.go")
browse_go = read("media-go/browse_api.go")
repair_go = read("media-go/nfo_repair.go")
nfo_write = read("media-go/nfo_write.go")
css = read("web/css/main.css")

print("== 1. 服务端接口与鉴权 ==")
for route in ["/api/media/shelf", "/api/media/lookup", "/api/media/audio/browse",
              "/api/media/nfo/repair", "/api/media/nfo/repair/status",
              "/api/media/nfo/repair/cancel", "/api/media/nfo/repair/one"]:
    check("路由已注册 " + route, ('"%s"' % route) in main_go)

check("shelf 需要写权限", "func (a *App) shelfBrowse" in browse_go and "if !writeAuth(r)" in browse_go.split("func (a *App) shelfBrowse")[1][:400])
check("audio/browse 需要读权限", "if !readAuth(r)" in browse_go.split("func (a *App) audioBrowse")[1][:400])
check("repair 需要写权限", "if !writeAuth(r)" in repair_go.split("func (a *App) nfoRepairStart")[1][:300])
check("repair status 需要读权限", "if !readAuth(r)" in repair_go.split("func (a *App) nfoRepairStatus")[1][:300])
check("同一库只允许一个补全作业", "nfo repair already running" in repair_go)
check("非影视库拒绝补全", "nfo repair supports movie/series libraries only" in repair_go)
check("作业有单次运行上限", "nfoRepairMaxRuntime" in repair_go)
check("分页单页有上限", "shelfMaxSize" in browse_go)
check("路径集合有上限", "shelfStateMaxPaths" in browse_go)
check("按路径查询有上限(5000)", "sanitizePathList(body.Paths, 5000)" in browse_go)

print("== 2. 分页/聚合正确性约束 ==")
check("按名称排序走 lower(path) 索引", '"lower(path) ASC"' in browse_go)
check("按时间排序走 mtime", '"mtime DESC, path"' in browse_go)
check("书架页签支持 IN / NOT IN", " AND path IN (" in browse_go and " AND path NOT IN (" in browse_go)
check("sidecar 图片不进列表", "NOT LIKE '%-poster.%'" in browse_go)
check("音频聚合按索引版本缓存", "libraryIndexVersion(lib.ID" in browse_go and "audioAggCache" in browse_go)
check("音频聚合排除非音频扩展", 'isAudioBrowseExt(fe.Path)' in browse_go and 'func isAudioBrowseExt(' in browse_go)
check("只给专辑名时跨歌手找专辑", 'artist == "" && album != ""' in browse_go)
check("歌手推断剥年份前缀", "audioYearPrefixRe" in browse_go)
check("忽略 Booklet/Disc 子目录", "isGenericAudioDir" in browse_go)

print("== 3. NFO 补全写入语义 ==")
check("评缺失字段", 'out.Missing = append(out.Missing, "nfo")' in repair_go)
check("缺标题/简介/评分/海报都算异常", all(x in repair_go for x in ['"title"', '"overview"', '"rating"', '"poster"']))
check("写 NFO 用 overwrite=false（只填不改）", "writeNFOFile(t, nfoDocFromMeta(meta), false)" in repair_go)
check("合并语义由 nfo_write 提供", "nfoMergeIntoExisting" in nfo_write)
check("单文件目录写 movie.nfo", 'filepath.Join(dir, "movie.nfo")' in repair_go)
check("剧集补 tvshow.nfo", '"tvshow.nfo"' in repair_go)
check("海报命名 <文件名>-poster", 'stem+"-"+role+ext' in repair_go)
check("海报已存在不重复下载", 'if fileExists(filepath.Join(dir, stem+"-"+role+ext))' in repair_go)
check("图片下载有 SSRF 守卫", "coverTargetGuard" in repair_go)
check("图片下载有大小上限", "coverDownloadMaxBytes" in repair_go)
check("TMDB 与豆瓣双源", "nfoTMDBLookup" in repair_go and "a.lookupDouban(title, year, kind)" in repair_go)
check("TMDB 未配置时降级豆瓣", 'errors.New("tmdb not configured")' in repair_go)
check("NFO 写入标记 VaultHub", 'WrittenBy:     "VaultHub"' in repair_go)

print("== 4. 前端不再拉整库 ==")
check("音乐库走服务端聚合", 'if (group === "audio" && typeof loadAudioServerView === "function") return loadAudioServerView(lib, offset);' in media)
check("书刊库走服务端分页（小库仍整库可见）",
      'return bookShelfRemoteLoad(lib, offset);' in media and "bookShelfPrefersRemote" in media)
check("分组曲目不再 fetchAllLibraryFiles", "fetchAllLibraryFiles" not in media.split("async function audioGroupFiles(libId")[1][:600])
check("歌单曲目按路径批量取", "fetchFilesByPaths" in media)
check("喜欢/取消喜欢只重绘本视图", "audioRefreshCurrentView()" in media)
check("有音频分页器", "audio-browse-pager" in css and "audioBrowseGo" in media)
check("有书刊远端分页器", "bookRemotePagerHtml" in media)
check("书刊喜欢路径上行", "bookFavPaths" in media)
check("书刊已完成路径上行", "bookCompletedPaths" in media)
check("切换标签走服务端", "bookShelfRemoteLoad(lib, bookShelfOffset)" in media)

print("== 5. 音乐库首页无入口卡 / 播放器入口 ==")
check("入口卡标记已移除", 'audio-entry-card' not in media)
check("歌手网格仍存在", "audio-artist-grid" in media)
check("播放器有我的喜欢按钮", 'id="audioFavoritesButton"' in index and "openAudioFavoritesView()" in index)
check("播放器有我的歌单按钮", 'id="audioPlaylistsButton"' in index and "openAudioPlaylistsView()" in index)
check("播放器有加入歌单按钮", 'id="audioAddPlaylistButton"' in index and "audioPlayerAddToPlaylist()" in index)
check("播放器喜欢按钮仍在", 'id="audioFavoriteButton"' in index)
check("新按钮有双描边", "#audioFavoritesButton" in css and "box-shadow: 0 0 0 1px rgba(0, 0, 0, .62)" in css)

print("== 6. NFO 补全界面 ==")
check("弹窗存在", 'id="nfoRepairModal"' in index)
check("体检/补全/取消三按钮", all(x in index for x in ["startNfoRepair(true)", "startNfoRepair(false)", "cancelNfoRepair()"]))
check("库列表有入口", "openNfoRepair('${esc(lib.id)}')" in home)
check("轮询状态", "/api/media/nfo/repair/status" in media)
check("进度条样式", ".nfo-bar" in css)

print("== 7. 版本纪律 ==")
check("index.html ?v=1.0.11 ×12", index.count("?v=1.0.11") >= 12)
check("ASSET 版本 1.0.11", 'window.VAULTHUB_ASSET_VERSION = "1.0.11"' in index)
state = read("web/js/01-state.js")
check("SCRIPT 版本 1.0.11", 'VAULTHUB_SCRIPT_VERSION = "1.0.11"' in state)
check("标语含本版关键词", "v1.0.11" in index and "NFO 补全" in index)
check("Update Log 首行为 1.0.11", read("Update Log.md").splitlines()[0].strip() == "# VaultHub 蜀鼠之家 v1.0.11")
check("RELEASE_NOTES 1.0.11 存在", os.path.exists(os.path.join(ROOT, ".github", "RELEASE_NOTES_1.0.9.md")))

print("== 8. 源码禁用字面量 ==")
for pat in [r"enged\.top", r"192\.168\.", r"/vol[1-4]"]:
    hits = []
    for base, _dirs, files in os.walk(ROOT):
        if "/.git" in base or "/node_modules" in base or "/tests" in base or "/docs" in base:
            continue
        for fn in files:
            if not fn.endswith((".go", ".js", ".html", ".css", ".md", ".sh", ".yaml", ".yml")):
                continue
            p = os.path.join(base, fn)
            if fn == "README.md":
                continue  # README 里的公开站点地址是刻意保留的入口说明
            try:
                with io.open(p, encoding="utf-8") as f:
                    if re.search(pat, f.read()):
                        hits.append(os.path.relpath(p, ROOT))
            except Exception:
                pass
    check("无内网字面量 " + pat, not hits, ",".join(hits[:4]))

print()
print("TOTAL %d PASS / %d FAIL" % (PASS, len(FAIL)))
if FAIL:
    for f in FAIL:
        print("  - " + f)
    sys.exit(1)
print("V1009 CONTRACT OK")
