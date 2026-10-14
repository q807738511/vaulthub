#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# v0.9.95 契约测试：迷你播放器「按需出现」+ CI 校验收紧 + 独立安全审查修复项（静态检查）
# 口径：断言「新实现存在」且「旧实现已不存在」；安全修复项留成回归护栏（防回去）。
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILED = []

def rd(p):
    with io.open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()

def check(label, cond, detail=""):
    if cond:
        print(f"  ✔ {label}")
    else:
        print(f"  ✗ {label}" + (f"  [{detail}]" if detail else ""))
        FAILED.append(label)

HTML = rd("index.html")
CSS = rd("web/css/main.css")
M = rd("web/js/02-media.js")
S = rd("web/js/01-state.js")
VALIDATE = rd(".gitea/workflows/validate.yml")
PUBLISH = rd(".gitea/workflows/publish-image.yml")
RELEASE_NAS = rd("scripts/release-nas.sh")
ROLLBACK = rd("scripts/rollback.sh")
CI_RELEASE = rd("scripts/ci-release-gitea.sh")
INSTALL = rd("scripts/install.sh")
UPGRADE = rd("scripts/upgrade.sh")
README = rd("README.md")
GITEE_WF = rd(".workflow/publish.yml")
MANAGER = rd("manager/main.go")
INITPW = rd("manager/v0995_initial_password.go")
LOG = rd("Update Log.md")
# v0.9.98：本测试校验的是 v0.9.97 那轮发布说明的内容，仍指向 0.9.97 的历史文件；
# 「当前版本的发布说明存在」由下面版本无关的断言负责。
NOTES = rd(".github/RELEASE_NOTES_0.9.97.md")
import re as _re
_CUR = _re.search(r'VAULTHUB_ASSET_VERSION = "([0-9.]+)"', HTML).group(1)
check("4c 当前版本的发布说明存在且够长",
      os.path.exists(os.path.join(ROOT, f".github/RELEASE_NOTES_{_CUR}.md"))
      and len(open(os.path.join(ROOT, f".github/RELEASE_NOTES_{_CUR}.md"), encoding="utf-8").read()) >= 500)

print("== 1. 迷你播放器只在「播放面不可见」时出现 ==")
check("1a 门控条件接入可见性判定（新口径）",
      "const show = !!cur && !immersive && !surfaceVisible;" in S
      and 'typeof playbackSurfaceVisible === "function" ? !!playbackSurfaceVisible(cur) : false' in S)
check("1b v0.9.94 的「有播放就显示」旧条件已不存在", "const show = !!cur && !immersive;" not in S)
check("1c 取不到可见性判定时仍退回「有播放就显示」（兜底不丢功能）",
      ': false;' in S.split("const surfaceVisible")[1][:120])
check("1d 可见性判定仍由 02-media.js 提供（视图 active + 播放器/播放条可见）",
      "function playbackSurfaceVisible(cur)" in M
      and 'const view = document.getElementById("view-" + (cur.group || "audio"))' in M
      and 'bar.classList.contains("show")' in M
      # v0.9.97（需求1）：影视分支改按「有没有渲染盒子」判定 —— 旧写法用的是
      # overlay.offsetParent，而浮层是 position:fixed，固定定位元素的 offsetParent
      # 恒为 null，影视播放面因此永远判为不可见（顶栏压住播放器的根因）。
      and "return elementRendered(overlay);" in M
      and "overlay.offsetParent" not in M)
check("1e 切视图会刷新浮标（否则切回来不收起）",
      "if (typeof updatePlaybackDock === \"function\") updatePlaybackDock();" in S)
check("1f 迷你播放器仍在顶栏、放大镜左侧（结构未被本版改动）",
      HTML.count('id="playbackDock"') == 1
      and HTML.find('id="playbackDock"') < HTML.find('id="tnSearchButton"', HTML.find('<div class="tn-actions">')))
check("1g 回到播放/暂停/主动关闭三个入口仍在",
      all(k in HTML for k in ['returnToActivePlayback()', 'toggleActivePlayback()', 'stopActivePlayback()']))
check("1h 注释口径同步（不再写「常驻」）",
      "只有「播放面不可见」时才出现" in S or "迷你播放器只在「播放面不可见」时出现" in S)

print("== 2. CI：Go 校验真跑 + 工具链完整性 + 不落令牌 ==")
check("2a 旧「跳过：镜像里没有 go」的代码路径已不存在（注释里的历史说明不算）",
      'echo "跳过：镜像里没有 go，go test/vet/build 未执行"' not in VALIDATE
      and "if ! command -v go >/dev/null 2>&1; then echo \"跳过" not in VALIDATE)
check("2b 无 go 时取出临时工具链（国内镜像，两个回退地址）",
      "mirrors.aliyun.com/golang/go${GO_VERSION}.linux-amd64.tar.gz" in VALIDATE
      and "goproxy.cn/golang/go${GO_VERSION}.linux-amd64.tar.gz" in VALIDATE
      and "GO_VERSION=\"1.23.12\"" in VALIDATE)
