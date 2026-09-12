#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.67 漫画阅读器「逻辑级」契约测试（无浏览器环境下的真实执行验证）。

背景：本仓库的验证环境没有可用浏览器，仅靠 `node --check` 只能证明语法正确，
无法证明页码换算/方向/URL/省流判断的行为。因此本测试把 02-media.js 里的漫画模块
抽出来，在 Node 里用最小 DOM/localStorage/navigator 桩**真实执行**并断言结果。
若环境没有 node（例如纯 Python CI），则以 SKIP 退出，不影响其余测试。
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过阅读器逻辑级验证")
    raise SystemExit(0)

START = "/* ==================== v0.9.67 漫画阅读器"
END = "const VIDEO_ENGINE_NATIVE"
i, j = MEDIA.find(START), MEDIA.find(END, MEDIA.find(START))
assert i >= 0 and j > i, "未能定位漫画阅读器模块（模块被重命名或移动？）"
MODULE = MEDIA[i:j]

HARNESS = r"""
const fs = require("fs");
const block = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const vm = require("vm");
const store = {};
const sb = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  navigator: {},
  esc: s => String(s), toast: () => {}, viewerShell: () => "",
  readingState: () => ({ progress: 0, page: 0, total: 0 }), saveReadingProgress: () => {},
  document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null },
  Image: function () { return {}; },
  setTimeout, clearTimeout, encodeURIComponent, Math, Number, String, Object, JSON, Set, console
};
const ctx = vm.createContext(sb);
vm.runInContext(block + ";this.__api = { comicPrefs, saveComicPrefs, comicSaveDataActive, comicTranscodeWidth, comicPageUrl, comicCoverUrl, comicResumePage, comicFitLabel, comicModeLabel, comicSaveLabel };", ctx);
const api = sb.__api;
let pass = 0, fail = 0;
const chk = (n, c) => { if (c) { pass++; } else { fail++; console.log("FAIL: " + n); } };
const p = api.comicPrefs();
chk("默认单页", p.mode === "single");
chk("默认右起(日漫)", p.rtl === true);
chk("默认适宽", p.fit === "width");
chk("默认省流=自动", p.saveData === "auto");
delete sb.navigator.connection;
chk("自动模式无网络信息则原图直出", api.comicSaveDataActive() === false && api.comicTranscodeWidth() === 0);
sb.navigator.connection = { saveData: true, effectiveType: "4g" };
chk("saveData 生效开省流", api.comicSaveDataActive() === true && api.comicTranscodeWidth() === 1600);
sb.navigator.connection = { saveData: false, effectiveType: "3g" };
chk("3g 自动省流", api.comicSaveDataActive() === true);
sb.navigator.connection = { saveData: false, effectiveType: "4g" };
chk("4g 不省流", api.comicSaveDataActive() === false);
api.saveComicPrefs({ saveData: "on" });
chk("显式开优先", api.comicSaveDataActive() === true);
api.saveComicPrefs({ saveData: "off" });
chk("显式关优先", api.comicSaveDataActive() === false);
api.saveComicPrefs({ saveData: "auto" });
const lib = { id: "comic-1rfyw87" };
const entry = { raw: "第01话/01.jpg", name: "01.jpg" };
const u0 = api.comicPageUrl(lib, "a b.zip", entry, 0);
chk("w=0 不带宽度参数", !u0.includes("&w="));
chk("路径与条目正确编码", u0.includes("path=a%20b.zip") && u0.includes("entry=%E7%AC%AC01%E8%AF%9D%2F01.jpg"));
chk("指向按页端点", api.comicPageUrl(lib, "a.zip", entry, 1600).startsWith("/api/media/archive/zip/page?"));
chk("w>0 带宽度参数", api.comicPageUrl(lib, "a.zip", entry, 1600).includes("&w=1600"));
chk("封面默认 320", api.comicCoverUrl(lib, "a.zip").endsWith("&w=320"));
chk("有页码用页码", api.comicResumePage({ total: 200 }, { page: 57, total: 200, progress: 3 }) === 57);
chk("旧百分比换算", api.comicResumePage({ total: 200 }, { progress: 37.5, page: 0 }) === 75);
chk("总页数变化时按百分比重算(无浮点差一页)", api.comicResumePage({ total: 100 }, { page: 57, total: 200, progress: 28.5 }) === 29);
chk("页码超范围钳制", api.comicResumePage({ total: 10 }, { page: 999, total: 10 }) === 10);
chk("无进度从第1页开始", api.comicResumePage({ total: 200 }, {}) === 1);
chk("适应方式文案", api.comicFitLabel("height") === "适高" && api.comicFitLabel("native") === "原始");
chk("模式文案", api.comicModeLabel("double") === "双页" && api.comicModeLabel("scroll") === "条漫");
console.log("RESULT " + JSON.stringify({ pass, fail }));
"""

with tempfile.TemporaryDirectory() as tmp:
    block_path = Path(tmp) / "module.js"
    harness_path = Path(tmp) / "harness.js"
    block_path.write_text(json.dumps(MODULE), encoding="utf-8")
    harness_path.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(["node", str(harness_path), str(block_path)], capture_output=True, text=True)

out = (proc.stdout or "") + (proc.stderr or "")
match = re.search(r"RESULT (\{.*\})", out)
if not match:
    print("FAIL: 阅读器逻辑验证未产出结果\n" + out[:800])
    sys.exit(1)
result = json.loads(match.group(1))
if proc.returncode != 0 or result["fail"]:
    print(out)
    raise SystemExit(f"FAIL: v0.9.67 阅读器逻辑 {result['fail']} 项未通过")
print(out.strip())
print(f"PASS: v0.9.67 漫画阅读器逻辑（{result['pass']} 项：页码换算/方向/URL/省流判断）真实执行通过")
