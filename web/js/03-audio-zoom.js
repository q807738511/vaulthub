/* v0.9.59：全屏海报放大按钮（toggleAudioCoverZoom）—— 在音乐界面显示专辑海报全屏遮罩。
 * 点击封面左上角放大按钮 / 点击全屏遮罩右上角返回按钮均可切换。
 * 播放器位置不变，遮罩独立叠加在整个音乐界面上。 */
let audioCoverZoomed = false;
function toggleAudioCoverZoom() {
  audioCoverZoomed = !audioCoverZoomed;
  const overlay = document.getElementById("audioFullscreenOverlay");
  const zoomBtn = document.querySelector(".audio-cover-zoom-btn");
  if (!overlay) return;
  overlay.classList.toggle("show", audioCoverZoomed);
  if (audioCoverZoomed && activeAudio) {
    const meta = audioMetadataFor(activeAudio.path);
    const img = document.getElementById("audioFullscreenImg");
    const fallback = document.getElementById("audioFullscreenFallback");
    if (meta.cover) {
      img.src = meta.cover;
      img.style.display = "";
      fallback.style.display = "none";
    } else {
      img.style.display = "none";
      fallback.textContent = meta.title || "未知歌曲";
      fallback.style.display = "flex";
      const poster = fallback.closest(".audio-fullscreen-poster");
      if (poster) poster.style.background = coverGradient(meta.title);
    }
  }
  if (zoomBtn) zoomBtn.title = audioCoverZoomed ? "返回" : "放大专辑海报";
}
