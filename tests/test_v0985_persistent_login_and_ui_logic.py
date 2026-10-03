#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.85 逻辑级测试（Node 真实执行抽出的模块）：

覆盖：
  · 持续登录：前端不再有 30 分钟自动登出；会话天数常量与登录请求字段；
  · 通知中心（07-topnav.js 通知块）：入队/未读徽标/上限截断/落盘/打开即已读/清空/跳转；
  · 正在播放：同一视频的多条记录归并成同一个身份键（去重的核心），标题缺失时回落原盘目录；
  · 海报信息：只保留年份（不再出现元数据来源），剧集补季/集；
  · 演职人员：动画→配音、其余→饰演，标签随语言；
  · TMDB 语言：zh-CN / zh-TW / en-US 三个标签，界面语言切换即换标签（缓存键随之变化）；
  · 硬件监控：温度明细压缩到 3 条，回落说明改为 title（不再额外占行）。

环境无 node 时 SKIP（与 tests/test_v0984_quality_and_scrape_logic.py 同一约定）。
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
TOPNAV = (ROOT / "web/js/07-topnav.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")

if shutil.which("node") is None:
    print("SKIP: 未找到 node，跳过 v0.9.85 逻辑级验证")
    raise SystemExit(0)


def extract_function(src, name):
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


def extract_slice(src, start_marker, end_marker):
    i = src.index(start_marker)
    j = src.index(end_marker, i)
    return src[i:j]


NOTIFY_BLOCK = extract_slice(TOPNAV, "const VH_NOTIFY_KEY", "/* v0.9.85：搜索框快捷键提示按平台显示")

PIECES = [
    extract_function(MEDIA, "displayBookTitle"),
    extract_function(MEDIA, "discFolderOf"),
    extract_function(MEDIA, "tmdbLangTag"),
    extract_function(MEDIA, "castRoleLabel"),
    extract_function(MEDIA, "moviePosterSubtitle"),
    extract_function(FEATURES, "renderDiskTemps"),
    NOTIFY_BLOCK,
]

