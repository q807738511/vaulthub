/* VaultHub v1.0.5（需求1-3）—— TV / 遥控 / 键盘焦点层
   ============================================================================
   v1.0.4 首次引入这一层，v1.0.5 修掉三个实测暴露的问题：

     A. 「虚无控制选项」：焦点跳到看不见的东西上
        根因：`.tn-pop` 这类浮层是靠 `opacity:0 + pointer-events:none` 收起的，
              既没有 display:none 也没有 visibility:hidden，getClientRects() 仍然
              非空 —— 未打开的头像菜单、通知面板里的按钮全都进了焦点池，遥控器
              一按方向键就「跳进空气里」。
        修法：可见性判定加四道闸（详见 isVisible）：
              ① 元素自身/继承的 pointer-events:none → 不可交互，剔除；
              ② 定位祖先（fixed/absolute）整体透明 → 视为未打开，剔除；
              ③ 元素自身 opacity≈0（悬浮才出现的收藏角标等）→ 剔除；
              ④ 在视口内的元素再做一次命中测试（elementFromPoint），被别的东西
                 盖住的、或者根本点不到的，一律剔除。

     B. 「按键漂移」：按上变成左上/右上，按下变成左下/右下或直接丢失焦点
        根因：v1.0.4 的打分是 `主轴距离 + 0.42 × 横向偏移`，斜向候选只要够近就能
              赢过正上方/正下方的候选。网格里按一下 Right 常常落到下一行的卡片，
              按 Up 落到上一行的隔壁列。
        修法：改成「轴锁定三段式」（详见 nextInDirection）：
              ① 只考虑投影重叠的候选（同一行 / 同一列）→ 网格内绝不斜跳；
              ② 没有重叠时才允许「跨区域」跳转（顶栏 → 内容区），且错位不超过
                 一个身位；
              ③ 两段都没有候选就**不动**——宁可停住，也不跳到一个用户看不见的
                 元素上。

     C. 操作模式只剩「字号变大」
        根因：v1.0.4 的 TV 档 CSS 只有 font-size / min-height / focus 环。
        修法：三档各自一套真实手感（栅格列数、卡片尺寸、行高、点击目标、滚动
              吸附、动效节奏），见 web/css/main.css 的 v1.0.5 段落。

   保持不变的部分：遥控/鼠标/键盘分工、焦点保护（MutationObserver + 指纹回填）、
   覆盖层作用域、返回键、播放器/阅读器让行。
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

  function nowMs() {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  }
  function tvMode() {
    return document.documentElement.getAttribute("data-uimode") === "tv";
  }

  /* ---------- 可见性：焦点池只能装「用户真的看得见、点得到」的元素 ---------- */
  var visCache = new WeakMap();
  var VIS_TTL = 600;

  function positionedTransparent(el) {
    /* 浮层收起靠 opacity + pointer-events，而 opacity 不继承、getClientRects 也不为空，
       所以必须往上找定位祖先。只查 fixed/absolute：视图容器（.view）是静态定位，
       它的入场动画会把整块 opacity 压到 0，若一并判定，焦点池会瞬间塌成顶栏。 */
    var node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      var cs = window.getComputedStyle(node);
      var pos = cs.position;
      if ((pos === "fixed" || pos === "absolute") && parseFloat(cs.opacity || "1") < 0.05) return true;
      node = node.parentElement;
    }
    return false;
  }
  function inHorizontalScroller(el) {
    var node = el.parentElement;
    while (node && node !== document.body) {
      var ox = window.getComputedStyle(node).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
      node = node.parentElement;
    }
    return false;
  }
  function hitTest(el, r) {
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) return true; /* 屏外元素不做命中测试 */
    if (typeof document.elementFromPoint !== "function") return true;
    var hit = document.elementFromPoint(cx, cy);
    if (!hit) return true;
    return hit === el || el.contains(hit) || (hit.contains && hit.contains(el));
  }
  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    var t = nowMs();
    var cached = visCache.get(el);
    if (cached && t - cached.t < VIS_TTL) return cached.ok;
    var ok = checkVisible(el);
    visCache.set(el, { t: t, ok: ok });
    return ok;
  }
  function checkVisible(el) {
    if (el.closest("[hidden]")) return false;
    /* ① display:none 的祖先 → 没有 box；content-visibility:hidden 同理。 */
    if (el.getClientRects().length === 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    /* ② pointer-events 是继承属性：祖先声明 none、子元素又没改回 auto 时，
       计算值同样是 none —— 一条判断覆盖「整块浮层不可点」。 */
    if (cs.pointerEvents === "none") return false;
    /* ③ 悬浮才出现的角标（收藏心、缩放按钮）自身 opacity:0。 */
    if (parseFloat(cs.opacity || "1") < 0.05) return false;
    /* ④ 收起的浮层：定位祖先整体透明。 */
    if (positionedTransparent(el)) return false;
    /* ⑤ 完全跑到画布左右两侧的（抽屉/侧滑面板），除非在横向滚动容器里。 */
    var vw = window.innerWidth || document.documentElement.clientWidth;
    if ((r.right <= 1 || r.left >= vw - 1) && !inHorizontalScroller(el)) return false;
    /* ⑥ 视口内的元素必须真的「点得到」：被弹窗盖住、被顶栏压住都不算。 */
    if (!hitTest(el, r)) return false;
    return true;
  }
  function invalidateVisibility() { visCache = new WeakMap(); }

  /* 最上层覆盖层：有就只在里面导航（弹窗 > 阅读器/播放器 > 整页设置）。 */
  function activeScope() {
    var list = document.querySelectorAll(".modal-mask.show, .media-reader-overlay, .setpage.show");
    return list.length ? list[list.length - 1] : document.body;
  }
  /* 卡片本身是 <article onclick>，没有 tabindex —— v1.0.4 的焦点池里 1205 个
     可聚焦项其实全是卡片右下角那个 28px 的「观看状态」小按钮，遥控器按方向键
     等于在一堆小按钮之间跳，看起来就是「焦点飘在卡片外面」。
     v1.0.5：卡片本体成为焦点目标（tabindex=0），卡片内只在 hover 出现的角标
     降为 -1（鼠标照样能点，遥控走卡片 + Enter）。 */
  var CARD_SEL = ".media-poster-card, .series-show-card, .ep-grid-card, .series-episode-card, " +
                 ".hp, .book-card, .audio-album-card, .audio-latest-card, .movie-rec-card";
  var CARD_INNER = ".movie-poster-settings, .book-card-fav, .book-card-open, .audio-cover-zoom-btn";
  function ensureCardFocus(scope) {
    var cards = scope.querySelectorAll(CARD_SEL);
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i].hasAttribute("tabindex")) cards[i].setAttribute("tabindex", "0");
    }
    var inner = scope.querySelectorAll(CARD_INNER);
    for (var j = 0; j < inner.length; j++) {
      if (inner[j].getAttribute("tabindex") !== "-1") inner[j].setAttribute("tabindex", "-1");
    }
  }
  /* 焦点池：按作用域收集 + 可见性过滤；同一帧内复用，避免每次按键都全量重算。 */
  var poolCache = { t: 0, scope: null, list: [] };
  function focusables(root) {
    var scope = root || activeScope();
    if (!scope) return [];
    var t = nowMs();
    if (!root && poolCache.scope === scope && t - poolCache.t < 120) return poolCache.list;
    ensureCardFocus(scope);
    /* 卡片内角标虽然 tabindex=-1，但仍会被 `button:not([disabled])` 命中，
       所以要在过滤阶段再挡一次。 */
    var list = Array.prototype.filter.call(scope.querySelectorAll(FOCUSABLE), function (el) {
      if (el.matches && el.matches(CARD_INNER)) return false;
      return isVisible(el);
    });
    if (!root) { poolCache = { t: t, scope: scope, list: list }; }
    return list;
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
  function fullyVisible(r) {
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top >= 4 && r.bottom <= vh - 4 && r.left >= 0 && r.right <= vw;
  }
  function focusEl(el, opts) {
    if (!el || typeof el.focus !== "function") return false;
    var prev = document.activeElement;
    try { el.focus({ preventScroll: !!(opts && opts.preventScroll) }); } catch (e) { try { el.focus(); } catch (e2) { return false; } }
    if (!opts || opts.scroll !== false) {
      var r = el.getBoundingClientRect();
      if (!fullyVisible(r)) {
        /* TV 档用 center：遥控往下按时，卡片不会停在顶栏底下或屏幕最边缘。
           behavior 交给默认（不写 smooth），保证连续按键不拖影。 */
        try { el.scrollIntoView({ block: "center", inline: "nearest" }); }
        catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
      }
    }
    /* 焦点落点自检：万一落到不可见节点（重绘竞态），退回上一个焦点，绝不留在虚空。 */
    if (!isVisible(el)) {
      if (prev && prev !== document.body && isVisible(prev)) {
        try { prev.focus({ preventScroll: true }); } catch (e) {}
      }
      return false;
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

  /* ---------- 空间导航：轴锁定三段式（v1.0.5 重写） ---------- */
  function overlapLen(a1, a2, b1, b2) {
    var lo = Math.max(a1, b1), hi = Math.min(a2, b2);
    return hi - lo;
  }
  function nextInDirection(dir) {
    var pool = focusables();
    var current = document.activeElement;
    if (!pool.length) return null;
    if (!current || current === document.body || !isVisible(current)) return pool[0];
    var f = current.getBoundingClientRect();
    var horiz = (dir === "ArrowLeft" || dir === "ArrowRight");
    var forward = (dir === "ArrowRight" || dir === "ArrowDown") ? 1 : -1;
    var fcx = f.left + f.width / 2, fcy = f.top + f.height / 2;
    var band = null, bandScore = Infinity;
    var near = null, nearScore = Infinity;

    for (var i = 0; i < pool.length; i++) {
      var el = pool[i];
      if (el === current) continue;
      /* 同一张卡片内部的按钮不参与方向导航（Enter 才进去），否则 Right 会落进
         卡片自己的收藏角标里，看起来就是「焦点卡在卡片上不动」。 */
      if (el.contains(current) || current.contains(el)) continue;
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var major = horiz ? (cx - fcx) : (cy - fcy);
      if (major * forward <= 2) continue;            /* 必须在前进方向 */
      var gap, perp, ov;
      if (horiz) {
        gap = forward > 0 ? (r.left - f.right) : (f.left - r.right);
        perp = Math.abs(cy - fcy);
        ov = overlapLen(f.top, f.bottom, r.top, r.bottom);
      } else {
        gap = forward > 0 ? (r.top - f.bottom) : (f.top - r.bottom);
        perp = Math.abs(cx - fcx);
        ov = overlapLen(f.left, f.right, r.left, r.right);
      }
      if (gap < 0) gap = 0;
      if (ov > 0) {
        /* ① 同一行 / 同一列：只比主轴间距，横向错位仅作微调（0.05 权重）。
              —— 网格内按 Right 只会横着走，按 Up 只会竖着走。 */
        var s1 = gap + perp * 0.05;
        if (s1 < bandScore) { bandScore = s1; band = el; }
      } else if (perp <= Math.max(f.width, r.width) * 0.9) {
        /* ② 跨区域（顶栏 → 内容、侧栏 → 卡片、末列 → 下一段标题）：
              允许错开，但最多一个身位，且错位代价高，绝不会为了「近」而斜跳。 */
        var s2 = gap + perp * 1.2;
        if (s2 < nearScore) { nearScore = s2; near = el; }
      }
      /* ③ 两段都没命中 → 该方向无候选，保持不动（比跳进虚空好）。 */
    }
    return band || near || null;
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
    /* 顶栏头像/通知浮层不是 .modal-mask，之前按返回键关不掉，焦点会留在浮层里。 */
    var pop = document.querySelector(".tn-pop.open");
    if (pop) {
      pop.classList.remove("open");
      var trigger = document.getElementById("topUserButton");
      if (trigger && isVisible(trigger)) focusEl(trigger, { scroll: false });
      return true;
    }
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
    /* v1.0.6（需求7）：媒体详情页 / 阅读器 / 播放器最小化态也是「一层」。
       此前返回键只认 .modal-mask 与设置页，详情页只能手动点左上角返回按钮 ——
       遥控器上这等于「没有返回键」。层级顺序：播放器 → 分集详情 → 详情/阅读器。 */
    var overlay = document.querySelector(".media-reader-overlay");
    if (overlay) {
      var host = overlay.closest("[id^='local-media-viewer-']");
      var group = host ? host.id.replace("local-media-viewer-", "") : "movie";
      var videoBody = overlay.querySelector(".media-video-body");
      if (videoBody && typeof closeVideoPlayer === "function") {
        try { closeVideoPlayer(videoBody.querySelector("[data-video-play]") || videoBody); return true; } catch (e) {}
      }
      try {
        if (typeof seriesEpisodeReturn !== "undefined" && seriesEpisodeReturn && typeof closeEpisodeDetail === "function") {
          closeEpisodeDetail();
          return true;
        }
      } catch (e) {}
      if (typeof closeLocalViewer === "function") {
        closeLocalViewer(group);
        return true;
      }
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
      event.preventDefault();   /* 先拦掉原生滚动，避免「页面滚了但焦点没动」 */
      var next = nextInDirection(event.key);
      if (next) focusEl(next);
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
  /* 时钟每秒改一次文本、刮削进度每几秒换一段 HTML —— 如果每次变动都清空可见性
     缓存，1200 张卡的焦点池每秒都要重算一遍，电视盒子上会明显发卡。
     只有「属性变化」和「批量增删节点」才算结构性变化，才清缓存。 */
  function scheduleRestore(records) {
    var hard = false;
    for (var i = 0; i < (records ? records.length : 0); i++) {
      var rec = records[i];
      if (rec.type === "attributes") { hard = true; break; }
      if (rec.type === "childList" && (rec.addedNodes.length + rec.removedNodes.length) > 3) { hard = true; break; }
    }
    if (hard) {
      invalidateVisibility();
      poolCache = { t: 0, scope: null, list: [] };
    }
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

  /* 顶栏浮层（头像菜单 / 通知面板）是 onclick 展开的 div，点击本身不会给焦点，
     遥控器此时按方向键会从 <body> 掉到页面第一张卡片上 —— 打开就送进第一项。 */
  function focusOpenedPopup(trigger) {
    if (!tvMode()) return;
    setTimeout(function () {
      var pop = document.querySelector(".tn-pop.open");
      if (!pop) return;
      invalidateVisibility();
      var items = Array.prototype.filter.call(pop.querySelectorAll(".tn-popitem, button, a[href]"), isVisible);
      if (items.length) focusEl(items[0], { scroll: false });
    }, 140);
  }

  /* 视图切换后作用域变了：把焦点落到新视图的第一个可聚焦元素（TV 档）。 */
  document.addEventListener("click", function (event) {
    var trig = event.target && event.target.closest ? event.target.closest("#topUserButton, .tn-bell") : null;
    if (trig) focusOpenedPopup(trig);
    var tab = event.target && event.target.closest ? event.target.closest("[data-nav-key], [data-topnav]") : null;
    if (!tab) return;
    setTimeout(function () {
      if (!tvMode()) return;
      invalidateVisibility();
      var pool = focusables();
      if (pool.length && (!document.activeElement || document.activeElement === document.body)) focusEl(pool[0]);
    }, 120);
  }, true);

  window.vhFocus = {
    focusables: focusables,
    focusFirst: function () { var pool = focusables(); return pool.length ? focusEl(pool[0]) : false; },
    restore: restoreFocus,
    fingerprint: fingerprint,
    next: nextInDirection,
    /* 诊断用：浏览器实测时读它，确认焦点池里没有隐形元素。 */
    state: function () {
      var pool = focusables();
      return {
        tv: tvMode(),
        scope: activeScope() === document.body ? "body" : fingerprint(activeScope()),
        pool: pool.length,
        active: fingerprint(document.activeElement),
        activeVisible: isVisible(document.activeElement),
        rect: document.activeElement && document.activeElement.getBoundingClientRect
          ? (function (r) { return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(document.activeElement.getBoundingClientRect())
          : null
      };
    }
  };
})();
