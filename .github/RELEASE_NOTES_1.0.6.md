# VaultHub v1.0.6 · 三套规格主题 · 壁纸随内容 · 返回键归位

主题从「调色板 × 明暗 × 强调色」重构为「界面规格 × 明暗」两层。调色板、强调色、自定义背景
三档设置整体移除，每套界面规格自带完整主题定义（配色 / 壁纸 / 播放器皮肤 / 图标包），
三份《界面规格之 … 影音播放器界面元素详解》的要素分别落进对应规格。

---

## 1. 移除调色板、强调色与自定义背景（需求 1）

**为什么删**：这三档与「界面规格」语义重复 —— 规格本来就该决定配色与观感。同时选会出现
「规格是 Plex，配色却是青瓷」的拼接，用户看到的是两套设计语言打架。

**改了什么**：
- 外观面板只剩五项：界面规格（Apple / Emby / Plex）、操作模式（自动 / Phone / TV / PC）、
  明暗（暗 / 亮 / 跟随系统）、规格壁纸、减弱动效。
- `<html>` 不再写 `data-palette` / `data-accent`；`applyTheme()` 里显式 `removeAttribute`，
  旧 CSS 与手工改过的 DOM 都不会让旧主题复活。
- 旧 localStorage 里的 `palette` / `accent` / `customBg` / `theme:"custom"` 在 `loadSettings()`
  之前的清理块里被删掉；旧自定义背景的 base64（动辄几 MB，会把 `dwu_settings` 挤成写不进去）
  连同 `dwu_bgimg` 键一起清除。

**验证**：面板 DOM 里 `themePaletteGrid` / `themeAccentSwatches` / `themeCustomBgToggle` /
`bgFile` 全部为 `false`；`<html>` 无 `data-palette` / `data-accent`；CSS 里 0 处
`data-palette` / `data-accent` 选择器。

---

## 2. 每套界面规格带一整套主题定义（需求 2 / 6）

`SPEC_THEMES` 中每套规格给出亮暗两套**完整令牌**（23 个）：

| 令牌组 | 内容 |
| --- | --- |
| 颜色 | `bg / bg2 / card / card2 / border / border2 / track / text / text2 / text3` |
| 主色 | `accent / accentInk / accentDim / accentRing / accentGlow` |
| 形状 | `radius / radiusSm / radiusLg / shadow / shadowLg / fontHead` |
| 动效 | `dur / ease` |

| 规格 | 主色 | 圆角 | 动效 | 壁纸 | 播放器皮肤 |
| --- | --- | --- | --- | --- | --- |
| **Apple** | `#0A84FF` / 亮色 `#007AFF` | 16 / 10 / 22（同心） | 240ms `cubic-bezier(.32,.72,0,1)` | Aerial 航拍 | `glass` 层叠玻璃迷你条 |
| **Emby** | `#52B54B` 品牌绿（锁定） | 8 / 4 / 12（Material） | 150ms `cubic-bezier(.4,0,.2,1)` | 海报拼贴 | `osd` 中央大播放键 |
| **Plex** | `#E5A00D` 琥珀金 | 6 / 3 / 10（扁平） | 140ms `cubic-bezier(.2,0,0,1)` | UltraBlur 取色 | `plex` 琥珀进度 + 方头图标 |

切规格 = 换整套主题，连动效手感一起换。实测计算值（`getComputedStyle`）：

```
apple  --bg #0A0A0C  --accent #0A84FF  --radius 16px  --dur 240ms  --glass-blur 26px
emby   --bg #0F1418  --accent #52B54B  --radius  8px  --dur 150ms  --glass-blur  0px
plex   --bg #0B0B0C  --accent #E5A00D  --radius  6px  --dur 140ms  --glass-blur  0px
```

---

## 3. 壁纸是「算出来的」，不是一张图（需求 2 / 6）

三种做法共用一层 `.vh-wall`（`z-index:-1`、`pointer-events:none`），`data-wallpaper` 决定画哪种；
关掉壁纸时只留 `--bg` 底色，正文对比度不变。

