#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.55 契约测试：
T1 移动端侧栏改顶栏（@media≤768 .sidebar 横向导航 + .main 边距归零 + 折叠/拖拽隐藏）
T2 密码验证鉴权（open 模式保留 salt/hash、account 任意变更需旧密码、passwordOK 不因 open 短路）
T3 文件列表读取鉴权 + 清除下载权限（readAuth、/api/media/file|archive|streams 401、前端去下载按钮/直链）
T4 开放模式不显示登录窗口（authMask 初始 hidden、auth/mode has_password、切回密码需当前密码）
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


def check(name, cond):
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok: {name}")


def main():
    # ---------- T1 移动端顶栏 ----------
    css = read("web/css/main.css")
    # 768px 媒体查询里 sidebar 变顶栏
    m768 = css[css.find("@media (max-width: 768px)"):]
    m768 = m768[: m768.find("/* ================= v0.9.51")]
    check("T1 768px 段含 sidebar 顶栏化", "top: var(--topbar-h); bottom: auto;" in m768 and "width: 100% !important" in m768)
    check("T1 顶栏高度 44px", "height: 44px" in m768)
    check("T1 nav 横向滚动", ".sidebar .nav {" in m768 and "flex-direction: row" in m768 and "overflow-x: auto" in m768)
    check("T1 main 边距归零", ".main { margin-left: 0 !important" in m768)
    check("T1 折叠按钮隐藏", ".rail-collapse { display: none; }" in m768)
    check("T1 resizer 隐藏", ".sidebar-resizer { display: none; }" in m768)
    check("T1 nav-group 隐藏", ".sidebar .nav-group { display: none; }" in m768)

    # ---------- T2 密码验证鉴权 ----------
    mgr = read("manager/main.go")
    check("T2 passwordOK 不再因 open 短路", "if m.hash == \"\"" in mgr and "m.open || m.hash" not in mgr)
    check("T2 account 存在凭据即校验旧密码", 'if m.hash != "" && !m.passwordOK(x.OldPassword)' in mgr)
    check("T2 切开放不再清空凭据", "m.salt, m.hash = \"\", \"\"" not in mgr)
    check("T2 open 切回必须设新密码(纯开放)", "curOpen && m.hash == \"\" && x.Password == \"\"" in mgr)
    check("T2 authMode 暴露 has_password", '"has_password": hashed' in mgr)
    # auth.json 开放模式也落 hash
    check("T2 saveAuthFile 开放模式保留凭据", "s.Salt, s.Hash = m.salt, m.hash" in mgr and "s.Mode = \"open\"" in mgr)

    # 前端强制旧密码
    js = read("web/js/01-state.js")
    check("T2 前端 has_password 状态", "vaultHubHasPassword = !!data.has_password" in js)
    check("T2 保存账户需当前密码", 'if (needOld && !curPw) { toast("⚠️ 请输入当前密码后再保存账户信息"); return; }' in js)
    check("T2 切回密码模式需当前密码", 'const needOld = vaultHubHasPassword || vaultHubAuthMode !== "open";' in js)

    # ---------- T3 读取鉴权 + 清除下载 ----------
    mgo = read("media-go/main.go")
    check("T3 readAuth 定义", "func readAuth(r *http.Request) bool {" in mgo)
    check("T3 files 加 readAuth", mgo.count("if !readAuth(r) {") >= 1)
    # serve/serveLegacy/archive/streams 各自带 readAuth
    serve_idx = mgo.find("func (a *App) serve(")
    check("T3 serve 前有 readAuth", "if !readAuth(r) {" in mgo[serve_idx: serve_idx + 120])
    sla_idx = mgo.find("func (a *App) serveLegacy(")
    check("T3 serveLegacy 前有 readAuth", "if !readAuth(r) {" in mgo[sla_idx: sla_idx + 120])
    arc_idx = mgo.find("func (a *App) archive(")
    check("T3 archive 前有 readAuth", "if !readAuth(r) {" in mgo[arc_idx: arc_idx + 120])
    str_idx = mgo.find("func streams(")
    check("T3 streams 前有 readAuth", "if !readAuth(r) {" in mgo[str_idx: str_idx + 120])

    js2 = read("web/js/02-media.js")
    check("T3 下载按钮移除", '"下载"' not in js2.replace("下载机", "").replace("可下载", "") or "不可预览" in js2)
    check("T3 行渲染用 不可预览", 'action === "不可预览"' in js2 and "media-file-note" in js2)
    check("T3 直链下载移除", "尝试在浏览器打开" not in js2)
    check("T3 不可预览提示文案", "该格式不支持在线预览" in js2)

    # ---------- T4 开放模式不显示登录窗 ----------
    html = read("index.html")
    check("T4 authMask 初始 hidden", '<div class="auth-mask hidden" id="authMask">' in html)
    js3 = read("web/js/01-state.js")
    check("T4 开放模式永不显示遮罩", "handleVaultHubAuthResult(true); // 开放模式永不显示登录遮罩" in js3)

    print("ALL PASS")


if __name__ == "__main__":
    main()
