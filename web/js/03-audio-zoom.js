/* v0.9.66：播放器海报放大（toggleAudioCoverZoom）—— 点击左侧封面自适应居中的放大按钮，
 * 海报放大到占据整个音乐界面；播放器位置不变，遮罩独立叠加在音乐界面上。
 *
 * 返回路径（v0.9.65 起移除右上角返回按钮）：点击遮罩任意位置、按 Esc，
 * 或聚焦遮罩内视觉隐藏的关闭位后回车。注意：放大后遮罩 z-index(660) 高于播放器(250)，
 * 放大按钮此时被遮住不可点，因此返回只靠上述三条路径。 */
let audioCoverZoomed = false;
function closeAudioCoverZoom() {
  if (!audioCoverZoomed) return;
  audioCoverZoomed = false;
  document.getElementById("audioFullscreenOverlay")?.classList.remove("show");
  const zoomBtn = document.querySelector(".audio-cover-zoom-btn");
  /* 关闭后把焦点归还放大按钮；音频底栏未显示（按钮不可见）时才跳过。 */
  if (zoomBtn && zoomBtn.offsetParent) zoomBtn.focus({ preventScroll: true });
  if (zoomBtn) {
    zoomBtn.title = "放大专辑海报";
    zoomBtn.setAttribute("aria-label", "放大海报");
    zoomBtn.setAttribute("aria-expanded", "false");
  }
}
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
  if (zoomBtn) {
    zoomBtn.title = audioCoverZoomed ? "返回音乐界面" : "放大专辑海报";
    zoomBtn.setAttribute("aria-label", audioCoverZoomed ? "返回音乐界面" : "放大海报");
    zoomBtn.setAttribute("aria-expanded", String(audioCoverZoomed));
  }
  /* 放大后遮罩覆盖播放器，放大按钮不可点：把焦点移到遮罩内的隐藏关闭位，
     键盘/读屏用户可立即 Esc 或回车返回。 */
  if (audioCoverZoomed) document.querySelector(".audio-fullscreen-close-sr")?.focus({ preventScroll: true });
}
/* v0.9.65：点遮罩任意位置返回（旧版是右上角返回按钮）。 */
document.getElementById("audioFullscreenOverlay")?.addEventListener("click", () => closeAudioCoverZoom());
/* v0.9.65：Esc 返回音乐界面。 */
document.addEventListener("keydown", event => { if (event.key === "Escape" && audioCoverZoomed) closeAudioCoverZoom(); });
