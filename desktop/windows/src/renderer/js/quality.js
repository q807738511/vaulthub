/* ============================================================================
   画面清晰度档位 —— 对齐服务端 Web 端 v0.9.88 的 web/js/03-quality.js

   服务端原文设计约束（照搬，保证三端一致）：
     1) 「省流」= 一档**画面清晰度**，档位越高画面越清晰、色彩越完整；
        最低档是「无色彩（灰度）」+ 最低清晰度。
     2) 颜色由档位显式决定，任何档位都能随时切回（可逆，只改 CSS 变量与取图宽度）。
     3) 「自动」档沿用 v0.9.71 弱网判定（saveData / 2g-3g / 测速判定弱网），
        弱网时落到「高清」，否则「原画」。

   档位与手段（全部走既有服务端能力，不新增后端参数）：
     原画  original  页面原图(w 不传) · 封面 320 · 视频 auto    · 色彩 100%
     高清  high      页面转码 1600px  · 封面 320 · 视频 auto    · 色彩 100%
     流畅  smooth    页面转码 1200px  · 封面 200 · 视频 720p    · 色彩 70%
     极省  minimal   页面转码  900px  · 封面 140 · 视频 480p    · 色彩 0%（灰度）
   ========================================================================= */

const QUALITY_KEY = 'vaulthub_quality_level_v1';

/** 顺序即按钮循环顺序：自动 → 原画 → 高清 → 流畅 → 极省 → 自动 */
export const QUALITY_ORDER = ['auto', 'original', 'high', 'smooth', 'minimal'];

export const QUALITY_PROFILE = {
  original: { id: 'original', label: '原画', sub: '原图直出 · 完整色彩', pageW: 0, coverW: 320, video: 'auto', kbps: 0, color: 1, gray: false },
  high: { id: 'high', label: '高清', sub: '转码 1600px · 完整色彩', pageW: 1600, coverW: 320, video: 'auto', kbps: 0, color: 1, gray: false },
  smooth: { id: 'smooth', label: '流畅', sub: '转码 1200px · 色彩 70%', pageW: 1200, coverW: 200, video: '720p', kbps: 128, color: 0.7, gray: false },
  minimal: { id: 'minimal', label: '极省', sub: '转码 900px · 无色彩（灰度）', pageW: 900, coverW: 140, video: '480p', kbps: 96, color: 0, gray: true },
};

/* 测速/探针得到的弱网结论（null = 未测，交给浏览器提示判断） */
let weakNetworkOverride = null;
/* 最近一次测得的带宽（bps），随 playback/plan 的 network_bps 上报给服务端 */
let measuredBps = 0;

export function setWeakNetwork(v) {
  weakNetworkOverride = v === null || v === undefined ? null : !!v;
}

export function setMeasuredBps(bps) {
  measuredBps = Number(bps) || 0;
}

export function measuredNetworkBps() {
  return measuredBps;
}

/** 弱网判定：与 v0.9.71 同源 —— 显式测速结论 > 浏览器省流提示 > 2g/3g */
export function weakNetworkActive() {
  if (weakNetworkOverride !== null) return weakNetworkOverride;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (c && c.saveData) return true;
  if (/^(slow-)?2g$|^3g$/.test(String((c && c.effectiveType) || ''))) return true;
  return false;
}

export function qualityChoice() {
  try {
    const v = String(localStorage.getItem(QUALITY_KEY) || 'auto');
    return QUALITY_ORDER.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** 当前实际生效的档位 id（自动档在这里落地为具体档） */
export function qualityEffectiveId() {
  const choice = qualityChoice();
  if (choice !== 'auto') return choice;
  return weakNetworkActive() ? 'high' : 'original';
}

export function qualityProfile() {
  return QUALITY_PROFILE[qualityEffectiveId()] || QUALITY_PROFILE.original;
}

/** 阅读页转码宽度：显式档位优先；「自动」返回 null，交回旧省流判定 */
export function qualityPageWidth() {
  if (qualityChoice() === 'auto') return null;
  return qualityProfile().pageW;
}

/** 封面/海报缩略宽度：档位越低取图越小 */
export function qualityCoverWidth(fallback = 320) {
  const w = Number(qualityProfile().coverW) || 0;
  return w > 0 ? w : Number(fallback) || 320;
}

export function qualityColorFactor() {
  return Number(qualityProfile().color);
}
export function qualityIsGray() {
  return !!qualityProfile().gray;
}
/** 视频档位：原画/高清走 auto（服务端按网络决定）；流畅/极省显式降档 */
export function qualityVideoPreset() {
  return qualityProfile().video || 'auto';
}
/** 音频码率：显式档位返回该档码率，自动档返回 null（交回自动测速逻辑） */
export function qualityAudioKbps() {
  if (qualityChoice() === 'auto') return null;
  return Number(qualityProfile().kbps) || 0;
}

/**
 * 把档位落到 <html>：CSS 用 data-quality 与 --vh-quality-color 呈现清晰度/色彩，
 * 所以换档不需要任何图片重转，颜色也不可能「改不回来」。
 */
export function applyQualityLevel() {
  const id = qualityEffectiveId();
  const root = document.documentElement;
  if (root) {
    root.dataset.quality = id;
    root.style.setProperty('--vh-quality-color', String(qualityColorFactor()));
    root.classList.toggle('quality-gray', qualityIsGray());
  }
  return id;
}

export function qualityStatusText() {
  const choice = qualityChoice();
  const p = qualityProfile();
  const head = choice === 'auto' ? `自动（当前 ${p.label}）` : p.label;
  return `${head} · ${p.sub}`;
}

export function qualityLabelText() {
  return `画质·${qualityChoice() === 'auto' ? '自动' : qualityProfile().label}`;
}

export function setQualityLevel(level) {
  const next = QUALITY_ORDER.includes(level) ? level : 'auto';
  try {
    localStorage.setItem(QUALITY_KEY, next);
  } catch {
    /* localStorage 受限时仅本次生效 */
  }
  applyQualityLevel();
  return next;
}

export function cycleQualityLevel() {
  const cur = qualityChoice();
  const idx = QUALITY_ORDER.indexOf(cur);
  return setQualityLevel(QUALITY_ORDER[(idx + 1) % QUALITY_ORDER.length]);
}

/** 恢复原画：给「改不回来」提供一步到位的出口 */
export function resetQualityLevel() {
  return setQualityLevel('original');
}

/** 启动时调用一次 */
export function initQualityLevel() {
  return applyQualityLevel();
}
