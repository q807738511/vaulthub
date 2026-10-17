/* VaultHub v1.0.4（需求1）—— TV / 遥控 / 键盘焦点层
   ============================================================================
   背景：TV 档过去只是「字号放大 + 焦点环加粗」，遥控器按方向键根本不动焦点，
   鼠标移开、页面重绘一次，焦点就掉回 <body>，遥控器随即失灵。这一层专门解决
   三件事，且不复制任何业务逻辑：

     1. 输入规则（鼠标 / 遥控 / 键盘各管一段）
        · 遥控：方向键做「空间导航」（按几何距离就近跳，不是 DOM 顺序），
                Enter / OK 激活，返回键（Escape / Backspace / 461 / 10009）关覆盖层；
        · 键盘：TV 档方向键接管，其余档完全不接管（不破坏 PC 上的滚动习惯）；
                Tab 始终可用，输入框 / 播放器 / 阅读器内部按键一律让行。
        · 鼠标：TV 档「移上去即聚焦」—— 遥控和鼠标共用同一个焦点模型，
                不会出现「鼠标指着一个、遥控从另一个开始动」的分裂状态。

     2. 焦点保护（这是遥控器能不能用的关键）
        页面每 5 秒会重建顶栏标签、媒体库会整块重绘、刮削进度会 outerHTML 替换，
        这些都会把当前焦点节点从 DOM 里摘掉，浏览器随后把焦点丢给 <body>。
        这里用 MutationObserver 监听重绘：焦点丢失时按「焦点指纹」（id →
        data-* 键 → 标签+类名+文案）把焦点放回同一个逻辑位置；指纹找不到才
        退回当前作用域的第一个可聚焦元素。

     3. 焦点定位
        聚焦元素自动滚进可视区（block:"nearest"），配合 CSS 里的 scroll-padding
        / scroll-margin，遥控器往下按不会把焦点顶到被顶栏遮住的位置。

   作用域：有打开的弹窗 / 阅读器 / 播放器覆盖层时，焦点只在最上层覆盖层内循环，
   背景页不参与 —— 否则遥控器会「跳」到被遮住的按钮上。
   ============================================================================ */
