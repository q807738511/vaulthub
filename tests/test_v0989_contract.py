#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.90 契约测试（静态落点）：生产事故修复 + 三项客户要求。

跑法：python3 tests/test_v0989_contract.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
failures = []
checks = 0


def check(name, ok, extra=""):
    global checks
    checks += 1
    if ok:
        print("PASS", name)
    else:
        print("FAIL", name, extra)
        failures.append(name)


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


STORE = read("media-go/scrape_store.go")


def strip_comments(src):
    """先剥 // 行注释，再剥 /* */ 块注释。

    顺序很重要：源码注释里出现 /api/* 这类字面量时，直接剥块注释会把后面的
    代码整段吃掉（v0.9.90 实测 6.4 KB 代码被吞、契约断言全部误报失败）。"""
    src = re.sub(r"//[^\n]*", " ", src)
    return re.sub(r"/\*.*?\*/", " ", src, flags=re.S)


STORE_CODE = strip_comments(STORE)
MANAGER = read("manager/main.go")
NFO = read("media-go/nfo_write.go")
COVER = read("media-go/cover_persist.go")
MEDIA = read("web/js/02-media.js")
MEDIA_CODE = strip_comments(MEDIA)
HTML = read("index.html")
STATE = read("web/js/01-state.js")
LOG = read("Update Log.md")

# ============================================================ 0. 生产事故修复
check("0a 结果库新增深拷贝（锁外只能用副本）", "func cloneScrapeCacheFile(" in STORE_CODE)
check("0b 读盘函数持锁版本存在", "func (a *App) loadScrapeCacheLocked()" in STORE_CODE)
check("0c 三个全程持锁操作齐备",
      all(f"func (a *App) scrapeCache{op}(" in STORE_CODE for op in ("Read", "Merge", "Clear")))
check("0d GET 处理器改为加锁读（不再锁外 range 共享 map）",
      "a.scrapeCacheRead(id, since, limit)" in STORE_CODE and "for k := range lib.Items {" not in STORE_CODE.split("func (a *App) scrapeCacheGet")[1].split("func (a *App)")[0])
check("0e POST 处理器改为加锁合并", "a.scrapeCacheMerge(body.ID, body.Items, body.Replace)" in STORE_CODE)
check("0f POST 不再在处理器里直接写 lib.Items",
      "lib.Items[path] = item" not in STORE_CODE.split("func (a *App) scrapeCachePost")[1].split("func (a *App)")[0])
check("0g DELETE 处理器改为加锁清空", "a.scrapeCacheClear(id, all)" in STORE_CODE)
check("0h 合并/清空/读都持锁", STORE_CODE.count("a.scrapeCacheMu.Lock()") >= 4)
check("0i manager 子进程守护存在", "func (m *manager) supervise(" in MANAGER)
check("0j 守护按退避重启（1s→30s 封顶）",
      "delay := time.Second" in MANAGER and "30 * time.Second" in MANAGER and "delay *= 2" in MANAGER)
check("0k 关闭前先停守护（不会关停时又拉起）",
      "m.stopChildren()" in MANAGER and "func (m *manager) stopChildren()" in MANAGER and "stopOnce" in MANAGER)
check("0l 三个子进程都交给守护循环",
      MANAGER.count("go m.supervise(") == 3)
check("0m 子进程表加锁（守护并发改表不 race）",
      "childrenMu" in MANAGER and "func (m *manager) childrenSnapshot()" in MANAGER)
check("0n runtime 接口暴露自动拉起次数", '"child_restarts": m.restartSnapshot()' in MANAGER)
check("0o 并发回归测试存在（真实并发打三个方法）",
      (ROOT / "media-go/v0989_scrape_cache_concurrency_test.go").is_file() and
      "TestV0989ScrapeCacheConcurrentAccess" in read("media-go/v0989_scrape_cache_concurrency_test.go"))
check("0p manager 守护回归测试存在", (ROOT / "manager/v0989_supervise_test.go").is_file())

