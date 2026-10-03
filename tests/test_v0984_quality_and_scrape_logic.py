#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.84 契约测试（二）：在 Node 里**真实执行**抽出的模块，验证行为而不只是文本。

覆盖：
  · 画面清晰度档位（03-quality.js 全文）：档位持久化、自动档映射、色彩倍率、
    封面取图宽度、阅读页宽度、恢复原画、落地到 <html> 的 data-quality 与色彩变量；
  · 刮削前置逻辑（02-media.js 片段）：原盘目录识别、原盘片段合并（幂等）、
    原盘标题取目录名、无意义标题判定、刮削状态统计。

环境无 node 时 SKIP（与 tests/test_v0967_reader_logic.py 同一约定）。
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
QUALITY = (ROOT / "web/js/03-quality.js").read_text(encoding="utf-8")

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过 v0.9.84 逻辑级验证")
    raise SystemExit(0)


def extract_function(src, name):
    """按大括号配平抽出 `function name(...) {...}` 的完整文本。"""
    i = src.index(f"function {name}(")
    j = src.index("{", i)
    depth = 0
    k = j
    while k < len(src):
        ch = src[k]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[i:k + 1]
        k += 1
    raise AssertionError(f"未能抽出 {name}")


def extract_line(src, needle):
    for line in src.splitlines():
        if needle in line:
            return line
    raise AssertionError(f"未找到 {needle}")


PIECES = [
    extract_line(MEDIA, "const MOVIE_NOISE_RE ="),
    extract_function(MEDIA, "displayBookTitle"),
    extract_function(MEDIA, "discFolderOf"),
    extract_function(MEDIA, "movieTitleFromPath"),
    extract_function(MEDIA, "collapseDiscFragments"),
    extract_function(MEDIA, "scrapableMovieTitle"),
    extract_function(MEDIA, "movieMetaState"),
    extract_function(MEDIA, "movieScrapeStats"),
]