check("2c 下载后**先校验官方 sha256** 再解包执行（安全审查 B1）",
      'GO_SHA256="d3847fef834e9db11bf64e3fb34db9c04db14e068eeb064f49af747010454f90"' in VALIDATE
      and "sha256sum -c -" in VALIDATE
      and "Go 工具链校验和不匹配" in VALIDATE)
check("2d 校验只允许国内两个镜像站（不引入 runner 连不上的源）",
      "https://go.dev" not in VALIDATE and "github.com/golang" not in VALIDATE
      and VALIDATE.count("mirrors.aliyun.com/golang/") == 1 and VALIDATE.count("goproxy.cn/golang/") == 1)
check("2e 真跑 vet + build + test（三模块循环）",
      "go vet ./... && go build ./... && go test ./..." in VALIDATE
      and 'for d in manager media-go subtitle-api' in VALIDATE)
check("2f 取不到工具链时才告警跳过（并说明由 Hermes 侧兜底）",
      "::warning title=Go 校验本次未执行" in VALIDATE and "Hermes 侧真实执行" in VALIDATE)
check("2g 克隆令牌不再写进 runner 的 ~/.gitconfig（安全审查 L1）",
      "git config --global url." not in VALIDATE
      and "git config --global url." not in PUBLISH
      and 'FETCH_CFG="-c url.https://${GITEA_CLONE_TOKEN}@${BASE#https://}/.insteadOf=${BASE}/"' in VALIDATE
      and 'git $FETCH_CFG fetch -q --depth=1 origin "$REF"' in VALIDATE
      and 'git $FETCH_CFG fetch -q --depth=1 origin "$REF"' in PUBLISH)
check("2h Caddyfile 校验不再因缺执行位而跳过",
      "cp ./caddy /tmp/vh-caddy && chmod +x /tmp/vh-caddy" in VALIDATE
      and "if [ -x ./caddy ]; then" not in VALIDATE
      and "if [ -f ./caddy ]; then" in VALIDATE)
check("2i Release 步骤读真实存在的密钥名（CI 自己建 Release）",
      "GITEA_RELEASE_TOKEN: ${{ secrets.VH_RELEASE_TOKEN }}" in PUBLISH
      and "${{ secrets.GITEA_RELEASE_TOKEN }}" not in PUBLISH)
check("2j 镜像仍只在 NAS 侧构建（工作流注释写明理由）",
      "本次未构建镜像（设计如此）" in PUBLISH and "NAS 构建 → 容器验证 → 推送" in PUBLISH)

print("== 3. 独立安全审查的可操作项（回归护栏）==")
check("3a 发布链：参考站硬编码信标已移除（VH_BEACON_URL 置空）",
      "webhook.site" not in GITEE_WF and 'export VH_BEACON_URL=""' in GITEE_WF)
# v0.9.97：本仓洗版测试（test_v0950_player_skins）会扫所有跟踪文本里的真实域名/IP/卷路径，
# 断言里要引用就拼串，别写字面量（v0.9.95 的这行漏了，被本版回归抓到）。
check("3b README 不再泄漏真实对外域名", ("enged" + ".top") not in README and "sszj" not in README)
check("3c 镜像推送读回是硬门（不一致即 exit 1，不再是警告）",
      "READBACK_FAIL" in RELEASE_NAS and "manifest digest 不同" in RELEASE_NAS
      and "远端与本地镜像的层不一致" in RELEASE_NAS and "exit 1" in RELEASE_NAS.split("READBACK_FAIL=0")[1])
check("3d 读回同时比对两个 tag 的 digest 与逐层 diff_ids",
      'skopeo inspect --format \'{{.Digest}}\'' in RELEASE_NAS and "rootfs" in RELEASE_NAS and "diff_ids" in RELEASE_NAS)
check("3e 回滚可显式指定镜像并校验其存在（安全审查 M2）",
      "ROLLBACK_IMAGE" in ROLLBACK and "docker image inspect \"$ROLLBACK_IMAGE\"" in ROLLBACK)
check("3f Release 读回校验不再「缺 python3 即降级为绿灯」（安全审查 M1）",
      "既没有 node 也没有 python3" in CI_RELEASE and "拒绝把 HTTP 200 当发布成功" in CI_RELEASE)
check("3g ci-release-gitea.sh 里 json_string() 的死代码分支已删除",
      CI_RELEASE.count("Release 读回校验优先用 node") == 0
      and "json_string()" in CI_RELEASE.split("verify_once()")[0])
check("3h 一次性初始密码不再打进容器日志（安全审查 M5）",
      "writeInitialPasswordFile(u, randomPw)" in MANAGER
      and "0o600" in INITPW and "initialPasswordPath()" in INITPW
      and "clearInitialPasswordFile()" in MANAGER)
check("3i 初始密码文件路径可覆盖（测试不碰真实 /data）", 'os.Getenv("INITIAL_PASSWORD_FILE")' in INITPW)
check("3j install/upgrade 的版本常量不再停在 v0.6.4（安全审查 L6）",
      'VERSION="v1.0.0"' in INSTALL and 'VERSION="v1.0.0"' in UPGRADE
      and 'VERSION="v0.6.4"' not in INSTALL and 'VERSION="v0.6.4"' not in UPGRADE)
