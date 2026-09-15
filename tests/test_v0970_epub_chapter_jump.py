#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.70 复审修复守卫：EPUB 章节下拉跳转不得算出 NaN。

背景（独立审查 P2-2）：章节跳转用 chapter.offset 计算 scrollTop，而 EPUB 章节由
服务端按 spine 生成、原本没有 offset → NaN → 选择章节后不跳转。本测试把真实的
web/js/02-media.js 载入 Node，用桩 scroller 直接执行 jumpEbookChapter 三种场景：
  1. EPUB：存在 .ebook-chapter-title 标题元素 → 按元素位置精确定位；
  2. EPUB：标题元素缺失但有累计偏移 → 按比例定位；
  3. 偏移缺失且无标题元素 → 归零，绝不写 NaN。

无 node 环境时 SKIP。
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "web/js/02-media.js"

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过章节跳转行为测试")
    raise SystemExit(0)

HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(process.argv[2], "utf8");
const noop = () => {};
function fakeEl(over = {}) {
  return Object.assign({
    innerHTML: "", textContent: "", style: {}, dataset: {}, children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], appendChild: noop,
    removeChild: noop, addEventListener: noop, removeEventListener: noop,
    setAttribute: noop, getAttribute: () => null, focus: noop, closest: () => null,
    scrollIntoView: noop, offsetParent: null, isConnected: false,
    scrollTop: 0, scrollHeight: 1000, clientHeight: 200, offsetTop: 0
  }, over);
}
let scroller = fakeEl();
const document = {
  getElementById: () => fakeEl(),
  querySelector: sel => (sel.includes("data-reader-scroll") ? scroller : null),
  querySelectorAll: () => [], createElement: () => fakeEl(),
  addEventListener: noop, removeEventListener: noop, body: fakeEl(),
  documentElement: fakeEl(), activeElement: null, fullscreenElement: null
};
const store = {};
const sb = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document, fetch: async () => ({ ok: true, json: async () => ({}) }), toast: noop, t: k => k, console,
  esc: v => String(v), displayBookTitle: p => String(p), coverGradient: () => "", formatFileSize: () => "",
  movieMetadataFor: () => ({}), audioMetadataFor: () => ({}), audioBaseMetadata: () => ({}), movieHeroArt: () => ({ url: "" }),
  settings: { theme: "dark" }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  navigator: {}, location: { href: "http://x/" }, alert: noop, confirm: () => true,
  URL, URLSearchParams, Blob: function () {}, Image: function () { return {}; },
  requestAnimationFrame: noop, performance: { now: () => 0 }, matchMedia: () => ({ matches: false, addEventListener: noop })
};
sb.window = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
vm.runInContext(src + "\n;this.__api = { jumpEbookChapter, getChapters: () => window.__ebookChapters, setChapters: c => { window.__ebookChapters = c; }, setLen: n => { window.__ebookTextLength = n; } };", ctx);
const api = sb.__api;
let pass = 0, fail = 0;
const chk = (n, c, extra) => { if (c) { pass++; console.log("PASS: " + n); } else { fail++; console.log("FAIL: " + n + (extra ? " | " + extra : "")); } };

// 场景 1：EPUB —— 有标题元素（offset 未定义）
scroller = fakeEl();
const headings = [fakeEl({ offsetTop: 0 }), fakeEl({ offsetTop: 300 }), fakeEl({ offsetTop: 620 })];
scroller.querySelectorAll = sel => (sel === ".ebook-chapter-title" ? headings : []);
api.setChapters([{ title: "第一章", text: "甲" }, { title: "第二章", text: "乙" }, { title: "第三章", text: "丙" }]);
api.jumpEbookChapter(2);
chk("EPUB 按标题元素定位（非 NaN）", Number.isFinite(scroller.scrollTop) && scroller.scrollTop === 612, "scrollTop=" + scroller.scrollTop);

// 场景 2：EPUB —— 无标题元素但有累计偏移
scroller = fakeEl();
scroller.querySelectorAll = () => [];
api.setChapters([{ title: "第一章", text: "甲", offset: 0 }, { title: "第二章", text: "乙", offset: 500 }]);
api.setLen(1000);
api.jumpEbookChapter(1);
chk("无标题元素时按偏移比例（非 NaN）", Number.isFinite(scroller.scrollTop) && scroller.scrollTop > 0, "scrollTop=" + scroller.scrollTop);

// 场景 3：偏移缺失且无标题元素 → 归零而不是 NaN
scroller = fakeEl();
scroller.querySelectorAll = () => [];
api.setChapters([{ title: "第一章", text: "甲" }]);
api.jumpEbookChapter(0);
chk("无偏移无标题时归零（非 NaN）", scroller.scrollTop === 0, "scrollTop=" + scroller.scrollTop);

// 场景 4：越界索引不得抛异常
scroller = fakeEl();
scroller.querySelectorAll = sel => (sel === ".ebook-chapter-title" ? [fakeEl({ offsetTop: 100 })] : []);
api.setChapters([{ title: "唯一章", text: "甲" }]);
api.jumpEbookChapter(9);
chk("越界索引不抛异常", Number.isFinite(scroller.scrollTop), "scrollTop=" + scroller.scrollTop);

console.log("SUMMARY pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
"""

with tempfile.TemporaryDirectory() as tmp:
    js = Path(tmp) / "jump.js"
    js.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(["node", str(js), str(MEDIA)], capture_output=True, text=True, timeout=120)
print(proc.stdout.strip())
if proc.returncode != 0:
    print(proc.stderr.strip()[-1200:])
    raise SystemExit("FAIL: v0.9.70 章节跳转行为测试未通过")
print("PASS: v0.9.70 章节下拉跳转行为契约通过")