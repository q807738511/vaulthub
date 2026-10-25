#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.8 契约测试：页尾精简、NFO 合并写回、全量审查修复点、版本纪律。

静态契约；NFO 合并的真实行为由 media-go/v1003_nfo_merge_test.go 与
media-go/v1003_audit_test.go 覆盖，页尾高度/结构由容器内浏览器实测覆盖。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAILS = []


def check(name, cond, extra=""):
    if cond:
        print("PASS:", name)
    else:
        FAILS.append(name)
        print("FAIL:", name, extra)


def rd(p):
    return (ROOT / p).read_text(encoding="utf-8")


HTML = rd("index.html")
STATE = rd("web/js/01-state.js")
CSS = rd("web/css/main.css")
GO = rd("media-go/main.go")
NM = rd("media-go/nfo_merge.go")
NW = rd("media-go/nfo_write.go")
LM = rd("media-go/local_metadata.go")
NET = rd("media-go/network.go")
COVER = rd("media-go/cover_persist.go")
MGR = rd("manager/main.go")
LOG = rd("Update Log.md")
NOTES = rd(".github/RELEASE_NOTES_1.0.3.md")
AUDIT = rd(".github/AUDIT-1.0.3.md")

SLOGAN = "v1.0.8 · 转码可拖动 · 音乐按歌手 · 刮削落盘"

print("== 1. 需求1：页尾只留「当前版本 + 版本功能提示」==")
FOOTER = HTML[HTML.index('class="app-footer" id="appFooter"'):]
FOOTER = FOOTER[:FOOTER.index("</footer>")]
check("1a 页尾只保留版本容器", 'id="appFooterVer"' in FOOTER and FOOTER.count("<span") == 1)
check("1b 页尾不再有「与关于页保持一致」提示",
      "af-note" not in HTML and "版本与「系统设置 → 账户与登录 → 关于」中的版本参数保持一致" not in HTML)
check("1c 页尾不再有品牌名占位（只展示版本与功能提示）", "af-name" not in HTML and "af-name" not in CSS)
check("1d 三语语言包已移除该提示键", STATE.count("footerAboutHint:") == 0)
check("1e 页尾展示版本 + 功能提示整串", SLOGAN in FOOTER)
check("1f 页尾高度已压缩（margin 26→10 / padding 12→5）",
      "margin:10px 0 0" in CSS and "padding:5px 2px 3px" in CSS and "margin:26px 0 2px" not in CSS)
check("1g 页尾字号与行高收紧", "font-size:11.5px; line-height:1.35" in CSS)
check("1h 版本同步逻辑保留（仍从关于页读取，避免两处维护）",
      "function appVersionLabel()" in STATE and "function syncAppFooterVersion()" in STATE
      and 'getElementById("appFooterVer")' in STATE)

print("\n== 2. 需求2：NFO 识别加固 + 冲突合并写回 ==")
check("2a 新增合并模块与结果类型", "func nfoMergeIntoExisting(" in NM and "type nfoMergeResult struct" in NM)
check("2b 外置 NFO 走合并（保留原值 + 补缺失 + 记冲突）",
      "nfoMergeIntoExisting(existing, doc)" in NW and 'Merged    []string `json:"merged"`' in NM
      and 'Conflicts []string `json:"conflicts"`' in NM)
check("2c 无法解析的 NFO 一个字节都不动", "不可解析：保持原样" in NW or "一个字节都不动" in NW)
check("2d VaultHub 自己写的 NFO 仍整份重写", "nfoMarker" in NW and "overwrite" in NW)
check("2e 合并采用文本级插入（保留 studio/tag/注释等未知节点）",
      "文本级插入" in NM and "lineStart" in NM)
check("2f BOM / UTF-16 解码", "func nfoDecodeText(" in NM and "utf16.Decode" in NM)
check("2g 读取端使用解码后的字节解析", "xml.Unmarshal(nfoDecodeText(raw), &doc)" in LM)
check("2h 文件名大小写不敏感兜底", "EqualFold(ent.Name(), filepath.Base(name))" in LM)
check("2i 接口返回合并/冲突明细", '"merged": mergedFields, "conflicts": conflicts' in NW)
check("2j 演员/类型/uniqueid 语义去重", "haveActor" in NM and "haveGenre" in NM and "haveUID" in NM)

