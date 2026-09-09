# VaultHub v0.9.63 · Immersive Playback R2

## 🔧 优化

### 播放背景虚化效果调整
- 降低遮罩浓度：`brightness` 从 0.45 提升至 0.68，`opacity` 设为 0.55
- 朦胧透亮，海报画面清晰可辨，不再过暗

### 音乐海报黑边虚化填充
- 展开播放器海报容器（`.audio-poster-frame`）和全屏海报（`.audio-fullscreen-poster`）
- 通过 CSS 变量 `--poster-blur-bg` 驱动 `::before` 伪元素，用虚化封面图填充黑边区域
- 海报图片保持 `z-index:1` 在虚化层之上

### 放大按钮居中增强
- 增加 `margin:0; box-sizing:border-box; flex-shrink:0` 消除浏览器默认间距
- SVG 增加 `display:block; margin:auto` 确保精确居中
