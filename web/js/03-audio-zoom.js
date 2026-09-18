/* v0.9.66：播放器海报放大（toggleAudioCoverZoom）—— 点击左侧封面自适应居中的放大按钮，
 * 海报放大到占据整个音乐界面；播放器位置不变，遮罩独立叠加在音乐界面上。
 *
 * 返回路径（v0.9.65 起移除右上角返回按钮）：点击遮罩任意位置、按 Esc，
 * 或聚焦遮罩内视觉隐藏的关闭位后回车。注意：放大后遮罩 z-index(660) 高于播放器(250)，
 * 放大按钮此时被遮住不可点，因此返回只靠上述三条路径。
 *
 * v0.9.71：放大视图右侧新增两个药丸（海报 / 歌词）：
 *   - 点「歌词」→ 歌词层在页面中部展示，主海报按宽度 5% 虚化
 *     （CSS 的 blur() 不接受百分比，样式表里折算为 min(520px,80vw) × 5% ≈ 26px）；
 *   - 歌词层可拖动浏览：拖动只滚列表，不误触跳转；松手后 6 秒内暂停自动跟随，
 *     随后恢复「高亮行居中」；
 *   - 点击任意行 = 跳到该句播放（点击与拖动以 6px 位移区分）；
 *   - 高亮与居中滚动复用 02-media.js 的 lyricHosts/scrollActiveLyricIntoView，
 *     不再另写一套（两套实现必然随时间漂移）。
 */
let audioCoverZoomed = false;
let audioFullscreenPage = "poster";      // poster | lyrics
let audioFsLyricsFollowPausedUntil = 0;  // 拖动歌词后的「暂停自动跟随」截止时间戳
let audioFsLyricsDragging = false;
const AUDIO_FS_FOLLOW_PAUSE_MS = 6000;   // 松手后 6 秒恢复自动跟随
const AUDIO_FS_DRAG_SLOP = 6;            // 位移小于该值视为点击（跳到该句），不当作拖动

/* 供 02-media.js 的 scrollActiveLyricIntoView 调用：放大视图歌词层当前是否暂停跟随。 */
function lyricFollowPaused(host) {
  if (!host || host.id !== "audioFullscreenLyricsInner") return false;
  return audioFsLyricsDragging || Date.now() < audioFsLyricsFollowPausedUntil;
}

function updateAudioFsLyricsHint() {
  const hint = document.getElementById("audioFullscreenLyricsHint");
  const outer = document.getElementById("audioFullscreenLyrics");
  const paused = lyricFollowPaused({ id: "audioFullscreenLyricsInner" });
  if (outer) outer.dataset.follow = paused ? "paused" : "following";
  if (!hint) return;
  hint.classList.toggle("follow-paused", paused);
  hint.textContent = paused ? "已暂停跟随 · 点击任意行跳到该句播放" : "拖动可浏览歌词 · 点击任意行跳到该句播放";
}

/* 渲染放大视图歌词层：内容与底部展开面板同源（audioMetadataFor(activeAudio.path)）。 */
function refreshAudioFullscreenLyrics() {
  const el = document.getElementById("audioFullscreenLyricsInner");
  if (!el) return;
  const meta = activeAudio ? audioMetadataFor(activeAudio.path) : { lyrics: "" };
  renderLyricLinesInto(el, meta, "暂无歌词：可在曲目行的「✎ 编辑歌曲信息」粘贴 LRC（每行形如 [00:12.50] 歌词文本），播放时即同步高亮。");
  updateAudioFsLyricsHint();
}

/* 药丸切换：poster（默认，与旧行为一致）↔ lyrics（中部歌词 + 主海报 5% 虚化）。 */
function setAudioFullscreenPage(page) {
  if (page !== "poster" && page !== "lyrics") page = "poster";
  audioFullscreenPage = page;
  const overlay = document.getElementById("audioFullscreenOverlay");
  if (overlay) overlay.dataset.page = page;
  const posterPill = document.getElementById("audioFsPosterPill"), lyricsPill = document.getElementById("audioFsLyricsPill");
  if (posterPill) {
    posterPill.classList.toggle("active", page === "poster");
    posterPill.setAttribute("aria-selected", String(page === "poster"));
  }
  if (lyricsPill) {
    lyricsPill.classList.toggle("active", page === "lyrics");
    lyricsPill.setAttribute("aria-selected", String(page === "lyrics"));
  }
  if (page === "lyrics") {
    refreshAudioFullscreenLyrics();
    scrollActiveLyricIntoView(document.getElementById("audioFullscreenLyricsInner"));
  }
  updateAudioFsLyricsHint();
}

