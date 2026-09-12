#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.67 漫画阅读器「关闭/自愈/并存」行为测试（Node 中真实执行）。

覆盖三个由独立复审驱动的场景：
  A 正常关闭：closeComicReader 后监听归零，后续按键不再改页码/写进度；
  B DOM 消失（closeLocalViewer 清空 innerHTML 但未走 closeComicReader）：首次按键自愈；
  C 两个阅读器并存：旧阅读器的残留 handler 自愈时**不得**清掉新阅读器的状态与监听
    （第一版实现调用 closeComicReader() 做自愈，会造成错位清理）。
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
    print("SKIP: 未找到 node，跳过阅读器关闭行为验证")
    raise SystemExit(0)

START = "/* ==================== v0.9.67 漫画阅读器"
END = "const VIDEO_ENGINE_NATIVE"
i, j = MEDIA.find(START), MEDIA.find(END, MEDIA.find(START))
assert i >= 0 and j > i
MODULE = MEDIA[i:j]

HARNESS = r"""
const fs = require("fs");
const block = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const vm = require("vm");

const listeners = [];
const progressWrites = [];

function makeEl() {
  return {
    dataset: {}, hidden: false, style: {}, textContent: "",
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }),
    scrollIntoView() {}, closest: () => null, removeAttribute() {}, setAttribute() {}, isConnected: true,
  };
}
function makeReader() {
  const root = makeEl();
  root.querySelector = () => null;
  root.addEventListener = () => {};
  return root;
}
// 每个阅读器一套 (viewer, readerRoot)，alive 控制 querySelector(".comic-reader") 是否返回根节点
function makeReaderScope() {
  const scope = { alive: true, reader: makeReader() };
  scope.viewer = makeEl();
  scope.viewer.querySelector = sel => (scope.alive && sel === ".comic-reader" ? scope.reader : null);
  return scope;
}
const document = {
  activeElement: null,
  addEventListener: (t, fn) => { if (t === "keydown") listeners.push(fn); },
  removeEventListener: (t, fn) => { if (t !== "keydown") return; const k = listeners.indexOf(fn); if (k >= 0) listeners.splice(k, 1); },
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
};
function makeState(scope, id) {
  return {
    viewer: scope.viewer, lib: { id: id }, path: id + ".zip",
    entries: new Array(200).fill(0).map((_, k) => ({ raw: "p" + (k + 1) + ".png" })),
    total: 200, mode: "single", rtl: false, fit: "width",
    page: 10, prefetched: new Set(), observer: null, keyHandler: null,
  };
}
const sb = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: {}, esc: s => String(s), toast: () => {}, viewerShell: () => "",
  readingState: () => ({ progress: 0, page: 0, total: 0 }),
  saveReadingProgress: (libId, path, progress, page, total) => { progressWrites.push({ libId, path, page }); },
  document, Image: function () { return {}; }, setTimeout, clearTimeout,
  encodeURIComponent, Math, Number, String, Object, JSON, Set, console,
};
const ctx = vm.createContext(sb);
vm.runInContext(block + ";this.__api = { comicBind, closeComicReader, setComicState: s => { comicState = s; }, getComicState: () => comicState };", ctx);
const api = sb.__api;
const press = key => { listeners.slice().forEach(fn => fn({ key, preventDefault() {}, target: { tagName: "DIV" } })); };
const out = {};

// ---- A 正常关闭 ----
const scopeA = makeReaderScope();
const stateA = makeState(scopeA, "A");
api.setComicState(stateA);
api.comicBind(stateA);
out.A_listenersBefore = listeners.length;
press("ArrowRight");
out.A_pageAfterOpen = stateA.page;
out.A_writesAfterOpen = progressWrites.length;
api.closeComicReader();
out.A_listenersAfterClose = listeners.length;
out.A_comicStateAfterClose = api.getComicState() === null;
out.A_writesBeforeClosedKeys = progressWrites.length;
press("ArrowRight");
press("PageDown");
out.A_pageAfterClosedKeys = stateA.page;
out.A_writesAfterClosedKeys = progressWrites.length;

// ---- B DOM 消失后的自愈（不走 closeComicReader）----
const scopeB = makeReaderScope();
const stateB = makeState(scopeB, "B");
api.setComicState(stateB);
api.comicBind(stateB);
out.B_listenersBefore = listeners.length;
scopeB.alive = false;                 // 阅读器 DOM 被清空
press("ArrowRight");                  // 首次按键应自愈
out.B_listenersAfterHeal = listeners.length;
out.B_pageUnchanged = stateB.page;
out.B_comicStateCleared = api.getComicState() === null;

// ---- C 两个阅读器并存：旧 handler 自愈不得废掉新阅读器 ----
const scopeOld = makeReaderScope();
const scopeNew = makeReaderScope();
const oldState = makeState(scopeOld, "old");
const newState = makeState(scopeNew, "new");
api.setComicState(oldState);
api.comicBind(oldState);              // 旧的先绑
api.setComicState(newState);
api.comicBind(newState);              // 新的后绑（当前活跃）
out.C_listenersBoth = listeners.length;
scopeOld.alive = false;               // 旧阅读器 DOM 消失
press("ArrowRight");                  // 旧 handler 触发自愈 + 新 handler 正常翻页
out.C_listenersAfterOldHeal = listeners.length;
out.C_activeIsNew = api.getComicState() === newState;
out.C_newPageAdvanced = newState.page;
out.C_newKeyHandlerIntact = typeof newState.keyHandler === "function";
out.C_oldKeyHandlerCleared = oldState.keyHandler === null;

console.log("RESULT " + JSON.stringify(out));
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
    print("FAIL: 未能执行关闭行为验证\n" + out[:900])
    sys.exit(1)
r = json.loads(match.group(1))

fails = []
if r["A_listenersBefore"] != 1:
    fails.append(f"A 打开时应恰好 1 个监听，实际 {r['A_listenersBefore']}")
if r["A_pageAfterOpen"] != 11 or r["A_writesAfterOpen"] < 1:
    fails.append(f"A 打开时方向键应翻页并写进度，实际 page={r['A_pageAfterOpen']} writes={r['A_writesAfterOpen']}")
if r["A_listenersAfterClose"] != 0 or not r["A_comicStateAfterClose"]:
    fails.append(f"A 关闭后应释放监听并清空状态，实际 listeners={r['A_listenersAfterClose']} stateCleared={r['A_comicStateAfterClose']}")
if r["A_pageAfterClosedKeys"] != r["A_pageAfterOpen"] or r["A_writesAfterClosedKeys"] != r["A_writesBeforeClosedKeys"]:
    fails.append("A 关闭后按键不得改页码或写进度")
if r["B_listenersAfterHeal"] != 0 or not r["B_comicStateCleared"]:
    fails.append(f"B DOM 消失后首次按键应自愈，实际 listeners={r['B_listenersAfterHeal']} cleared={r['B_comicStateCleared']}")
if r["C_activeIsNew"] is not True:
    fails.append("C 旧 handler 自愈后，活跃阅读器必须仍是新阅读器（不得错位清理）")
if r["C_newPageAdvanced"] != 11:
    fails.append(f"C 新阅读器应正常工作（翻页到 11），实际 {r['C_newPageAdvanced']}")
if r["C_newKeyHandlerIntact"] is not True or r["C_oldKeyHandlerCleared"] is not True:
    fails.append("C 新阅读器的 keyHandler 必须保留、旧阅读器的必须置空")

if fails:
    for f in fails:
        print("FAIL: " + f)
    print(json.dumps(r, ensure_ascii=False))
    raise SystemExit(f"FAIL: v0.9.67 阅读器关闭行为 {len(fails)} 项未通过")
print(json.dumps(r, ensure_ascii=False))
print("PASS: v0.9.67 阅读器关闭/自愈/并存三场景行为正确（关闭释放监听、自愈只清自身、不误伤新阅读器）")