print("\n== 3. 需求3：全量审查修复点 ==")
check("3a SSRF：出站目标公网校验（代理场景同样生效）",
      "func ensurePublicTarget(" in NET and "coverTargetGuard(r.Context(), u)" in COVER
      and "var coverTargetGuard = ensurePublicTarget" in COVER)
check("3b SSRF：拒绝回环/私网/链路本地/本地域名", all(
      k in NET for k in ("localhost", "metadata.google.internal", ".local", "publicIP(item.IP)",
                         "publicIP(ip)")))
check("3c 字幕抽取端点补鉴权", 'func (a *App) extractSubtitle' in GO
      and "func (a *App) extractSubtitle(w http.ResponseWriter, r *http.Request) {\n\t/* v1.0.3（审查 S-2）" in GO
      and 'if !readAuth(r) {\n\t\terrJSON(w, 401, "login required")' in GO)
check("3d 系统监控端点补鉴权", "v1.0.3（审查 S-3）" in GO and GO.count('if !readAuth(r) {') >= 3)
check("3e 登录限流改用 XFF 最后一跳", "parts[len(parts)-1]" in MGR)
check("3f 死代码 commandJSON 已删除", "func commandJSON(" not in GO)
check("3g 审查报告存在且覆盖修复项",
      (ROOT / ".github/AUDIT-1.0.3.md").exists() and all(
          k in AUDIT for k in ("S-1", "S-2", "S-3", "S-4", "R-1", "SSRF")))
check("3h 审查回归测试存在",
      (ROOT / "media-go/v1003_audit_test.go").exists()
      and (ROOT / "media-go/v1003_nfo_merge_test.go").exists())

print("\n== 4. 版本与发布纪律 ==")
check("4a 资源版本 ≥11 处且为本版", len(re.findall(r"\?v=1\.0\.8", HTML)) >= 11)
check("4b 全部静态资源版本串只出现本版", set(re.findall(r"\?v=([0-9.]+)", HTML)) == {"1.0.8"})
check("4c ASSET / SCRIPT 版本一致",
      'VAULTHUB_ASSET_VERSION = "1.0.8"' in HTML
      and 'VAULTHUB_SCRIPT_VERSION = "1.0.8"' in STATE)
check("4d 三处标语整串一致", len(re.findall(r"v1\.0\.8 · [^<\"]+", HTML)) == 3
      and len(set(re.findall(r"v1\.0\.8 · [^<\"]+", HTML))) == 1)
check("4e 安装/升级脚本版本同步",
      'VERSION="v1.0.8"' in rd("scripts/install.sh") and 'VERSION="v1.0.8"' in rd("scripts/upgrade.sh"))
# v1.0.8：日志顶部已换成当前版本，改成「v1.0.3 段落仍完整」。
_v103 = LOG.split("# VaultHub 蜀鼠之家 v1.0.3")[1].split("\n# VaultHub")[0] if "# VaultHub 蜀鼠之家 v1.0.3" in LOG else ""
check("4f Update Log 保留完整的 v1.0.3 段落",
      bool(_v103) and all(k in _v103 for k in ("页尾精简", "NFO 识别修复", "全量审查"))
      and LOG.startswith("# VaultHub 蜀鼠之家 v1.0.8"))
check("4g 发布说明存在且覆盖三项 + 审查结论",
      len(NOTES) > 1200 and all(k in NOTES for k in ("页尾精简", "NFO", "审查")))

print("\n== 5. 洗版自查（内网字面量不得进源码）==")
BAD = re.compile(r"enged\.top|192\.168\.|/vol[1-4]")
for p in ("media-go/nfo_merge.go", "media-go/nfo_write.go", "media-go/network.go",
          "media-go/cover_persist.go", "media-go/v1003_nfo_merge_test.go",
          "media-go/v1003_audit_test.go", ".github/AUDIT-1.0.3.md", "tests/test_v1003_contract.py"):
    check("5 无禁用字面量: " + p, not BAD.search(rd(p)))

if FAILS:
    print(f"\n===== v1.0.8 契约测试：{len(FAILS)} 项失败 =====")
    for f in FAILS:
        print("  -", f)
    raise SystemExit(1)
print("\n===== v1.0.8 契约测试：全部通过 =====")