(function () {
  "use strict";

  var FOCUSABLE = [
    "a[href]", "button:not([disabled])", "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])", "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])", "[role='button']:not([aria-disabled='true'])",
    "[role='radio']:not([aria-disabled='true'])", "[role='tab']:not([aria-disabled='true'])"
  ].join(",");
  var BACK_KEYS = ["Escape", "BrowserBack", "GoBack"];
  var BACK_CODES = [461, 10009, 8]; /* 8 = Backspace，仅在非输入态生效 */
  var remembered = { key: "", scopeKey: "" };
  var restoring = false;

  function tvMode() {
    return document.documentElement.getAttribute("data-uimode") === "tv";
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("[hidden]")) return false;
    /* 判定口径（实测踩过的三个坑）：
       ① 只看元素自身的 computed display 不够 —— 未打开的头像菜单 / 通知面板里，
          子元素自身仍是 inline-flex，遥控器会跳到屏幕外看不见的按钮上；
          `getClientRects().length === 0` 能覆盖「祖先 display:none」这种情况。
       ② 不能用 checkVisibility 的 opacity 判定 —— 电视盒子/后台标签页会把 CSS 动画
          节流在 0% 帧，整块视图的 opacity 长期是 0，焦点池会退化成只剩顶栏。
       ③ `content-visibility:auto` 跳过的离屏卡片本身没有 box，天然被 rect 过滤掉，
          正好只把「屏幕附近的卡片」纳入焦点池。 */
    if (el.getClientRects().length === 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = window.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  /* 最上层覆盖层：有就只在里面导航（弹窗 > 阅读器/播放器 > 整页设置）。 */
  function activeScope() {
    var list = document.querySelectorAll(".modal-mask.show, .media-reader-overlay, .setpage.show");
    return list.length ? list[list.length - 1] : document.body;
  }
  function focusables(root) {
    var scope = root || activeScope();
    if (!scope) return [];
    return Array.prototype.filter.call(scope.querySelectorAll(FOCUSABLE), isVisible);
  }
  /* 焦点指纹：重绘后靠它找回「同一个」逻辑位置。 */
  function fingerprint(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + el.id;
    var attrs = ["data-ui-opt", "data-op-opt", "data-theme-card", "data-theme-accent",
                 "data-mode-opt", "data-settab", "data-topnav", "data-nav-key", "data-lib-id",
                 "data-dock-return", "data-video-play", "data-path"];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) return attrs[i] + "=" + v;
    }
    var cls = (el.className || "").toString().trim().split(/\s+/).slice(0, 2).join(".");
    var text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24);
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (text ? ":" + text : "");
  }
  function findFingerprint(key, scope) {
    if (!key) return null;
    var pool = focusables(scope);
    for (var i = 0; i < pool.length; i++) {
      if (fingerprint(pool[i]) === key) return pool[i];
    }
    return null;
  }
  function scopeKey() {
    var scope = activeScope();
    return scope === document.body ? "body" : fingerprint(scope);
  }
  function remember(el) {
    if (!el || el === document.body) return;
    remembered.key = fingerprint(el);
    remembered.scopeKey = scopeKey();
  }
  function focusEl(el, opts) {
    if (!el || typeof el.focus !== "function") return false;
    try { el.focus({ preventScroll: !!(opts && opts.preventScroll) }); } catch (e) { try { el.focus(); } catch (e2) { return false; } }
    if (!opts || opts.scroll !== false) {
      try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { try { el.scrollIntoView(false); } catch (e2) {} }
    }
    remember(el);
    return true;
  }
  /* 焦点保护：重绘把焦点节点摘掉后，把焦点放回同一逻辑位置。 */
  function restoreFocus() {
    if (restoring) return;
    var active = document.activeElement;
    /* 焦点「丢了」的三种情形：停在 body、节点被重绘摘掉、或者节点还在但已经不可见
       （弹窗关闭后焦点常常留在隐藏的输入框上 —— 遥控器这时按任何键都没反应）。 */
    var lost = !active || active === document.body || active === document.documentElement
      || !active.isConnected || !isVisible(active);
    if (!lost) return;
    var scope = activeScope();
    var target = findFingerprint(remembered.key, scope);
    if (!target) {
      /* 指纹找不到（面板重建换了结构）→ 落在作用域第一个可聚焦元素上，
         总比停在 <body> 上让遥控器彻底失效要好。 */
      var pool = focusables(scope);
      target = pool[0] || null;
    }
    if (!target) return;
    restoring = true;
    try { focusEl(target, { preventScroll: false }); } finally { restoring = false; }
  }

  /* ---------- 空间导航：按几何位置就近跳，而不是 DOM 顺序 ---------- */
  function centerOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r };
  }
  function nextInDirection(dir) {
    var pool = focusables();
    var current = document.activeElement;
    if (!pool.length) return null;
    if (!current || current === document.body || !isVisible(current)) {
      return dir === "ArrowUp" ? pool[pool.length - 1] : pool[0];
    }
    var from = centerOf(current);
    var best = null, bestScore = Infinity;
    for (var i = 0; i < pool.length; i++) {
      var el = pool[i];
      if (el === current) continue;
      var to = centerOf(el);
      var dx = to.x - from.x, dy = to.y - from.y;
      var primary = 0, cross = 0;
      if (dir === "ArrowLeft") { if (dx > -4) continue; primary = -dx; cross = Math.abs(dy); }
      else if (dir === "ArrowRight") { if (dx < 4) continue; primary = dx; cross = Math.abs(dy); }
      else if (dir === "ArrowUp") { if (dy > -4) continue; primary = -dy; cross = Math.abs(dx); }
      else if (dir === "ArrowDown") { if (dy < 4) continue; primary = dy; cross = Math.abs(dx); }
      else return null;
      /* 主轴距离 + 0.42×横向偏移：优先同一行/同一列，其次才跳远一点。 */
      var score = primary + cross * 0.42;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }
  function activate(el) {
    if (!el) return false;
    if (el.tagName === "INPUT" && el.type === "checkbox") { el.click(); return true; }
    el.click();
    return true;
  }
  function typingTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return false;
  }
  function ownsKeys(el) {
    /* 播放器 / 阅读器 / 漫画有自己的方向键语义（切集、翻页、进度），一律让行。 */
    if (!el || !el.closest) return false;
    return !!(el.closest("[data-video-panel]") || el.closest(".media-video-body") ||
              el.closest(".media-viewer-doc") || el.closest(".comic-reader") ||
              el.closest(".epub-viewer"));
  }

  /* 覆盖层关掉后，焦点通常还停在已经隐藏的输入框上 —— 遥控器这时按什么都没反应。
     统一在关闭动作之后把焦点交回可见区（优先记忆位置，其次作用域第一个可聚焦元素）。 */
  function recoverFocusAfterClose() {
    setTimeout(function () {
      if (isVisible(document.activeElement)) return;
      var scope = activeScope();
      var target = findFingerprint(remembered.key, scope) || focusables(scope)[0];
      if (target) focusEl(target, { preventScroll: false });
    }, 60);
  }
  /* ---------- 返回键：关最上层覆盖层，其次退出设置页 ---------- */
  function goBack() {
    var masks = document.querySelectorAll(".modal-mask.show");
    if (masks.length) {
      var top = masks[masks.length - 1];
      var closeBtn = top.querySelector(".close, [onclick*='closeModal']");
      if (closeBtn && typeof closeBtn.click === "function") { closeBtn.click(); recoverFocusAfterClose(); return true; }
      top.classList.remove("show");
      recoverFocusAfterClose();
      return true;
    }
    if (document.body.classList.contains("player-immersive") && typeof closeVideoPlayer === "function") {
      try { closeVideoPlayer(); return true; } catch (e) {}
    }
    var settings = document.getElementById("view-settings");
    if (settings && settings.classList.contains("active") && typeof closeSettingsPage === "function") {
      closeSettingsPage();
      return true;
    }
    return false;
  }

  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented) return;
    var code = Number(event.keyCode || 0);
    var isBack = BACK_KEYS.indexOf(event.key) >= 0 || BACK_CODES.indexOf(code) >= 0;
    if (isBack) {
      if (typingTarget(event.target) && event.key === "Backspace") return;
      if (event.key === "Escape" && document.body.classList.contains("player-immersive") && typingTarget(event.target)) return;
      if (goBack()) event.preventDefault();
      return;
    }
    if (!tvMode()) return;
    if (typingTarget(event.target) || ownsKeys(event.target)) return;
    var dirs = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (dirs.indexOf(event.key) >= 0) {
      var next = nextInDirection(event.key);
      if (next) {
        event.preventDefault();
        focusEl(next);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " " || code === 13) {
      var active = document.activeElement;
      if (!active || active === document.body) {
        var first = focusables()[0];
        if (first) { event.preventDefault(); focusEl(first); }
        return;
      }
      /* 原生可激活元素（button/a/input）自己会响应 Enter/Space，不重复触发。 */
      var tag = String(active.tagName || "").toLowerCase();
      if (tag === "button" || tag === "a" || tag === "input" || tag === "select" || tag === "textarea") return;
      event.preventDefault();
      activate(active);
    }
  }, true);

  /* ---------- 鼠标：TV 档移上去即聚焦，与遥控共用一个焦点 ---------- */
  document.addEventListener("pointerover", function (event) {
    if (!tvMode()) return;
    var target = event.target && event.target.closest ? event.target.closest(FOCUSABLE) : null;
    if (!target || !isVisible(target)) return;
    if (document.activeElement === target) return;
    focusEl(target, { preventScroll: true, scroll: false });
  }, true);

  /* ---------- 焦点保护：重绘 / 节点替换后把焦点放回去 ---------- */
  var scheduled = false;
  function scheduleRestore() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      restoreFocus();
    });
  }
  try {
    var observer = new MutationObserver(scheduleRestore);
    /* 弹窗开关、覆盖层显隐都只改 class/style，不改子节点 —— 只观察 childList 会漏掉
       「关掉弹窗后焦点留在隐藏输入框」这种情况，所以把属性变化也纳入（rAF 节流）。 */
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"]
    });
  } catch (e) { /* 老浏览器没有 MutationObserver：只保留键盘与鼠标规则 */ }

  /* 视图切换后作用域变了：把焦点落到新视图的第一个可聚焦元素（TV 档）。 */
  document.addEventListener("click", function (event) {
    var tab = event.target && event.target.closest ? event.target.closest("[data-nav-key], [data-topnav]") : null;
    if (!tab) return;
    setTimeout(function () {
      if (!tvMode()) return;
      var pool = focusables();
      if (pool.length && (!document.activeElement || document.activeElement === document.body)) focusEl(pool[0]);
    }, 120);
  }, true);

  window.vhFocus = {
    focusables: focusables,
    focusFirst: function () { var pool = focusables(); return pool.length ? focusEl(pool[0]) : false; },
    restore: restoreFocus,
    fingerprint: fingerprint,
    next: nextInDirection
  };
})();