HARNESS = r"""
const fs = require("fs");
const vm = require("vm");
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const store = {};
const doc = { documentElement: { dataset: {}, style: { setProperty(k, v) { this[k] = v; } }, classList: { toggle() {} } }, getElementById: () => null, querySelector: () => null };
const sb = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  navigator: {}, document: doc, window: {}, console, JSON, Math, Number, String, Object, Set, Array, Boolean, RegExp, Date,
  toast: () => {}, setTimeout: (fn) => 0, clearTimeout: () => {},
  __meta: {},
  readMovieMetadata: () => sb.__meta,
  weakNetworkActive: () => sb.__weak === true,
  __weak: false,
};
const ctx = vm.createContext(sb);
vm.runInContext(p.media + "\n" + p.quality + `
this.__api = {
  qualityChoice, setQualityLevel, cycleQualityLevel, resetQualityLevel, qualityEffectiveId, qualityProfile,
  qualityColorFactor, qualityIsGray, qualityCoverWidth, qualityPageWidth, qualityVideoPreset, qualityAudioKbps,
  applyQualityLevel, qualityLabelText, discFolderOf, movieTitleFromPath, collapseDiscFragments,
  scrapableMovieTitle, movieMetaState, movieScrapeStats,
};`, ctx);
const api = sb.__api;
let pass = 0, fail = 0;
const chk = (n, c) => { if (c) pass++; else { fail++; console.log("FAIL: " + n); } };

/* ---------- 画面清晰度与色彩档位 ---------- */
chk("默认档位=自动", api.qualityChoice() === "auto");
chk("自动+无弱网 → 原画（完整色彩）", api.qualityEffectiveId() === "original" && api.qualityColorFactor() === 1);
sb.__weak = true;
chk("自动+弱网判定 → 高清（兼容旧省流行为：仍转码 1600）", api.qualityEffectiveId() === "high" && api.qualityProfile().pageW === 1600 && api.qualityColorFactor() === 1);
sb.__weak = false;
chk("自动档阅读页宽度交回旧判定（null）", api.qualityPageWidth() === null);

api.setQualityLevel("minimal", { toast: false, rerender: false });
chk("极省档已持久化", api.qualityChoice() === "minimal");
chk("极省=最低清晰度 900px", api.qualityProfile().pageW === 900 && api.qualityPageWidth() === 900);
chk("极省=无色彩（灰度）", api.qualityColorFactor() === 0 && api.qualityIsGray() === true);
chk("极省封面取图最小 140", api.qualityCoverWidth(320) === 140);
chk("极省视频降到 480p、音频 96k", api.qualityVideoPreset() === "480p" && api.qualityAudioKbps() === 96);
chk("档位落地到 <html>（data-quality + 色彩变量）", doc.documentElement.dataset.quality === "minimal" && doc.documentElement.style["--vh-quality-color"] === "0");
chk("按钮文案显示档位", api.qualityLabelText() === "画质·极省");

api.setQualityLevel("smooth", { toast: false, rerender: false });
chk("流畅=1200px + 色彩 70%", api.qualityProfile().pageW === 1200 && api.qualityColorFactor() === 0.7 && api.qualityIsGray() === false);
chk("流畅封面 200 / 视频 720p / 音频 128k",
  api.qualityCoverWidth(320) === 200 && api.qualityVideoPreset() === "720p" && api.qualityAudioKbps() === 128);

api.resetQualityLevel();
chk("恢复原画 = 一步还原（原图直出 + 完整色彩）",
  api.qualityChoice() === "original" && api.qualityPageWidth() === 0 && api.qualityColorFactor() === 1 && doc.documentElement.style["--vh-quality-color"] === "1");
chk("恢复后封面回到 320", api.qualityCoverWidth(320) === 320);
chk("恢复后 <html> 标记为 original（CSS 不再套灰度）", doc.documentElement.dataset.quality === "original");

api.setQualityLevel("high", { toast: false, rerender: false });
chk("高清=1600px 转码 + 完整色彩", api.qualityProfile().pageW === 1600 && api.qualityColorFactor() === 1);
const before = api.qualityChoice();
api.cycleQualityLevel({ toast: false, rerender: false });
chk("循环档位向前推进", api.qualityChoice() !== before);
api.setQualityLevel("auto", { toast: false, rerender: false });

/* ---------- 刮削前置逻辑 ---------- */
const disc = "/MO/[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray.1080p.AVC.LPCM5.1.DTS-HD.MA7.1-HDbits@CHDBits/[黑鹰坠落]Black.Hawk.Down.2001.Blu-ray.1080p.AVC.LPCM5.1.DTS-HD.MA7.1/BDMV/STREAM/00011.m2ts";
chk("原盘目录识别", api.discFolderOf(disc).endsWith("DTS-HD.MA7.1"));
chk("非原盘路径不误判", api.discFolderOf("/MO/普通电影/Film.2020.mp4") === "");
chk("原盘条目标题取目录名（不是 00011）", api.movieTitleFromPath(disc).indexOf("黑鹰坠落") === 0 && api.movieTitleFromPath(disc).indexOf("00011") < 0);
chk("普通影片标题仍按文件名解析", api.movieTitleFromPath("/MO/五个扑水的少年].Water.Boys.2021.2160p.WEB-DL.H.265.AAC-AilMWeb.mp4").indexOf("Water Boys") > 0);

const files = [];
for (let i = 1; i <= 20; i++) files.push({ path: disc.replace("00011", String(i).padStart(5, "0")), size: i * 1000 });
files.push({ path: "/MO/普通电影/Film.2020.mp4", size: 500 });
files.push({ path: "/MO/乙片/BDMV/STREAM/00001.m2ts", size: 9000 });
const collapsed = api.collapseDiscFragments(files);
chk("原盘 20 个片段合并为 1 条 + 普通影片保留", collapsed.length === 3);
const first = collapsed.find(f => f.disc && f.disc_folder.indexOf("黑鹰坠落") >= 0);
chk("合并后保留体积最大的片段", first.path.endsWith("00020.m2ts") && first.size === 20000);
chk("合并记录片段数", first.disc_fragments === 20);
chk("合并幂等（再次调用不重复计数）", api.collapseDiscFragments(collapsed).length === 3);
chk("第二部原盘独立成条", collapsed.filter(f => f.disc).length === 2);

chk("纯数字片段名不可作为刮削词", api.scrapableMovieTitle("00011") === false && api.scrapableMovieTitle("MovieObject") === true);
chk("中文/英文标题可刮削", api.scrapableMovieTitle("黑鹰坠落 Black Hawk Down") === true);
chk("过短标题不浪费请求", api.scrapableMovieTitle("1") === false);

sb.__meta = {
  "a.mp4": { scrape_state: "ok" },
  "b.mp4": { scrape_state: "failed", scrape_attempts: 1 },
  "c.mp4": { scrape_state: "skip" },
  "d.mp4": { provider: "文件名展示" },
};
const stats = api.movieScrapeStats([{ path: "a.mp4" }, { path: "b.mp4" }, { path: "c.mp4" }, { path: "d.mp4" }, { path: "e.mp4" }]);
chk("刮削状态统计（ok/failed/skip/待刮）",
  stats.ok === 1 && stats.failed === 1 && stats.skip === 1 && stats.pending === 2 && stats.total === 5);
chk("旧数据（provider=文件名展示）视为未完成，可被重试", api.movieMetaState({ provider: "文件名展示" }) === "pending");
chk("成功条目不重试", api.movieMetaState({ scrape_state: "ok" }) === "ok");

console.log("RESULT " + JSON.stringify({ pass, fail }));
"""

with tempfile.TemporaryDirectory() as tmp:
    payload = pathlib.Path(tmp) / "payload.json"
    harness = pathlib.Path(tmp) / "harness.js"
    payload.write_text(json.dumps({"media": "\n".join(PIECES), "quality": QUALITY}), encoding="utf-8")
    harness.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(["node", str(harness), str(payload)], capture_output=True, text=True)

out = (proc.stdout or "") + (proc.stderr or "")
match = re.search(r"RESULT (\{.*\})", out)
if not match:
    print("FAIL: v0.9.84 逻辑验证未产出结果\n" + out[:1500])
    sys.exit(1)
result = json.loads(match.group(1))
if proc.returncode != 0 or result["fail"]:
    print(out)
    raise SystemExit(f"FAIL: v0.9.84 逻辑级验证 {result['fail']} 项未通过")
print(out.strip())
print(f"PASS: v0.9.84 画面清晰度档位 / 原盘合并 / 刮削状态（{result['pass']} 项真实执行通过）")