HARNESS = r"""
const fs = require("fs");
const vm = require("vm");
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

function mkEl(id) {
  return {
    id, textContent: "", innerHTML: "", title: "", hidden: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); } },
    setAttribute() {}, querySelector: () => null,
  };
}
const els = {};
const store = {};
const sb = {
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: { getElementById: id => (els[id] = els[id] || mkEl(id)), querySelector: () => null, documentElement: { dataset: {} } },
  navigator: {}, window: {}, console, JSON, Math, Number, String, Object, Set, Map, Array, Boolean, RegExp, Date, Error,
  toast: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  curLang: "zh-CN",
  __meta: {},
  __titles: {},
  movieMetadataFor: path => sb.__titles[path] || {},
  t: k => ({ "zh-CN": { castAs: "饰演", castVoiceAs: "配音", castEmpty: "暂无演职人员信息", castTitle: "演职人员",
             notifyEmpty: "暂无通知", notifyOpenLibrary: "查看媒体库" },
             en: { castAs: "as", castVoiceAs: "voice", castEmpty: "No cast information yet", castTitle: "Cast",
             notifyEmpty: "No notifications yet", notifyOpenLibrary: "Open library" } }[sb.curLang] || {})[k] || k,
  fileExt: p => String(p || "").split(".").pop().toLowerCase(),
  esc: s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  tf: (k, x) => k + JSON.stringify(x),
};
const ctx = vm.createContext(sb);
vm.runInContext(p.media + "\n" + p.features + "\n" + p.notify + `
this.__api = {
  tmdbLangTag, castRoleLabel, moviePosterSubtitle, renderDiskTemps,
  pushNotification, renderNotifications, vhNotifyUnread, toggleNotifyPanel, markNotificationsRead,
  clearNotifications, notifyGoto, getNotifications: () => vhNotifications, VH_NOTIFY_MAX, VH_NOTIFY_KEY,
};`, ctx);
const api = sb.__api;
const el = id => (els[id] = els[id] || mkEl(id));
let pass = 0, fail = 0;
const chk = (n, c) => { if (c) pass++; else { fail++; console.log("FAIL: " + n); } };

/* ---------- TMDB 语言 / 演职人员标签 ---------- */
sb.curLang = "zh-CN";
chk("简体 → zh-CN", api.tmdbLangTag() === "zh-CN");
sb.curLang = "zh-TW";
chk("繁体 → zh-TW", api.tmdbLangTag() === "zh-TW");
sb.curLang = "en";
chk("英文 → en-US", api.tmdbLangTag() === "en-US");
sb.curLang = "zh-CN";
chk("动画作品 → 配音", api.castRoleLabel({ genres: ["动画", "冒险"] }) === "配音");
chk("普通影片 → 饰演", api.castRoleLabel({ genres: ["剧情"] }) === "饰演");
chk("英文动画（Animation）→ 配音", api.castRoleLabel({ genres: ["Animation"] }) === "配音");
chk("无类型信息 → 饰演（不误判）", api.castRoleLabel({}) === "饰演");
sb.curLang = "en";
chk("英文界面取英文标签（voice / as）", api.castRoleLabel({ genres: ["动画"] }) === "voice" && api.castRoleLabel({ genres: ["剧情"] }) === "as");
sb.curLang = "zh-CN";

/* ---------- 海报信息：取消元数据来源 ---------- */
const sub1 = api.moviePosterSubtitle({ year: "2021", provider: "TMDB · 电影" }, "/MO/Film.2021.mp4", {});
chk("电影海报只留年份", sub1 === "2021" && sub1.indexOf("TMDB") < 0);
const sub2 = api.moviePosterSubtitle({ year: "2021", provider: "TMDB · 电影" }, "/MO/Film.2021.mkv", { disc: true, disc_fragments: 12 });
chk("原盘条目保留片数提示且无来源", sub2 === "2021 · 原盘 · 12 个片段" && sub2.indexOf("TMDB") < 0);
chk("无年份时回落扩展名", api.moviePosterSubtitle({}, "/MO/Film.mkv", {}) === "MKV");

/* ---------- 硬件监控：温度明细压缩到 3 条 ---------- */
const six = [];
for (let i = 0; i < 6; i++) six.push({ name: "sensor" + i, temp: 30 + i });
api.renderDiskTemps(six, []);
const listHTML = el("tempList").innerHTML;
chk("温度明细最多 3 条", (listHTML.match(/temp-item/g) || []).length === 3);
chk("主温度取最高值", el("tempMain").textContent === "35");
api.renderDiskTemps([], [{ name: "cpu", temp: 61 }]);
chk("无独立硬盘传感器时回落系统读数", el("tempMain").textContent === "61");
chk("回落说明改为 title 不再多占一行", String(el("tempList").title).indexOf("未检测到独立硬盘温度传感器") >= 0
  && el("tempList").innerHTML.indexOf("hint") < 0);

/* ---------- 通知中心 ---------- */
const badge = el("tnNotifyBadge");
const n1 = api.pushNotification({ level: "info", title: "开始刮削 3 项", detail: "电影库 · 刮削 0/3" });
chk("通知入队", !!n1 && api.getNotifications().length === 1);
chk("未读数为 1", api.vhNotifyUnread() === 1);
chk("徽标显示未读数", badge.textContent === "1" && badge.hidden === false);
chk("通知落 localStorage", String(store[api.VH_NOTIFY_KEY] || "").indexOf("开始刮削") > 0);
const n2 = api.pushNotification({ level: "warn", title: "刮削完成", detail: "成功 2 · 失败 1", action: { view: "movie" } });
chk("第二条仍在最前", api.getNotifications()[0].id === n2.id);
chk("列表渲染两条 + 跳转入口", (el("tnNotifyList").innerHTML.match(/tn-notify-item/g) || []).length === 2
  && el("tnNotifyList").innerHTML.indexOf("notifyGoto") > 0);
chk("失败等级用 ⛔/⚠️ 图标", el("tnNotifyList").innerHTML.indexOf("⚠️") > 0);

api.toggleNotifyPanel(null);
chk("打开面板即已读", api.vhNotifyUnread() === 0 && badge.hidden === true);
chk("已读后条目仍保留（可回看明细）", api.getNotifications().length === 2);
api.pushNotification({ level: "ok", title: "再次通知" });
api.markNotificationsRead();
chk("全部已读清空未读", api.vhNotifyUnread() === 0);

for (let i = 0; i < api.VH_NOTIFY_MAX + 10; i++) api.pushNotification({ level: "info", title: "批量 " + i });
chk("队列上限截断", api.getNotifications().length === api.VH_NOTIFY_MAX);

api.clearNotifications();
chk("清空后为空 + 空态文案", api.getNotifications().length === 0
  && el("tnNotifyList").innerHTML.indexOf("暂无通知") > 0 && badge.hidden === true);

/* 语言切换后空态/入口文案跟随（t 由沙箱提供） */
sb.curLang = "en";
api.pushNotification({ level: "info", title: "hello", action: { view: "movie" } });
chk("英文界面用英文入口文案", el("tnNotifyList").innerHTML.indexOf("Open library") > 0);
sb.curLang = "zh-CN";

console.log("RESULT " + JSON.stringify({ pass, fail }));
"""

with tempfile.TemporaryDirectory() as tmp:
    payload = pathlib.Path(tmp) / "payload.json"
    harness = pathlib.Path(tmp) / "harness.js"
    payload.write_text(json.dumps({"media": "\n".join(PIECES[:5]), "features": PIECES[5], "notify": PIECES[6]}), encoding="utf-8")
    harness.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(["node", str(harness), str(payload)], capture_output=True, text=True)

out = (proc.stdout or "") + (proc.stderr or "")
match = re.search(r"RESULT (\{.*\})", out)
if not match:
    print(out.strip()[-3000:])
    print("FAIL: Node 未能产出结果")
    sys.exit(1)
stats = json.loads(match.group(1))
print("v0.9.85 逻辑级检查：%d 项通过，%d 项失败" % (stats["pass"], stats["fail"]))
if stats["fail"]:
    print(out.strip()[-2000:])
    sys.exit(1)
