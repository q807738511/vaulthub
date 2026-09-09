#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.58 契约测试 —— 登录安全加固的可静态检查断言：
   1) 移除 admin123 默认密码（compose / Dockerfile 不再携带）
   2) 一次性随机初始密码 + 持久化（Go generateRandomPassword / must_change）
   3) 登录后强制改密（受限会话：sessionEntry.mustChange / restrictedAllowed 白名单）
   4) 增强密码校验（Go validatePassword / 前端 validateClientPassword）
   5) 强制改密弹窗（index.html forcedPasswordModal + 前端 show/submit 函数）
   另含版本串、release notes 等常规检查。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web" / "js" / "01-state.js").read_text(encoding="utf-8")
MANAGER = (ROOT / "manager" / "main.go").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
NOTES = (ROOT / ".github" / "RELEASE_NOTES_0.9.58.md").read_text(encoding="utf-8")

failures = []
def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name} {detail}".strip())

# ---------------------------------------------------------------- 1. 移除默认密码
check("compose 不再内置 admin123", "ADMIN_PASSWORD=admin123" not in COMPOSE)
check("compose ADMIN_PASSWORD 留空", "- ADMIN_PASSWORD=" in COMPOSE)
check("Dockerfile 不再内置 ADMIN123", "ADMIN_PASSWORD=ADMIN123" not in DOCKERFILE)
check("Dockerfile ADMIN_PASSWORD 留空", "ADMIN_PASSWORD= " in DOCKERFILE)

# ---------------------------------------------------------------- 2. 随机初始密码
check("随机密码生成器", "func generateRandomPassword() (string, error)" in MANAGER)
check("无歧义字符集", "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789" in MANAGER)
check("must_change 结构字段", "MustChange" in MANAGER and 'json:"must_change,omitempty"' in MANAGER)
check("一次性消费持久化字段", "BootstrapConsumed bool" in MANAGER and "bootstrap_consumed" in MANAGER)
check("首启公布密码到日志", 'log.Printf("  login password: %s", randomPw)' in MANAGER)
check("首启持久化随机密码", "m.mustChange = mustChange" in MANAGER and "m.saveAuthFile()" in MANAGER)
check("初始状态持久化失败即退出", 'log.Fatalf("v0.9.58: could not persist initial auth state' in MANAGER)
check("损坏 auth 状态拒绝重生", "exists but is invalid; refusing to generate a replacement password" in MANAGER)
check("admin123 环境值视为不安全", 'strings.EqualFold(strings.TrimSpace(password), "admin123")' in MANAGER)
check("随机源失败不使用可预测回退", "时间+进程号派生串" not in MANAGER)
check("空密码不再进入开放模式", "m.open = false" in MANAGER and "不再进入开放模式" in MANAGER)

# ---------------------------------------------------------------- 3. 强制改密（受限会话）
check("受限会话结构", "type sessionEntry struct" in MANAGER and "mustChange bool" in MANAGER)
check("受限会话白名单", "func restrictedAllowed(path string) bool" in MANAGER)
check("登录响应带 must_change", '"must_change": forceChange' in MANAGER)
check("受限会话拦截受保护操作", "ent.mustChange && !restrictedAllowed" in MANAGER)
check("受限会话拦截媒体写", "ent.mustChange {" in MANAGER)
check("改密成功后清除/放行", "m.mustChange = false" in MANAGER and "unrestrictSession" in MANAGER)

# ---------------------------------------------------------------- 4. 增强密码校验
check("Go 增强校验函数", "func validatePassword(pw, username string) string" in MANAGER)
check("至少 8 位", 'return "密码至少 8 位"' in MANAGER)
check("字母+数字", 'return "密码需同时包含字母和数字"' in MANAGER)
check("弱口令黑名单", "weakPasswords" in MANAGER and '"admin123"' in MANAGER)
check("前端镜像校验", "function validateClientPassword(pw, username)" in STATE)
check("前端黑名单一致", "admin123" in STATE and "validateClientPassword" in STATE)

# ---------------------------------------------------------------- 5. 强制改密弹窗
check("弹窗容器", 'id="forcedPasswordModal"' in HTML)
check("弹窗字段", 'id="forcedCurrentPassword"' in HTML and 'id="forcedNewPassword"' in HTML
      and 'id="forcedNewPassword2"' in HTML)
check("弹窗提交", 'onclick="submitForcedPasswordChange()"' in HTML)
check("前端 show/submit 函数", "function showForcedPasswordChange(oldPw)" in STATE
      and "async function submitForcedPasswordChange()" in STATE)
check("must_change 状态变量", "let vaultHubMustChange = false;" in STATE)
check("登录后触发强制改密", "if (data.must_change) { vaultHubMustChange = true; showForcedPasswordChange" in STATE)
check("遮罩点击不可关闭", 'm.id !== "forcedPasswordModal"' in (ROOT / "web" / "js" / "03-features.js").read_text(encoding="utf-8"))

# ---------------------------------------------------------------- 版本与发布
check("版本资源", 'VAULTHUB_ASSET_VERSION = "0.9.61"' in HTML)
check("脚本版本", 'VAULTHUB_SCRIPT_VERSION = "0.9.61"' in STATE)
check("缓存串", HTML.count("?v=0.9.61") >= 6)
check("UI 当前版本角标", "v0.9.61 · Secure First Boot" in HTML)
check("v0.9.58 release notes 保留", NOTES != "" and "VaultHub v0.9.58" in NOTES and "强制改密" in NOTES)
check("无旧版本缓存串残留", "?v=0.9.57" not in HTML)

if failures:
    print(f"FAIL: {len(failures)} 项 v0.9.58 契约未满足")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("PASS: v0.9.58 默认密码移除/随机初始密码/强制改密/增强密码校验/改密弹窗契约通过")