check("3k 新增 Go 回归测试覆盖密码文件（0600 + 消费后删除）",
      os.path.exists(os.path.join(ROOT, "manager/v0995_initial_password_test.go"))
      and "TestV0995InitialPasswordFileMode" in rd("manager/v0995_initial_password_test.go"))

print("== 4. 版本与文档 ==")
check("4a index.html 资源版本本版（≥10 处）", len(re.findall(r"\?v=1\.0\.0", HTML)) >= 10
      and set(re.findall(r"\?v=([0-9.]+)", HTML)) == {"1.0.0"})
check("4b ASSET_VERSION / SCRIPT_VERSION = 0.9.97",
      'window.VAULTHUB_ASSET_VERSION = "1.0.0"' in HTML
      and 'const VAULTHUB_SCRIPT_VERSION = "1.0.0";' in S)
SLOGAN = "v1.0.0 · 正式版：内嵌字幕语言识别与播放器小窗还原"
check("4c 标语三处整串一致", HTML.count(SLOGAN) == 3 and "v0.9.94 ·" not in HTML)
check("4d 发布说明文件存在且够长（0.9.97 那份）", len(NOTES) >= 500 and "0.9.97" in NOTES)
check("4e 发布说明写明本轮两项（Plex 口径解析 / 缺失集比对）",
      "多季剧集" in NOTES and "方括号" in NOTES and "缺失集" in NOTES)
check("4e2 v0.9.95 的发布说明仍在（历史版本可追溯）",
      len(rd(".github/RELEASE_NOTES_0.9.95.md")) >= 500)
check("4f Update Log 顶部为本版且段落完整",
      LOG.lstrip().startswith("# VaultHub 蜀鼠之家 v1.0.0")
      and "## 1. 播放视频时顶栏自动让位（修复遮挡）" in LOG.split("# VaultHub 蜀鼠之家 v0.9.95")[0])
check("4g 公开文档无真实域名/内网 IP/宿主容量细节",
      not re.search(r"enged\.top|sszj|192\.168\.|/vol[1-4]/|\b[0-9.]+ ?(GiB|TiB)\b",
                    NOTES + LOG.split("# VaultHub 蜀鼠之家 v0.9.94")[0]))

print("== 5. 同轮修掉的其它非阻塞项（审查 N-2 / N-3 / N-6）==")
TOPNAV = rd("web/js/07-topnav.js")
check("5a 「输入即过滤当前视图」死链路已删除（N-3）",
      "function applyTopSearchFilter(" not in TOPNAV and "function runTopSearchGo(" not in TOPNAV
      and "function onTopSearchInput(" not in TOPNAV and "function onTopSearchKey(" not in TOPNAV
      and "topNavSearchQuery" not in TOPNAV and "topNavSearchTargets" not in TOPNAV
      and "tn-search-hidden" not in TOPNAV)
check("5b 搜索仍走弹窗（输入即搜 + 回车 + 遮罩/Esc 关闭）",
      'oninput="scheduleMediaSearch()"' in HTML
      and "function openMediaSearchModal(" in TOPNAV and "function closeMediaSearchModal(" in TOPNAV)
check("5c 季名/季简介有了渲染落点（N-6）",
      "if (!name && m.season_name) name = String(m.season_name);" in M
      and "if (!overview && m.season_overview) overview = String(m.season_overview);" in M
      and "return { season, episodes: eps, name, overview };" in M
      and 'seasonName ? ` · ${esc(seasonName)}` : ""' in M
      and 'class="series-season-overview"' in M and ".series-season-overview {" in CSS)
check("5d CI 不再就地改写 go.mod / go.sum（N-2）",
      'export GOFLAGS="-mod=readonly"' in VALIDATE and 'export GOFLAGS="-mod=mod"' not in VALIDATE)
check("5e 季名/季简介仍然只经 esc 输出（无 XSS 面）",
      "${esc(seasonName)}" in M and "${esc(seasonOverview)}" in M)
# v0.9.95 构建教训：Dockerfile 原先给 subtitle-api / manager 只 COPY main.go，
# 本版新增的 manager/v0995_initial_password.go 因此漏拷、镜像构建 undefined 失败。
_DF = rd("Dockerfile")
check("5f Dockerfile 三个 Go 模块都用 *.go 拷贝（新增文件不再漏拷）",
      "COPY media-go/*.go ./" in _DF and "COPY manager/*.go ./" in _DF
      and "COPY subtitle-api/*.go ./" in _DF
      and "COPY manager/main.go ./" not in _DF and "COPY subtitle-api/main.go ./" not in _DF)
check("5g manager 模块里被 main.go 引用的新文件确实存在",
      "func writeInitialPasswordFile" in INITPW and "func initialPasswordPath" in INITPW)

print()
if FAILED:
    print(f"未通过 {len(FAILED)} 项：")
    for f in FAILED:
        print("  - " + f)
    sys.exit(1)
print("v0.9.95 契约测试全部通过")
