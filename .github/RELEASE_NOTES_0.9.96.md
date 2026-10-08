# VaultHub v0.9.96

## 需求1：播放视频时顶栏不再遮挡播放器

**现象**：影视播放器打开后，顶栏压在播放器上沿。

**根因（真实浏览器实测）**：判断「播放面是否可见」的 `playbackSurfaceVisible()` 用的是
`overlay.offsetParent !== null`，而播放器浮层 `.media-reader-overlay` 是 `position: fixed` ——
按规范，**固定定位元素的 `offsetParent` 恒为 `null`**（实测：浮层渲染尺寸 1270×525、明明可见，
`offsetParent === null`）。于是影视播放面永远被判成「不可见」：

- `body.player-immersive` 永不生效 → 顶栏不回缩，压在播放器上（本次反馈的问题）；
- 副作用：播放器打开时顶栏迷你播放器浮标反而会显示（判定说播放面不可见）。

**修复**：

- 新增 `elementRendered()`：改判「有没有生成渲染盒子」——祖先 `display:none` 时
  `getClientRects()` 为空，固定定位且可见时为 1+；再按计算样式兜 `display/visibility`；
- 新增 `expandedVideoPlayerVisible()`：影视播放器浮层已打开且未缩成控制器小窗即为真，
  **不看此刻是否正在播** —— 打开播放器就是要看片，顶栏应当让位；
- `syncPlayerImmersive()` 改为两者取或；
- `closeVideoPlayer()` 里显式恢复顶栏（播放器的 ✕ 是最常走的关闭路径）。

**行为**：播放器打开（含暂停）→ 顶栏滑出、窗口空间真正释放；播放器关闭 → 顶栏自动回来；
播放器缩成控制器小窗 → 顶栏回来（沿用 v0.9.93 口径）；音乐播放不受影响（音乐页顶栏照常）。

## 需求2：顶栏搜索入口归一 + 放大镜图标修复

- 移除顶栏左侧导航里的「🔍 媒体搜索」按钮（与右侧放大镜重复）；
- 修复右侧 `#tnSearchButton` 的放大镜图标：原 SVG 既没有 `fill/stroke` 属性，样式里也没有兜底，
  浏览器按 SVG 默认 `fill:black` 渲染 —— 只剩一个实心黑圆点（手柄是零面积线段，画不出来）。
  现在显式声明「无填充 + `currentColor` 描边 + 圆头」，并在 CSS 里给同款兜底；
- 旧书签仍会落到 `#view-search`，那里会自动弹出搜索弹窗，入口不丢。

## 校验

- 新增契约测试 `tests/test_v0996_contract.py`、行为测试 `tests/v0996_behavior.js`（Node VM 真实执行源文件）；
- 历史断言按新口径重定向（v0.9.93/v0.9.95 的「左侧搜索按钮存在」「offsetParent 判可见」）；
- 真实容器 + 真实浏览器验证；全量回归见发布记录。

## 未修项（如实列出）

容器仍 root 且挂 `docker.sock`、生产 compose 跟随 `latest`、基础镜像未按 digest 固定、
仓库仍跟踪历史 C 二进制 / 未按需清理的工作流、`GOSUMDB=off`、
`scripts/ci-release-gitea.sh` 仍把令牌放在 curl argv（发布关键路径，单独一轮处理）。
