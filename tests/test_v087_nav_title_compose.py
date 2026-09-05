#!/usr/bin/env python3
"""v0.8.7 契约测试（RED → GREEN）。

覆盖用户提出的三项修复：
1. 侧栏「电子书」点击后不再跳回/停留在「漫画」——侧栏条目必须用唯一键选中，
   switchView 不能再用 `.nav-item[data-view="comic"]` 取第一个匹配节点。
2. 阅读器/播放器顶栏的媒体标题不再覆盖右侧按钮——标题必须能收缩，
   按钮组不能收缩，并且两者不能重叠。
3. compose 精简：固定环境变量搬到 vaulthub.env，compose 用 KEY=value 写法，
   且不再出现 `KEY: "value"` 这种在 list 语法下会被解析成 map 的错误写法。

直接运行：python3 tests/test_v087_nav_title_compose.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILS = []


def read(rel):
    """缺文件时记为契约失败而不是抛栈，方便 RED 阶段一次看到全部缺口。"""
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        FAILS.append(f"缺少文件 {rel}")
        return ""
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def check(name, ok, detail=""):
    if not ok:
        FAILS.append(f"{name}" + (f" → {detail}" if detail else ""))


# ---------------------------------------------------------------- 需求 1
state = read("web/js/01-state.js")
home = read("web/js/05-home.js")
media = read("web/js/02-media.js")

# 侧栏条目必须带唯一标识；漫画与电子书都是 data-view="comic"，
# 因此高亮必须按 data-nav-key（或 libId）匹配，不能只按 data-view。
check("侧栏条目带唯一 data-nav-key",
      'data-nav-key="' in home,
      "05-home.js 未输出 data-nav-key")

check("switchView 不再用 data-view 单选择器取首个节点",
      'querySelector(`.nav-item[data-view="${v}"]`)' not in state
      and "querySelector('.nav-item[data-view=\"' " not in state,
      "01-state.js 仍按 data-view 取第一个匹配项")

check("switchView 支持按唯一键高亮",
      "navKey" in state and "data-nav-key" in state,
      "01-state.js 缺少 navKey 高亮逻辑")

# 侧栏每 5 秒被 initHome 的定时器整体重建，只把 active 打在 DOM 节点上会在重绘后
# 丢失（表现为「点完 5 秒后侧栏什么都不亮」）。选中键必须记到 window 上，
# 并在 renderHomeLibraryNav() 重建后重新套用。
check("switchView 把选中键记到 window",
      "window.vaultHubActiveNavKey" in state,
      "01-state.js 未持久化选中键")
check("switchView 无 libId 时用当前选中媒体库兜底",
      "localMediaSelection[v]" in state,
      "01-state.js 未回落到 localMediaSelection")
nav_fn = re.search(r"function renderHomeLibraryNav\(\)\s*\{(.*?)\n\}", home, re.S)
check("renderHomeLibraryNav 存在", bool(nav_fn))
if nav_fn:
    body = nav_fn.group(1)
    check("侧栏重绘后重新套用高亮",
          "vaultHubActiveNavKey" in body and 'classList.add("active")' in body,
          "重绘后未恢复 active")
    check("恢复高亮发生在 innerHTML 重建之后",
          body.index("host.innerHTML") < body.index("vaultHubActiveNavKey"),
          "顺序错误，会被 innerHTML 覆盖")

# openHomeLibrary 必须把当前选中的媒体库传给 switchView，
# 否则 switchView 无从知道该高亮哪一个同组媒体库。
m = re.search(r"function openHomeLibrary\(([^)]*)\)\s*\{(.*?)\n\}", home, re.S)
check("openHomeLibrary 仍然存在", bool(m))
if m:
    # 去掉注释再比顺序，否则注释里提到的函数名会干扰判断。
    body = re.sub(r"/\*.*?\*/", "", m.group(2), flags=re.S)
    body = re.sub(r"//.*", "", body)
    check("openHomeLibrary 先选库再切页",
          body.index("selectLocalLibrary") < body.index("switchView"),
          body.strip().replace("\n", " "))
    check("openHomeLibrary 把媒体库 id 传给 switchView",
          re.search(r"switchView\(\s*group\s*,\s*libId\s*\)", body) is not None,
          body.strip().replace("\n", " "))

# 切库必须真正落到 localMediaSelection 并重渲染
check("selectLocalLibrary 写入 localMediaSelection 后重渲染",
      re.search(r"function selectLocalLibrary\(group,\s*id\)\s*\{[^}]*localMediaSelection\[group\]\s*=\s*id;[^}]*renderLocalMedia\(group\)", media, re.S) is not None)

# v0.9.30：书架标题改为直接展示媒体库创建时填写的库名称，
# 不再显示「电子书 / 漫画」等预设大类名。
check("书架标题使用媒体库名称",
      "function mediaLibraryHeading(lib" in media and "esc(name)" in media,
      "标题没有使用 lib.name")
check("书架标题不再写死预设大类名",
      '"电子书" : "漫画"' not in media and "'电子书' : '漫画'" not in media,
      "仍在按预设大类渲染标题")

# ---------------------------------------------------------------- 需求 2
css = read("web/css/main.css")

head_rule = re.search(r"\.media-reader-head \{([^}]*)\}", css)
check("存在 .media-reader-head 规则", bool(head_rule))

title_rule = re.search(r"\.media-reader-title \{([^}]*)\}", css)
check("存在 .media-reader-title 规则", bool(title_rule))
if title_rule:
    body = title_rule.group(1)
    # 标题必须可收缩：flex 收缩 + min-width:0 + 省略号
    check("标题允许收缩（flex:1 1 auto 或 flex:1）",
          re.search(r"flex\s*:\s*1", body) is not None, body.strip())
    check("标题 min-width:0 防止 flex 溢出",
          "min-width:0" in body.replace(" ", ""), body.strip())
    check("标题超长省略号", "text-overflow:ellipsis" in body.replace(" ", ""), body.strip())

actions_rule = re.search(r"\.media-reader-head \.media-actions \{([^}]*)\}", css)
check("按钮组有独立规则且不收缩", bool(actions_rule))
if actions_rule:
    body = actions_rule.group(1).replace(" ", "")
    check("按钮组 flex:0 0 auto（不被标题挤压）",
          "flex:0 0 auto".replace(" ", "") in body, actions_rule.group(1).strip())
    check("按钮组不换行（nowrap）", "flex-wrap:nowrap" in body, actions_rule.group(1).strip())

# 顶栏内不能再继承全局 .media-actions 的 margin-top:8px —— 那会把按钮推下去
check("顶栏按钮组清掉全局 margin-top",
      actions_rule is not None and "margin-top:0" in actions_rule.group(1).replace(" ", ""),
      "仍继承 .media-actions{margin-top:8px}")

# 阅读器标题不再整段直接吃满：必须限制最大宽度
if title_rule:
    check("标题限制最大宽度，给按钮留位",
          "max-width" in title_rule.group(1),
          title_rule.group(1).strip())

# 真正让用户截图里「标题压住顶栏设置按钮」的原因：overlay 是 top:0 + z-index:300，
# 整条盖住了 .topbar（fixed, height:52px, z-index:80）。overlay 必须从顶栏下方开始。
overlay_rules = re.findall(r"\.media-reader-overlay[^{]*\{([^}]*)\}", css)
check("存在 .media-reader-overlay 规则", bool(overlay_rules))
base_overlay = next((b for b in overlay_rules if "position:fixed" in b.replace(" ", "")), "")
check("overlay 从顶栏下方开始（top 不是 0）",
      "top:var(--topbar-h)" in base_overlay.replace(" ", ""), base_overlay.strip())
check("overlay 不再用 min-height:100vh 顶出顶栏",
      "min-height:100vh" not in base_overlay.replace(" ", ""), base_overlay.strip())
# 窄屏分支同样要留出顶栏，否则 ≤768px 下按钮照样点不到
narrow_overlay = next((b for b in overlay_rules if "inset" in b), "")
check("窄屏 overlay 也给顶栏留位",
      "inset:var(--topbar-h)" in narrow_overlay.replace(" ", ""), narrow_overlay.strip())
# 正文高度要跟着扣掉顶栏，否则底部被裁掉
body_rule = re.search(r"\.media-reader-body \{([^}]*)\}", css)
check("阅读器正文高度扣掉顶栏",
      body_rule is not None and "var(--topbar-h)" in body_rule.group(1),
      body_rule.group(1).strip() if body_rule else "(缺失)")
video_rules = re.findall(r"\.media-video-body \{([^}]*)\}", css)
video_rule = next((r for r in video_rules if "min-height" in r and "var(--topbar-h)" in r), None)
check("视频区最小高度扣掉顶栏",
      video_rule is not None,
      (video_rules[0].strip() if video_rules else "(缺失)"))
# 电子书阅读器顶栏还带字号工具条，按钮组固定约 351px 且 nowrap，
# 窄于约 375px 时关闭按钮会被挤出屏幕（320px 下完全不可点）。
check("窄屏隐藏电子书字号工具条以保住关闭按钮",
      re.search(r"@media \(max-width: ?4[0-9]{2}px\) \{[^}]*\.ebook-toolbar \{ ?display:none", css, re.S) is not None,
      "缺少窄屏隐藏 .ebook-toolbar 的断点")

# 详情页关闭按钮是 position:fixed，也必须相对顶栏下方定位，
# 否则 overlay 下移后它会单独浮在顶栏统计信息上面。
detail_close = re.search(r"\.movie-detail-scroll>\.media-reader-close \{([^}]*)\}", css)
check("详情页关闭按钮避开顶栏",
      detail_close is not None and "var(--topbar-h)" in detail_close.group(1),
      detail_close.group(1).strip() if detail_close else "(缺失)")

# ---------------------------------------------------------------- 需求 3
compose = read("docker-compose.yml")
env_file = read("vaulthub.env")

# compose 必须引用 env_file（v0.9.56 起为可选覆盖层：path + required: false）
check("compose 通过 env_file 引用 vaulthub.env",
      re.search(r"env_file:\s*\n\s*-\s*path:\s*\.?/?vaulthub\.env\s*\n\s*required:\s*false", compose) is not None,
      "compose 未声明可选 env_file")

# compose 里 environment 段必须全是 KEY=value 列表写法，
# 绝不能出现 `- KEY: "value"`（这正是用户遇到的 unexpected type map 报错）。
env_block = re.search(r"\n    environment:\n((?:      -.*\n|      #.*\n)*)", compose)
check("compose 保留 environment 段", bool(env_block))
if env_block:
    lines = [ln.strip() for ln in env_block.group(1).splitlines() if ln.strip().startswith("- ")]
    bad = [ln for ln in lines if re.match(r"-\s*[A-Z0-9_]+\s*:", ln)]
    check("compose environment 无 `- KEY: value` 映射写法", not bad, "; ".join(bad[:3]))
    check("compose environment 全部 KEY=value",
          all("=" in ln for ln in lines), "; ".join(ln for ln in lines if "=" not in ln))
    # 精简：只保留常用项
    check("compose environment 已精简（不超过 12 项）",
          len(lines) <= 12, f"当前 {len(lines)} 项")

# vaulthub.env 也必须是 KEY=value，且承载固定参数
env_lines = [ln.strip() for ln in env_file.splitlines()
             if ln.strip() and not ln.strip().startswith("#")]
for s in env_lines:
    check(f"vaulthub.env 行是 KEY=value: {s[:40]}", re.match(r"^[A-Z0-9_]+=", s) is not None, s)
# env_file 不做变量插值以外的处理，但 compose 会展开 ${VAR:-default}。
# 写成字面量会让用户在 .env 里的覆盖被静默忽略（v0.8.6 时是生效的）。
literal = [s for s in env_lines if not re.match(r"^[A-Z0-9_]+=\$\{[A-Z0-9_]+(:-[^}]*)?\}$", s)]
check("vaulthub.env 保留 ${VAR:-默认值} 覆盖能力", not literal,
      "写成字面量的行: " + "; ".join(literal[:3]))

fixed_keys = ["SYSTEM_MONITOR_PROC_ROOT", "SYSTEM_MONITOR_SYS_ROOT", "MEDIA_ROOT",
              "MEDIA_RUNTIME_CONFIG", "TMDB_API_BASE", "TMDB_IMAGE_BASE",
              "SUBTITLE_SHOOTER_ENDPOINT", "NVIDIA_DRIVER_CAPABILITIES"]
missing = [k for k in fixed_keys if not re.search(rf"^{k}=", env_file, re.M)]
check("固定参数已归集到 vaulthub.env", not missing, "缺少: " + ",".join(missing))

# 固定参数不应再重复出现在 compose 的 environment 段
if env_block:
    dup = [k for k in fixed_keys if re.search(rf"-\s*{k}=", env_block.group(1))]
    check("固定参数不再重复出现在 compose", not dup, "重复: " + ",".join(dup))

# 不要在部署配置里放没有任何代码读取的死变量：PROXY_HOST 曾被写进 compose，
# 但仓库里没有任何 Go/C/shell 代码读它，TMDB 客户端的自定义 Transport 也没设 Proxy，
# 留着只会让用户以为配了代理就能刮削。
dead = [k for k in ["PROXY_HOST"] if re.search(rf"^\s*-?\s*{k}=", compose + env_file, re.M)]
check("部署配置不含无效的代理变量", not dead, "存在死变量: " + ",".join(dead))

# 常用项仍留在 compose 里方便直接改
common = ["ADMIN_USERNAME", "ADMIN_PASSWORD", "TMDB_API_KEY"]
if env_block:
    lost = [k for k in common if not re.search(rf"-\s*{k}=", env_block.group(1))]
    check("常用项仍展示在 compose", not lost, "缺少: " + ",".join(lost))

# v0.9.56：compose 跟随 GHCR 可写 latest（每次正式版本 tag 与版本号同 digest）
check("compose 跟随 GHCR latest（v0.9.56 起）",
      "image: ghcr.io/q807738511/vaulthub:latest" in compose, "未引用 vaulthub:latest")
check("compose 保留固定版本回滚说明",
      "v0.9.41" in compose or ":latest" in compose, "缺少回滚指引")

# v0.9.56：README.md 改为项目介绍（不再放更新日志），Update Log.md 归档历史版本。
# 主页 README 需要带 vaulthub.env 可选层说明（部署段引用 vaulthub.env）；更新日志里也要有。
readme = read("README.md")
updatelog = read("Update Log.md")
check("README 说明 vaulthub.env", "vaulthub.env" in readme or "vaulthub.env" in updatelog)
check("README 指向 Update Log", "Update Log.md" in readme)
check("Update Log 保留主页入口", "README.md" in updatelog)

# env_file 在 v0.9.56 已是可选（required: false，缺失不报错）；历史安装/升级脚本
# 仍会投递 vaulthub.env，且不能覆盖用户已改过的值。
for script in ["scripts/install.sh", "scripts/upgrade.sh"]:
    text = read(script)
    check(f"{script} 投递 vaulthub.env", "vaulthub.env" in text)
    check(f"{script} 保留已存在的 vaulthub.env",
          re.search(r'if \[ ! -f "\$TARGET_DIR/vaulthub\.env" \]', text) is not None,
          "缺少存在性判断，会覆盖用户配置")
check("upgrade.sh 备份 vaulthub.env",
      re.search(r"for name in .*vaulthub\.env.*SHA256SUMS", read("scripts/upgrade.sh")) is not None)
check("rollback.sh 还原 vaulthub.env",
      re.search(r"for name in .*vaulthub\.env.*SHA256SUMS", read("scripts/rollback.sh")) is not None,
      "备份与还原不对称")

# 版本号
check("index.html 版本号为 v0.8.7",
      read("index.html").count("v0.9.56") >= 2,
      f"出现 {read('index.html').count('v0.9.56')} 次")

# ---------------------------------------------------------------- 输出
if FAILS:
    print(f"FAIL: v0.8.7 契约 {len(FAILS)} 项未通过")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("PASS: v0.8.7 侧栏切库、顶栏标题与 compose 精简契约通过")