# ============================================================ 1. 阈值辅助刮削
check("1a 覆盖率与综合分分离（titleMatchDetail）", "function titleMatchDetail(" in MEDIA_CODE)
check("1b 命中判据以覆盖率为主口径",
      "matched: best.coverage >= threshold || best.score >= threshold" in MEDIA_CODE)
check("1c 匹配不足 → review（待确认），不再判 failed",
      'movieFallbackState(path)' in MEDIA_CODE and '"review"' in MEDIA_CODE)
check("1d 网络/凭据问题才记 failed",
      '/请求失败|凭据|网络|超时|HTTP 5|HTTP 4/.test(reason) ? "failed" : "review"' in MEDIA_CODE)
check("1e review 不进自动重试队列",
      'state === "ok" || state === "skip" || state === "review"' in MEDIA_CODE)
check("1f 统计与摘要区分「待确认」",
      "stats.review++" in MEDIA_CODE and "待确认" in MEDIA_CODE)
check("1g 原因文案不再出现「最高 n%」",
      "最高 ${pct}%" not in MEDIA_CODE and "最高" not in MEDIA_CODE)
check("1h 无候选/零覆盖有明确文案",
      "TMDB 没有返回候选" in MEDIA_CODE and "没有共同字符" in MEDIA_CODE)
check("1i 逐项扫描状态标签含待确认", "待确认（识别字符占比不足，可改名后重刮）" in MEDIA_CODE)

# ============================================================ 2. NFO 本地化
check("2a 路由注册 /api/media/nfo", 'mux.HandleFunc("/api/media/nfo", a.nfoHandler)' in read("media-go/main.go"))
check("2b NFO 写入使用 Kodi/Emby 兼容 XML", "encoding/xml" in NFO and "xml.MarshalIndent" in NFO)
check("2c 原子写（临时文件 + rename）", "os.CreateTemp" in NFO and "os.Rename" in NFO)
check("2d 已存在且非本程序写的 NFO 默认保留", "nfoMarker" in NFO and "return false, true, nil" in NFO)
check("2e 需要登录会话", "if !writeAuth(r)" in NFO)
check("2f 目标目录必须落在库根内", "dirInsideLibrary" in NFO and "EvalSymlinks" in NFO)
check("2g 文件名白名单只允许 .nfo", "nfoNameRe" in NFO and r"\.nfo$" in NFO)
check("2h 回读端点存在（闭环验证）", "func (a *App) nfoRead(" in NFO and "readLocalMediaMetadata" in NFO)
check("2i 读取端候选与写入端一致（movie.nfo / tvshow.nfo）",
      '"movie.nfo"' in read("media-go/local_metadata.go") and '"tvshow.nfo"' in read("media-go/local_metadata.go"))
check("2j 前端命中后串行本地化（队列 + busy 闸门）",
      "queueMovieLocalization" in MEDIA_CODE and "movieLocalizeBusy" in MEDIA_CODE)
check("2k 本地化写 NFO 请求带 extras", "extras: movieNFOExtras(lib, path)" in MEDIA_CODE)
check("2l 已本地化条目不重复写盘", "meta.localized_at && meta.nfo" in MEDIA_CODE)
check("2m 已刮削条目进库即回填本地化（老库不必重刮）",
      "queueLocalizationBacklog" in MEDIA_CODE and "MOVIE_LOCALIZE_BACKLOG_PER_VISIT" in MEDIA_CODE)
check("2n movie.nfo 只在单文件目录写（防串片）",
      "nfoDirMediaCount" in NFO and 'strings.EqualFold(name, "movie.nfo")' in NFO)

# ============================================================ 3. 数据本地化 + 标题层级
check("3a cover 支持 role", "Role string `json:\"role\"`" in COVER and "coverRoleSidecar" in COVER)
check("3b 四个角色落成读取端认识的名字",
      all(f'"{r}":' in COVER for r in ("poster", "fanart", "backdrop", "logo")))