### Apple · Aerial 航拍

多层径向渐变（天空蓝 / 海面青 / 城市暗部）+ 48s 缓慢漂移与 32s 光晕呼吸，暗亮各一套配色。
对应文档：tvOS 航拍屏保「4K HDR、缓慢镜头漂移、纪录片开场感」。

### Emby · 海报拼贴

取当前列表的 12 张海报铺成 6×2，`blur(30px) saturate(.85) brightness(.72)` 后叠暗化渐变 ——
文档里「启用背景图后媒体库背景随机取影片海报填充」的客户端实现。列表为空时自动隐藏，
不会留一块空色。

### Plex · UltraBlur 取色

把当前焦点/点击的海报画到 8×8 canvas，取四角 2×2 区域平均色，写入
`--ub-tl / --ub-tr / --ub-br / --ub-bl`，再由 CSS 四角径向渐变糊成整屏氛围底图（`blur(46px)`，
900ms 过渡）。同源图片（`/api/media/cover`）可直接读像素；跨源海报读不到时保留上一组色，不报错。

**实测**：构造四角为红/绿/蓝/黄的测试图，取样得到 `--ub-tl: rgb(255,0,0)`，象限映射正确；
拼贴层在同源图片存在时取到 1 张（`#vhWallCollage img` = 1）。

---

## 4. Apple 规格：Liquid Glass 材质（需求 3）

半透明材质只加在**压在内容之上**的图层 —— 顶栏、头像菜单、弹窗、播放器：
`backdrop-filter: blur(26px) saturate(1.7)`；正文卡片保持不透明（全屏磨砂会把文字对比度拖垮，
那是照抄形状而不是照抄原则）。图标全部细描边（1.6–1.8px），圆角同心：卡片外框 22px、
海报内层 16px。播放器是浮起的玻璃条（`border-radius: 26px`、`bottom: 22px`），展开时是同一块面
向上长，不是覆盖整页 —— 对应文档里「点开时以层叠方式展开」。

实测：`.topbar` 的 `backdrop-filter` 计算值为 `blur(26px) saturate(1.7)`，`--glass-blur: 26px`。

---

## 5. Emby 规格：品牌绿 + 图片槽位 + OSD（需求 4）

- **品牌绿锁定**：`#52B54B` 写在令牌里且不随主题改 —— 文档里 Emby 官方明确 Logo 色彩属于商标，
  「你换什么都行，但图标那抹绿永远在」。
- **Material 结构**：实色表面、小圆角（8/4/12）、150ms 标准曲线、按压时一圈水波（`vhRipple`）。
- **海报角标**：卡片海报左下角一条主色短条（角标体系的简化落点，不伪造画质信息）。
- **OSD 中央大播放键**：92px 圆形玻璃按钮，只在 Emby 规格显示；播放中淡出、暂停时浮现，
  与底栏播放键**同源同步**（同一个 `videoPlayPauseIcon(video.paused)`），不会出现两处图标相反。

---

## 6. Plex 规格：琥珀金 + UltraBlur + 方头图标（需求 5）

- 琥珀金 `#E5A00D`（亮色档用 `#B87A00` 保证对比度），扁平 6px 圆角、去阴影，悬停只提亮描边。
- 进度条琥珀渐变 `#C98A0B → #E5A00D → #F6C453`，进度旋钮同色。
- 图标方头（`stroke-linecap: square`）、粗描边（2.1–2.3px），与 chevron 的语言一致。
- 壁纸取色见第 3 节 —— 这是 Plex 最标志性的一层（「壁纸是从海报里长出来的颜色」）。

---

## 7. 三份详解文档进仓库、进面板、进镜像（需求 3 / 4 / 5 / 6）

