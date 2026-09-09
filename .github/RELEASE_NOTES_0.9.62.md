# VaultHub v0.9.62 · Immersive Playback

## ✨ 新功能

### 播放背景虚化（Immersive Playback Background）
- **影视播放**：播放视频时自动读取海报图（优先级：Fanart > Backdrop > Poster），渲染为 `.main` 主区域的虚化背景，增强沉浸感
- **音乐播放**：播放音乐时自动读取专辑封面图，渲染为主区域虚化背景
- **智能降级**：无法读取海报或封面时不渲染背景层，避免空白闪烁
- **隔离渲染**：虚化背景仅覆盖 `.main` 内容区，不影响侧边栏和顶栏的正常显示
- **主题适配**：暗色/亮色/自定义主题下自动调整遮罩层透明度

## 🐛 修复

### 影视海报黑边
- `.media-poster-art img` 增加 `position:absolute; inset:0`，海报图片覆盖整个容器，修复因 `padding:15px` 露出深色渐变背景形成的黑边

### 音乐播放器放大按钮居中
- `.audio-cover-zoom-btn` 增加 `line-height:0; font-size:0`，消除 inline-flex 容器内 SVG 图标的基线偏移，确保按钮图标精确居中

## 🔧 技术细节

- CSS 新增 `.playback-bg` 类（`position:absolute; z-index:0; filter:blur(40px)`）
- JS 新增 `setPlaybackBg(imageUrl)` / `clearPlaybackBg()` 全局函数
- 视频播放器 `initMovieCompatPlayer` 在加载元数据时设置背景
- 音频播放器 `playAudioFile` / `syncActiveAudioCover` 同步更新背景
- `closeLocalViewer` / `audioStop` 负责清除背景
