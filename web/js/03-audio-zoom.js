/* v0.9.65：播放器海报放大（toggleAudioCoverZoom）—— 点击左侧封面自适应居中的放大按钮，
 * 海报放大到占据整个音乐界面；播放器位置不变，遮罩独立叠加在音乐界面上。
 * v0.9.65 变更：移除右上角返回按钮 —— 点击遮罩任意位置或按 Esc 返回，
 * 放大按钮本身仍是开关。 */
let audioCoverZoomed = false;
function closeAudioCoverZoom() {
  if (!audioCoverZoomed) return;
  audioCoverZoomed = false;
  document.getElementById("audioFullscreenOverlay")?.classList.remove("show");
  const zoomBtn = document.querySelector(".audio-cover-zoom-btn");
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
}
/* v0.9.65：点遮罩任意位置返回（旧版是右上角返回按钮）。 */
document.getElementById("audioFullscreenOverlay")?.addEventListener("click", () => closeAudioCoverZoom());
/* v0.9.65：Esc 返回音乐界面。 */
document.addEventListener("keydown", event => { if (event.key === "Escape" && audioCoverZoomed) closeAudioCoverZoom(); });