| 文档 | 路径 | 面板里的元素清单 |
| --- | --- | --- |
| Apple 影音播放器界面元素详解 | `/docs/specs/apple.md` | Liquid Glass 材质 / Aerial 壁纸 / SF Symbols 图标 / 层叠迷你播放器 |
| Emby 影音播放器界面元素详解 | `/docs/specs/emby.md` | 品牌绿锁定 / 海报拼贴 / 图片槽位 / OSD 中央键 + 海报角标 |
| Plex 影音播放器界面元素特色详解 | `/docs/specs/plex.md` | chevron + 琥珀金 / UltraBlur 取色 / 跳过片头片尾 / 暗色骨架 |

外观面板里每套规格卡下方直接列出这 4 条；点「查看这套规格的元素清单」打开弹窗，
可一键应用该规格，也可点文档链接看原文（`Dockerfile` 新增 `COPY docs/specs /srv/docs/specs`，
实测 `GET /docs/specs/apple.md` → 200）。

---

## 8. ESC 无法退出媒体详情（需求 7）

**根因**：`goBack()` 只认三类目标 —— 顶栏浮层、`.modal-mask.show` 弹窗、设置页（外加
`player-immersive`）。媒体详情页是 `#local-media-viewer-movie` 里的 `.media-reader-overlay`，
不属于任何一类，于是 ESC 什么都不做，只能点左上角「返回媒体库」。

**修法**：在 `goBack()` 里按层级补上第四类，顺序为
**播放器 → 分集详情 → 详情/阅读器 → 设置页**：

```
.media-reader-overlay 存在
  ├─ 内含 .media-video-body  → closeVideoPlayer()（先退播放器，再按一次才退详情）
  ├─ seriesEpisodeReturn 有值 → closeEpisodeDetail()（回剧集详情，不是直接回库）
  └─ 其余                     → closeLocalViewer(group)（清 DOM、断流、还顶栏）
```

**实测**：媒体库 → 点卡片进详情（`overlay: true`）→ 按一次 ESC →
`overlay: false`、`#local-media-viewer-movie` 内容长度 0、仍停留在媒体库、60 张卡片不变。

---

---

## 9. 字幕接口鉴权补齐（顺带修的既有缺陷）

发布前逐项实测时发现：`/api/media/subtitles/search` 与 `/api/media/subtitles/download`
在 Caddy 里是**直接**转发给独立进程 `subtitle-api`（9120）的，而鉴权（`readAuth`）在
媒体 API（9100）里 —— 也就是说这两个入口绕过了登录校验。实测未登录：

```
GET /api/media/subtitles/search?id=...&path=...   → 200（返回同目录字幕文件名）
GET /api/media/subtitles/download?url=https://... → 502（说明已开始代理外部内容）
GET /api/media/subtitles/extract?...              → 401（这个走媒体 API，正常）
```

**修法**：`subtitle-api` 增加 `sessionOK(r)` —— 用调用方的 Cookie 向媒体 API 探一次
`/api/media/files?id=__vh_auth_probe__`，**只有 401 判为未登录**（登录态下该请求返回
400 invalid id，说明会话有效）；网络失败放行，避免媒体 API 短暂不可用时把字幕服务一起拖死。
`search` 与 `download` 都先过这道门。

**实测**：未登录 search/download 均 **401**，登录后 search **200**、extract 401（未登录）不变。


## 回归

| 项 | 结果 |
| --- | --- |
| Python 契约 | **124/124 PASS**（新增 `tests/test_v1006_contract.py`；`test_v0973_theme_engine_behavior.py` 重写为 42 项规格主题行为断言） |
| `node --check` | 12 个 JS 全部通过 |
| `go vet` | media-go / manager / subtitle-api 三模块 0 问题 |
| 容器实测 | 三规格切换、三种壁纸、UltraBlur 取色、面板、规格弹窗、壁纸开关、ESC 返回、字幕鉴权 401/200 全部通过 |
| 生产读回 | 见发布记录（`/api/health` 200、挂载数不变、版本标语 v1.0.6） |

**已知边界**：
- 测试媒体没有刮削海报，Emby 拼贴与 Plex 取色在空列表下按设计退回底色/上一组色；
  逻辑用同源测试图单独验证（见第 3 节）。
- 三份文档原文含外链配图，内网/离线环境打开时图片不显示，文字部分完整。