/* ---- 歌词层拖动浏览（指针事件）----
   拖动只改 scrollTop；位移小于阈值视为点击 → 由 click 处理器跳到该句播放。 */
function audioFsLyricsDragStart(event) {
  const outer = document.getElementById("audioFullscreenLyrics");
  if (!outer || audioFullscreenPage !== "lyrics") return;
  if (event.button !== undefined && event.button !== 0) return;
  audioFsLyricsDragging = true;
  outer.dataset.dragMoved = "0";
  outer.dataset.dragStartY = String(event.clientY);
  outer.dataset.dragStartTop = String(outer.scrollTop);
  outer.classList.add("dragging");
  try { outer.setPointerCapture(event.pointerId); } catch (e) { /* 无指针捕获能力时仍可拖动 */ }
  updateAudioFsLyricsHint();
}
function audioFsLyricsDragMove(event) {
  const outer = document.getElementById("audioFullscreenLyrics");
  if (!outer || !audioFsLyricsDragging) return;
  const startY = Number(outer.dataset.dragStartY || 0), startTop = Number(outer.dataset.dragStartTop || 0);
  const delta = event.clientY - startY;
  outer.scrollTop = Math.max(0, startTop - delta);
  if (Math.abs(delta) > Number(outer.dataset.dragMoved || 0)) outer.dataset.dragMoved = String(Math.abs(delta));
}
function audioFsLyricsDragEnd(event) {
  const outer = document.getElementById("audioFullscreenLyrics");
  if (!outer || !audioFsLyricsDragging) return;
  audioFsLyricsDragging = false;
  outer.classList.remove("dragging");
  if (event && event.pointerId !== undefined && outer.releasePointerCapture) {
    try { outer.releasePointerCapture(event.pointerId); } catch (e) { /* 已释放 */ }
  }
  if (Number(outer.dataset.dragMoved || 0) > AUDIO_FS_DRAG_SLOP) {
    audioFsLyricsFollowPausedUntil = Date.now() + AUDIO_FS_FOLLOW_PAUSE_MS;
  }
  updateAudioFsLyricsHint();
}
/* 点击歌词行：只有「没被拖动」的点击才跳转播放，并立即恢复跟随。 */
function audioFsLyricsClick(event) {
  const outer = document.getElementById("audioFullscreenLyrics");
  if (!outer) return;
  event.stopPropagation();
  if (Number(outer.dataset.dragMoved || 0) > AUDIO_FS_DRAG_SLOP) return; // 拖动结束后的 click 不跳转
  const line = event.target.closest("[data-time]");
  const player = document.getElementById("audioPlayerElement");
  if (!line || !player || !Number.isFinite(Number(line.dataset.time))) return;
  player.currentTime = Number(line.dataset.time);
  audioFsLyricsFollowPausedUntil = 0;
  outer.dataset.dragMoved = "0";
  updateLyricHighlight();
  scrollActiveLyricIntoView(document.getElementById("audioFullscreenLyricsInner"));
  updateAudioFsLyricsHint();
}

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
    /* v0.9.71：每次打开回到海报页（保持旧行为），歌词层按当前曲目即时渲染。 */
    setAudioFullscreenPage("poster");
    refreshAudioFullscreenLyrics();
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
/* v0.9.71：歌词层拖动浏览（指针捕获；松手后短暂暂停自动跟随）。 */
const audioFsLyricsLayer = document.getElementById("audioFullscreenLyrics");
if (audioFsLyricsLayer) {
  audioFsLyricsLayer.addEventListener("pointerdown", audioFsLyricsDragStart);
  audioFsLyricsLayer.addEventListener("pointermove", audioFsLyricsDragMove);
  audioFsLyricsLayer.addEventListener("pointerup", audioFsLyricsDragEnd);
  audioFsLyricsLayer.addEventListener("pointercancel", audioFsLyricsDragEnd);
  audioFsLyricsLayer.addEventListener("click", audioFsLyricsClick);
  /* 滚轮/触摸滚动同样算人工浏览：也暂停自动跟随一小段时间。 */
  audioFsLyricsLayer.addEventListener("wheel", () => {
    audioFsLyricsFollowPausedUntil = Date.now() + AUDIO_FS_FOLLOW_PAUSE_MS;
    updateAudioFsLyricsHint();
  }, { passive: true });
}
/* 暂停状态会随时间自然过期：借播放进度事件刷新提示与跟随状态。 */
document.getElementById("audioPlayerElement")?.addEventListener("timeupdate", () => {
  if (audioCoverZoomed && audioFullscreenPage === "lyrics") updateAudioFsLyricsHint();
});
