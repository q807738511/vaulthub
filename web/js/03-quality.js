/* v0.9.84：画面清晰度与色彩档位（重做原「省流」策略）
 *
 * 用户诉求（原文）：
 *   「调整省流策略（音乐外观上的省流将海报的颜色变更了还无法调整回来）——
 *     省流改成调整画面清晰度，画面色彩最大限度展示为最低是无色彩状态」
 *
 * 由此确定的三条设计约束：
 *   1) 省流 = 一档**画面清晰度**，档位越高画面越清晰、色彩越完整；
 *      最低档是「无色彩」（灰度）+ 最低清晰度，而不是把颜色"改坏"。
 *   2) 颜色由档位显式决定，任何档位都能随时切回 —— 切回高画质必须**立刻**恢复满色
 *      （旧实现里省流改过的东西没有回退路径，用户只能看到"改不回来"）。
 *   3) 一切可逆：只改 CSS 变量 + 图片请求宽度，不写任何"一次性"状态；
 *      换档后当前页面立即按新档重渲染。
 *
 * 档位与实现手段（全部走既有服务端能力，不新增后端参数）：
 *   原画  页面原图（w 不传）· 封面 320px · 视频 original · 色彩 100%
 *   高清  页面转码 1600px   · 封面 320px · 视频 auto     · 色彩 100%
 *   流畅  页面转码 1200px   · 封面 200px · 视频 720p     · 色彩 70%
 *   极省  页面转码  900px   · 封面 140px · 视频 480p     · 无色彩（灰度）
 *
 * 「自动」档沿用 v0.9.71 的弱网判定（浏览器 saveData / 2g-3g / 测速判定弱网），
 * 判定省流生效时落到「高清」档 —— 与旧版省流行为逐字节一致（转码宽度仍是 1600），
 * 因此 v0.9.67 / v0.9.71 的契约测试无需修改。
 */
const QUALITY_KEY = "vaulthub_quality_level_v1";
/* 顺序即按钮循环顺序：自动 → 原画 → 高清 → 流畅 → 极省 → 自动 */
const QUALITY_ORDER = ["auto", "original", "high", "smooth", "minimal"];
const QUALITY_PROFILE = {
  original: { id: "original", label: "原画", sub: "原图直出 · 完整色彩", pageW: 0, coverW: 320, video: "auto", kbps: 0, color: 1, gray: false },
  high:     { id: "high",     label: "高清", sub: "转码 1600px · 完整色彩", pageW: 1600, coverW: 320, video: "auto", kbps: 0, color: 1, gray: false },
  smooth:   { id: "smooth",   label: "流畅", sub: "转码 1200px · 色彩 70%", pageW: 1200, coverW: 200, video: "720p", kbps: 128, color: 0.7, gray: false },
  minimal:  { id: "minimal",  label: "极省", sub: "转码 900px · 无色彩（灰度）", pageW: 900, coverW: 140, video: "480p", kbps: 96, color: 0, gray: true },
};

function qualityChoice() {
  try {
    const v = String(localStorage.getItem(QUALITY_KEY) || "auto");
    return QUALITY_ORDER.includes(v) ? v : "auto";
  } catch (e) { return "auto"; }
}
/* 「自动」档的省流判定：浏览器省流提示 / 2g-3g / 测速判定弱网（与 v0.9.71 同源）。 */
function qualityLegacySaveData() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (c && c.saveData) return true;
  if (/^(slow-)?2g$|^3g$/.test(String((c && c.effectiveType) || ""))) return true;
  return typeof weakNetworkActive === "function" && weakNetworkActive();
}
/* 当前实际生效的档位 id（自动档在这里落地为具体档）。 */
function qualityEffectiveId() {
  const choice = qualityChoice();
  if (choice !== "auto") return choice;
  return qualityLegacySaveData() ? "high" : "original";
}
function qualityProfile() { return QUALITY_PROFILE[qualityEffectiveId()] || QUALITY_PROFILE.original; }
/* 阅读页转码宽度：显式档位优先；「自动」返回 null，交回旧省流判定（保持契约）。 */
function qualityPageWidth() {
  if (qualityChoice() === "auto") return null;
  return qualityProfile().pageW;
}
/* 封面/海报缩略宽度：档位越低取图越小（顺带省流量）。 */
function qualityCoverWidth(fallback) {
  const w = Number(qualityProfile().coverW) || 0;
  return w > 0 ? w : Number(fallback) || 320;
}
/* 色彩倍率：1 = 完整色彩，0 = 无色彩（灰度）。 */
function qualityColorFactor() { return Number(qualityProfile().color); }
function qualityIsGray() { return !!qualityProfile().gray; }
/* 视频档位（原画/高清走 auto 由服务端按网络决定；流畅/极省显式降档）。 */
function qualityVideoPreset() { return qualityProfile().video || "auto"; }
/* 音频码率：显式档位时返回该档码率，自动档返回 null（交回自动测速逻辑）。 */
function qualityAudioKbps() {
  if (qualityChoice() === "auto") return null;
  return Number(qualityProfile().kbps) || 0;
}