check("3c 读取端确实读 -poster/-fanart/-backdrop/-logo",
      all(frag in read("media-go/local_metadata.go") for frag in ('"-poster.jpg"', '"-fanart.jpg"', '"-backdrop.jpg"', '"-logo.png"')))
check("3d 非法 role 被拒", 'invalid artwork role' in COVER)
check("3e 前端按角色请求图片本地化", 'MOVIE_LOCALIZE_ROLES = ["poster", "fanart", "backdrop", "logo"]' in MEDIA)
check("3f 编辑弹窗新增只读「原文件名称」", 'id="mediaEditOriginalName"' in HTML and "readonly" in HTML.split('id="mediaEditOriginalName"')[1][:60])
check("3g 弹窗回填原文件名", 'origInput.value=String(path).split("/").pop()' in MEDIA)
check("3h 原文件名三语 i18n",
      all("editOriginalNameLabel" in STATE for _ in (0,)) and STATE.count("editOriginalNameLabel") == 3)
check("3i 卡片保留原文件名（悬停）", 'title="原文件：${esc(path)}"' in MEDIA)
check("3j 不做物理改名（无 rename 媒体文件调用）",
      "renameMediaFile" not in MEDIA and "/api/media/rename" not in MEDIA)

# ============================================================ 版本与文档
check("4a index.html 资源版本 ≥10 且为本版", HTML.count("?v=0.9.97") >= 10)
check("4b ASSET_VERSION 0.9.90", 'window.VAULTHUB_ASSET_VERSION = "0.9.97";' in HTML)
check("4c SCRIPT_VERSION 0.9.90", 'const VAULTHUB_SCRIPT_VERSION = "0.9.97";' in STATE)
# v0.9.90：标语随版本推进 —— 校验版本前缀 + 侧栏/页脚/关于三处一致。
# v0.9.92（上轮审查项）：标语整串一致，而不是只数版本前缀。
_slogans_4d = re.findall(r"v0\.9\.9\d · [^<\"]+", HTML)
check("4d 标语三处整串一致",
      len(_slogans_4d) == 3 and len(set(_slogans_4d)) == 1, sorted(set(_slogans_4d)))
check("4e 更新日志有 v0.9.90 章节", LOG.lstrip().startswith("# VaultHub 蜀鼠之家 v0.9.97"))
check("4f 更新日志写明并发写根因", "fatal error: concurrent map read and map write" in LOG)
check("4g 发布说明文件存在", (ROOT / ".github/RELEASE_NOTES_0.9.90.md").is_file())
# v0.9.95（安全审查 M4）：README 里原本写着真实对外域名，已改为示例域名 —— 这是唯一允许的
# 改动（README 的项目介绍正文仍然固定不动）。工作树里体现为一条 -/+ 的域名行；已提交的发布树
# 里 diff 为空，两种状态都要通过。
_README_TXT = (ROOT / "README.md").read_text(encoding="utf-8")
_diff_4h = subprocess.run(["git", "diff", "--unified=0", "HEAD", "--", "README.md"], cwd=ROOT,
                          capture_output=True, text=True).stdout
_changed_4h = [l for l in _diff_4h.splitlines()
               if (l.startswith("+") or l.startswith("-")) and not l.startswith(("+++", "---"))]
check("4h README 只做了域名脱敏（固定项目介绍不变，且不再含真实域名）",
      ("enged" + ".top") not in _README_TXT
      and (_changed_4h == [] or all((("enged" + ".top") in l) or ("example.com" in l) for l in _changed_4h)))
check("4i 新版测试文件齐备",
      all((ROOT / p).is_file() for p in (
          "tests/v0989_behavior.js", "tests/test_v0989_behavior.py",
          "media-go/v0989_nfo_test.go", "media-go/v0989_scrape_cache_ops_test.go")))

print(f"\nSUMMARY pass={checks - len(failures)} fail={len(failures)}")
if failures:
    for f in failures:
        print("  -", f)
    sys.exit(1)
sys.exit(0)