/* 把档位落到 <html>：CSS 用 data-quality 与 --vh-quality-color 做清晰度/色彩呈现，
   所以换档不需要任何图片重转，颜色也不可能"改不回来"。 */
function applyQualityLevel() {
  const id = qualityEffectiveId();
  const root = document.documentElement;
  if (root) {
    root.dataset.quality = id;
    root.style.setProperty("--vh-quality-color", String(qualityColorFactor()));
    root.classList.toggle("quality-gray", qualityIsGray());
  }
  const status = document.getElementById("qualityLevelStatus");
  if (status) status.textContent = qualityStatusText();
  const sel = document.getElementById("qualityLevel");
  if (sel && sel.value !== qualityChoice()) sel.value = qualityChoice();
  return id;
}
function qualityStatusText() {
  const choice = qualityChoice();
  const p = qualityProfile();
  const head = choice === "auto" ? `自动（当前 ${p.label}）` : p.label;
  return `${head} · ${p.sub}`;
}
function qualityLabelText() { return "画质·" + (qualityChoice() === "auto" ? "自动" : qualityProfile().label); }
/* 换档：写盘 → 立即生效 → 按需重渲染当前页面（图片按新宽度重新取，颜色即时恢复）。 */
function setQualityLevel(level, options = {}) {
  const next = QUALITY_ORDER.includes(level) ? level : "auto";
  try { localStorage.setItem(QUALITY_KEY, next); } catch (e) { /* localStorage 受限时仅本次生效 */ }
  applyQualityLevel();
  if (options.toast !== false) {
    const p = qualityProfile();
    toast(`🖼 画面清晰度：${next === "auto" ? `自动（当前 ${p.label}）` : p.label} · ${p.sub}`);
  }
  if (options.rerender !== false) rerenderForQuality();
  return next;
}
function cycleQualityLevel(options = {}) {
  const cur = qualityChoice();
  const idx = QUALITY_ORDER.indexOf(cur);
  return setQualityLevel(QUALITY_ORDER[(idx + 1) % QUALITY_ORDER.length], options);
}
/* 恢复原画：给「改不回来」提供一步到位的出口。 */
function resetQualityLevel() { return setQualityLevel("original"); }
function saveQualityLevelFromSettings() {
  const el = document.getElementById("qualityLevel");
  return setQualityLevel(el ? el.value : "auto");
}
/* 重渲染当前视图（不需要刷新浏览器）：媒体库视图重拉列表，首页重拉各栏。 */
function rerenderForQuality() {
  try {
    const active = document.querySelector(".view.active");
    const id = active ? String(active.id || "") : "";
    const view = id.startsWith("view-") ? id.slice(5) : "";
    const groups = { comic: "comic", movie: "movie", movie_: "movie", audio: "audio" };
    if (view === "movie" || view === "comic" || view === "audio") {
      const group = groups[view] || view;
      const lib = typeof localMediaSelection !== "undefined" ? findMediaLibrary(localMediaSelection[group]) : null;
      if (lib) { loadLocalFiles(group, lib, 0); return; }
    }
    if (view === "home" && typeof initHome === "function") { initHome(); return; }
    if (view && typeof switchView === "function") switchView(view);
  } catch (e) { console.warn("[quality] 重渲染失败（下次进入视图即生效）", e); }
}
/* 启动时调用一次：把持久化档位应用到文档（颜色/清晰度立即一致）。 */
function initQualityLevel() { return applyQualityLevel(); }
