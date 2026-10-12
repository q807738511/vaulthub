/* v0.9.97：Plex 口径的多季剧集刮削（前端编排层）。
 *
 * 客户要求「参考 PLEX 剧集刮削策略对多季剧集进行刮削」，落地成四件事：
 *
 *   1) 命名与目录按 Plex 规则解析（解析器在 02-media.js 的 parseSeriesEpisode：
 *      方括号内容整体忽略、sXXeYY、sXXeYY-eZZ 多集合并、1x02、第X季第Y集、E05 简写、
 *      季目录优先于文件名里的季号、Specials / Season 00 归第 0 季特别篇、
 *      解析不出来就**以文件名展示**，不吞条目）。
 *   2) 多季全量刮削：逐季取季名 / 季简介 / 季海报，并按集号把官方分集名写回每一集；
 *      多集合并文件把两集的名字一起写（`E18 名 / E19 名`）。
 *   3) 缺失集比对：本地集号 vs 官方集数（服务端 /api/media/series/missing，对应指南里的
 *      PlexMissingEpisodes 批量校验），缺哪季缺哪集直接列出来。
 *   4) 命名体检 + 重匹配（Plex Dance）：列出不符合 Plex 规范的条目与建议规范路径，
 *      并可清掉该剧的刮削结果后重新逐季刮削。
 *
 * 判定规则的唯一权威是服务端 media-go/plex_naming.go（/api/media/series/plan）：
 * 前端只做展示与编排，避免前后端两套规则各说各话。
 */

/* ==================== 一、Plex 口径的标签与工具函数 ==================== */

/* 方括号（含全角）内容整体忽略 —— Plex 就是这样做的，展示与建议名都按这个口径。 */
const SERIES_PLEX_BRACKET_RE = /\[[^\]]*\]|【[^】]*】/g;

function seriesPlexStripBrackets(text) {
  return String(text == null ? "" : text).replace(SERIES_PLEX_BRACKET_RE, " ").replace(/\s+/g, " ").trim();
}

/* 季标签：第 0 季是 Plex 的特别篇季（Season 00 / Specials）。 */
function seriesPlexSeasonLabel(season) {
  const n = Number(season) || 0;
  return n <= 0 ? "特别篇" : `第 ${n} 季`;
}

/* 季目录名：Season 01 / Season 00（特别篇）。 */
function seriesPlexSeasonDir(season) {
  const n = Math.max(0, Number(season) || 0);
  return `Season ${String(n).padStart(2, "0")}`;
}

/* 剧根目录名：`剧集名 (首播年份)` —— 指南要求的命名，避免同名不同版本错配。 */
function seriesPlexShowDirName(title, year) {
  const name = seriesPlexStripBrackets(title) || "剧集名";
  return year ? `${name} (${year})` : `${name} (年份)`;
}

/* 集号压缩标签：E01-E03、E05（与服务端 plexEpisodeRanges 同口径）。 */
function seriesPlexEpisodeRanges(nums) {
  const list = [...new Set((nums || []).map(Number).filter(n => n > 0))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    if (j === i || j === i + 1) { for (let k = i; k <= j; k++) out.push(`E${String(list[k]).padStart(2, "0")}`); }
    else out.push(`E${String(list[i]).padStart(2, "0")}-E${String(list[j]).padStart(2, "0")}`);
    i = j + 1;
  }
  return out.join("、");
}

/* 缺失集：官方 1..official 里本地没有的集号。official <= 0（未知）时返回空 —— 不猜。 */
function seriesPlexMissing(have, official) {
  const set = new Set((have || []).map(Number).filter(n => n > 0));
  const total = Number(official) || 0;
  const out = [];
  for (let n = 1; n <= total; n++) if (!set.has(n)) out.push(n);
  return out;
}

/* 一条分集记录里本地已有的集号（多集合并文件同时覆盖起始与结束集号）。 */
function seriesPlexLocalNumbers(season) {
  const nums = [];
  ((season && season.episodes) || []).forEach(ep => {
    const parsed = (ep && ep.parsed) || parseSeriesEpisode(ep && ep.path);
    const n = Number(parsed && parsed.episode) || 0;
    if (n > 0) nums.push(n);
    const end = Number(parsed && parsed.episodeEnd) || 0;
    if (end > n) { for (let x = n + 1; x <= end; x++) nums.push(x); }
  });
  return [...new Set(nums)].sort((a, b) => a - b);
}

/* 一条路径的剧根目录名（季目录的上一层；没有季目录时取第一层）。用于把前端的剧卡
   与服务端方案里的剧对齐 —— 两边都拿目录名比对，不依赖各自的归一化键。 */
function seriesPlexShowDirOf(path) {
  const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
  parts.pop();
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^(?:season|s)\s*0*\d{1,2}$/i.test(parts[i]) || /^第\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[季部]$/.test(parts[i]) ||
        /^(?:specials?|sp|特别篇|特別篇|特别集|特典|花絮|番外)$/i.test(parts[i])) {
      return String(parts[i - 1] || parts[0] || "").trim();
    }
  }
  return String(parts[parts.length - 1] || parts[0] || "").trim();
}

/* 剧卡的全部剧根目录名（同一部剧可能分散在多个目录：分季目录各一套 / 年份写法不同）。 */
function seriesPlexShowDirsOf(show) {
  const dirs = new Set();
  seriesShowEpisodePaths(show).forEach(p => { const d = seriesPlexShowDirOf(p); if (d) dirs.add(d); });
  ((show && show.dirs) || []).forEach(d => { if (d) dirs.add(String(d)); });
  return [...dirs];
}

/* ==================== 二、服务端多季方案（命名体检的数据来源） ==================== */

const seriesPlexPlanCache = {};
let activeSeriesPlex = null;   // { libId, showKey, missing:服务端比对结果 }
/* v0.9.98：缺失集比对结果按「库|剧」缓存 —— 面板现在可以一次渲染整库多部剧，
   不能再共用单个 activeSeriesPlex.missing。 */
const seriesPlexMissingCache = {};
function seriesPlexMissingOf(libId, showKey) { return seriesPlexMissingCache[`${libId}|${showKey}`] || null; }
function seriesPlexSetMissing(libId, showKey, data) { seriesPlexMissingCache[`${libId}|${showKey}`] = data || null; }
/* 解析调用上下文：显式传参优先（整库面板每部剧的按钮都带自己的库/剧），
   没传才回落到当前打开的面板上下文。 */
function seriesPlexCtx(libId, showKey) {
  if (libId && showKey) return { libId: String(libId), showKey: String(showKey) };
  return activeSeriesPlex;
}
function seriesPlexOverwriteLocal(scope) {
  if (scope === "settings") {
    const sel = document.getElementById("plexOverwriteLocal");
    if (sel) return String(sel.value) === "1";
  }
  return !!document.getElementById("seriesPlexOverwriteLocal")?.checked;
}

async function loadSeriesPlexPlan(libId, force) {
  const key = String(libId || "");
  if (!key) return null;
  if (!force && seriesPlexPlanCache[key]) return seriesPlexPlanCache[key];
  try {
    const res = await fetch(`/api/media/series/plan?lib=${encodeURIComponent(key)}`, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.ok || !data.plan) return null;
    seriesPlexPlanCache[key] = data;
    return data;
  } catch (e) { return null; }
}

/* 在整库方案里找到这部剧：优先按剧根目录名精确匹配，再退到剧名 + 年份。 */
function seriesPlexShowInPlan(planData, show) {
  const shows = (planData && planData.plan && Array.isArray(planData.plan.shows)) ? planData.plan.shows : [];
  if (!shows.length) return null;
  const dirs = seriesPlexShowDirsOf(show);
  for (const s of shows) {
    const sdirs = Array.isArray(s.dirs) ? s.dirs : [];
    if (sdirs.some(d => dirs.indexOf(d) >= 0)) return s;
  }
  const title = seriesPlexStripBrackets(show && show.title);
  const year = String((show && show.year) || "").trim();
  for (const s of shows) {
    if (seriesPlexStripBrackets(s.title) === title && (!year || String(s.year || "") === year)) return s;
  }
  return null;
}

/* ==================== 三、多季刮削编排 ==================== */

/* 取这部剧的 TMDB ID：剧卡上已存的 → 任一集元数据里的 → TMDB 搜索命中的（并回写）。 */
async function seriesPlexTmdbId(lib, show) {
  let tid = String((show && show.tmdb_id) || "").trim();
  if (tid) return tid;
  seriesShowEpisodePaths(show).some(p => {
    const meta = movieMetadataFor(p) || {};
    if (meta.tmdb_id) { tid = String(meta.tmdb_id); return true; }
    return false;
  });
  if (tid) { show.tmdb_id = tid; rememberSeriesShow(lib.id, show); return tid; }
  if (!scraperStatus.tmdb_enabled || !show || !show.title) return "";
  try {
    const q = await fetch(`/api/media/tmdb?query=${encodeURIComponent(show.title)}&type=series&lang=${tmdbLangTag()}`, { cache: "force-cache" });
    if (!q.ok) return "";
    const found = ((await q.json()) || {}).results || [];
    const hit = found.find(x => x.poster_path || x.overview || x.name);
    if (!hit) return "";
    tid = String(hit.id);
    show.tmdb_id = tid;
    if (Number(hit.vote_average)) show.rating = Number(hit.vote_average);
    if (!show.year && hit.first_air_date) show.year = String(hit.first_air_date).slice(0, 4);
    if (!show.poster && hit.poster_path) show.poster = `${scraperStatus.tmdb_image_base || "https://image.tmdb.org/t/p"}/w342${hit.poster_path}`;
    rememberSeriesShow(lib.id, show);
    return tid;
  } catch (e) { return ""; }
}

/* 把某一季的官方元数据写回本地记录。
   opts.overwriteLocal=false 时遵守 Plex 的「Local Media Assets 优先」口径：
   已经有本地 NFO 的分集不被网络刮削覆盖。 */
function applySeriesSeasonScrape(libId, show, season, data, opts) {
  const overwriteLocal = !!(opts && opts.overwriteLocal);
  const all = readMovieMetadata();
  const byNum = new Map();
  ((data && data.episodes) || []).forEach(ep => {
    const n = Number(ep && ep.episode_number) || 0;
    if (n > 0) byNum.set(n, ep);
  });
  let written = 0, skippedLocal = 0;
  ((season && season.episodes) || []).forEach(entry => {
    const path = String(entry.path || "");
    if (!path) return;
    const parsed = entry.parsed || parseSeriesEpisode(path);
    const cur = all[path] || movieBaseMetadata(path);
    if (!overwriteLocal && String(cur.provider || "") === "本地 NFO" && cur.title) { skippedLocal++; return; }
    const rec = { ...cur };
    rec.season_num = Number(season.season) || 0;
    rec.season_tag = `S${String(Math.max(0, Number(season.season) || 0)).padStart(2, "0")}`;
    if (data && data.name) rec.season_name = String(data.name).trim();
    if (data && data.overview) rec.season_overview = String(data.overview).trim();
    if (data && data.poster) rec.season_poster = data.poster;
    rec.media_type = "series";
    rec.show_title = String(show.title || "").trim() || rec.show_title || "";
    const first = byNum.get(Number(parsed.episode) || 0);
    if (first) {
      let title = String(first.name || "").trim();
      const end = Number(parsed.episodeEnd) || 0;
      if (end > (Number(parsed.episode) || 0)) {
        const second = byNum.get(end);
        const secondName = second ? String(second.name || "").trim() : "";
        if (secondName && secondName !== title) title = `${title} / ${secondName}`;
      }
      if (title) rec.title = title;
      if (first.still_path) rec.poster = `${scraperStatus.tmdb_image_base || "https://image.tmdb.org/t/p"}/w300${first.still_path}`;
    } else {
      /* 官方没有这一集（或该季官方集数更少）：保持「文件名/集号展示」，绝不写空标题把条目弄丢。 */
      const fallback = String(parsed.title || "").trim() || String(movieTitleFromPath(path) || "").trim();
      if (fallback) rec.title = fallback;
    }
    if (!rec.provider || rec.provider === "文件名展示" || rec.provider === "文件名") {
      rec.provider = data && (data.name || data.overview) ? "TMDB" : rec.provider;
    }
    all[path] = rec;
    entry.meta = rec;
    written++;
  });
  if (written) writeMovieMetadata(all);
  if (data) {
    season.name = String(data.name || "").trim() || season.name;
    season.overview = String(data.overview || "").trim() || season.overview;
  }
  try { syncSeriesShowMetadata(libId, show); } catch (e) {}
  rememberSeriesShow(libId, show);
  return { written, skippedLocal };
}

/* 单季刮削（面板里的「刮削本季」）。 */
async function seriesPlexScrapeSeason(seasonNum, libId, showKey) {
  const ctx = seriesPlexCtx(libId, showKey);
  if (!ctx) return null;
  const lib = findMediaLibrary(ctx.libId), show = readSeriesShow(ctx.libId, ctx.showKey);
  if (!lib || !show) return null;
  const season = (show.seasonList || []).find(s => Number(s.season) === Number(seasonNum));
  if (!season) { toast("没找到该季"); return null; }
  const tid = await seriesPlexTmdbId(lib, show);
  if (!tid) { toast("未匹配到 TMDB 条目：先完成一次刮削，或在「编辑媒体信息」里填写 TMDB ID"); return null; }
  const data = await fetchSeriesSeason(tid, season.season);
  if (!data) { toast(`${seriesPlexSeasonLabel(season.season)}：TMDB 取数失败（网络或该季不存在）`); return null; }
  const overwriteLocal = seriesPlexOverwriteLocal(activeSeriesPlex && activeSeriesPlex.scope);
  const r = applySeriesSeasonScrape(lib.id, show, season, data, { overwriteLocal });
  const official = Math.max(0, ...((data.episodes || []).map(e => Number(e.episode_number) || 0)));
  const missing = seriesPlexMissing(seriesPlexLocalNumbers(season), official);
  toast(`${seriesPlexSeasonLabel(season.season)} 刮削完成：写入 ${r.written} 集${r.skippedLocal ? `，跳过本地 NFO ${r.skippedLocal} 集` : ""}${missing.length ? `；缺 ${seriesPlexEpisodeRanges(missing)}` : "；集数完整"}`);
  await seriesPlexRenderPanel(true, null, libId, showKey);
  return r;
}

/* 多季全量刮削：逐季取季元数据 + 分集名，并汇总每季的缺失集。 */
async function scrapeSeriesAllSeasons(libId, showKey, opts) {
  const lib = findMediaLibrary(libId), show = readSeriesShow(libId, showKey);
  if (!lib || !show) return null;
  const seasons = (show.seasonList || []).slice().sort((a, b) => Number(a.season) - Number(b.season));
  if (!seasons.length) { toast("这部剧还没有识别到任何季"); return null; }
  const tid = await seriesPlexTmdbId(lib, show);
  if (!tid) { toast("未匹配到 TMDB 条目：先完成一次刮削，或在「编辑媒体信息」里填写 TMDB ID"); return null; }
  const overwriteLocal = !!(opts && opts.overwriteLocal);
  let okSeasons = 0, episodes = 0, skipped = 0;
  const notes = [];
  for (const season of seasons) {
    const data = await fetchSeriesSeason(tid, season.season);
    if (!data || !Array.isArray(data.episodes) || !data.episodes.length) { notes.push(`${seriesPlexSeasonLabel(season.season)} 官方无数据`); continue; }
    const r = applySeriesSeasonScrape(lib.id, show, season, data, { overwriteLocal });
    okSeasons++; episodes += r.written; skipped += r.skippedLocal;
    const official = Math.max(0, ...data.episodes.map(e => Number(e.episode_number) || 0));
    const missing = seriesPlexMissing(seriesPlexLocalNumbers(season), official);
    if (missing.length) notes.push(`${seriesPlexSeasonLabel(season.season)} 缺 ${seriesPlexEpisodeRanges(missing)}`);
  }
  show.scrape_state = "done";
  rememberSeriesShow(lib.id, show);
  try { pushMovieScrapeResults(lib.id, seriesShowEpisodePaths(show), { silent: true }); } catch (e) {}
  toast(`多季刮削完成：${okSeasons}/${seasons.length} 季 · ${episodes} 集${skipped ? `（跳过本地 NFO ${skipped} 集）` : ""}${notes.length ? "；" + notes.join("，") : ""}`);
  return { okSeasons, episodes, skipped, notes };
}

/* ==================== 四、缺失集比对（官方集数） ==================== */

async function seriesPlexCompareMissing(libId, showKey) {
  const ctx = seriesPlexCtx(libId, showKey);
  if (!ctx) return null;
  const lib = findMediaLibrary(ctx.libId), show = readSeriesShow(ctx.libId, ctx.showKey);
  if (!lib || !show) return null;
  const tid = seriesPlexTmdbId(lib, show);
  const dirs = seriesPlexShowDirsOf(show);
  const q = new URLSearchParams();
  q.set("lib", lib.id);
  if (dirs[0]) q.set("dir", dirs[0]);
  if (show.title) q.set("title", show.title);
  if (tid) q.set("tmdb", String(tid));
  try {
    const res = await fetch(`/api/media/series/missing?${q.toString()}`, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) { toast(`比对失败：HTTP ${res.status}`); return null; }
    const data = await res.json();
    if (!data || !data.ok) { toast("比对失败：服务端未返回结果"); return null; }
    seriesPlexSetMissing(ctx.libId, ctx.showKey, data);
    const parts = (data.seasons || []).filter(s => (s.missing || []).length).map(s => `${s.tag} 缺 ${seriesPlexEpisodeRanges(s.missing)}`);
    toast(parts.length ? `缺失集：${parts.join("；")}` : (data.notes && data.notes.length ? data.notes[0] : "各季集数与官方一致"));
    await seriesPlexRenderPanel(true, null, libId, showKey);
    return data;
  } catch (e) { toast("比对失败：网络异常"); return null; }
}

/* ==================== 五、重匹配（Plex Dance） ==================== */

/* Plex 社区的标准修复流程：移除 → 清元数据 → 重新匹配。这里对应：
   清掉这部剧全部分集的本地刮削记录与剧卡记忆 → 逐季重新刮削 → 结果回写服务端缓存。 */
async function seriesPlexRematch(libId, showKey) {
  const ctx = seriesPlexCtx(libId, showKey);
  if (!ctx) return null;
  const lib = findMediaLibrary(ctx.libId), show = readSeriesShow(ctx.libId, ctx.showKey);
  if (!lib || !show) return null;
  const paths = seriesShowEpisodePaths(show);
  const all = readMovieMetadata();
  let cleared = 0;
  paths.forEach(p => { if (all[p]) { delete all[p]; cleared++; } });
  if (cleared) writeMovieMetadata(all);
  show.tmdb_id = "";
  show.rating = 0;
  show.provider = "文件名展示";
  show.scrape_state = "";
  show.scrapedTitle = "";
  (show.seasonList || []).forEach(s => { s.name = ""; s.overview = ""; });
  rememberSeriesShow(lib.id, show);
  try { localStorage.removeItem(seriesShowStoreKey(lib.id, show.key)); } catch (e) {}
  seriesPlexPlanCache[lib.id] = null;
  delete seriesPlexPlanCache[lib.id];
  toast(`已清除该剧 ${cleared} 条刮削记录，正在重新逐季匹配…`);
  const r = await scrapeSeriesAllSeasons(lib.id, show.key, { overwriteLocal: seriesPlexOverwriteLocal(activeSeriesPlex && activeSeriesPlex.scope) });
  seriesPlexSetMissing(lib.id, show.key, null);
  await seriesPlexRenderPanel(true, null, libId, showKey);
  return r;
}

/* ==================== 六、面板渲染 ==================== */

function seriesPlexCopySuggestion(btn) {
  const text = btn && btn.getAttribute ? (btn.getAttribute("data-suggest") || "") : "";
  if (!text) return;
  if (typeof copyTextFallback === "function" && copyTextFallback(text)) { toast("✅ 建议路径已复制"); return; }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast("✅ 建议路径已复制")).catch(() => toast("复制失败，请手动选中"));
    return;
  }
  toast("当前环境不支持一键复制，请手动选中");
}

function seriesPlexSeasonRow(lib, show, planSeason, missing) {
  const localTag = String(planSeason.numbers_tag || "") || "—";
  const epCount = Number(planSeason.count) || 0;
  const m = missing && (missing.seasons || []).find(x => Number(x.season) === Number(planSeason.season));
  const official = m && m.official_count ? `${m.official_count} 集` : "未比对";
  const missLabel = m && (m.missing || []).length
    ? `<span class="series-plex-missing">缺 ${esc(seriesPlexEpisodeRanges(m.missing))}</span>`
    : (m && m.official_count ? `<span class="series-plex-ok">✓ 集数完整</span>` : `<span class="series-plex-todo">待比对</span>`);
  return `<tr>
    <td><b>${esc(seriesPlexSeasonLabel(planSeason.season))}</b><small>${esc(seriesPlexSeasonDir(planSeason.season))}${planSeason.special ? " · 特别篇" : ""}</small></td>
    <td>${epCount} 集<small>${esc(localTag)}</small></td>
    <td>${esc(official)}</td>
    <td>${missLabel}</td>
    <td><button class="btn btn-sm" type="button" onclick="seriesPlexScrapeSeason(${Number(planSeason.season) || 0},${jsAttrArg(lib.id)},${jsAttrArg(show.key)})">刮削本季</button></td>
  </tr>`;
}

function seriesPlexIssueRow(issue) {
  const problems = (issue.issues || []).map(x => `<li>${esc(x)}</li>`).join("");
  return `<article class="series-plex-issue">
    <div class="series-plex-issue-path" title="${esc(issue.path)}">${esc(issue.path)}</div>
    <ul class="series-plex-issue-list">${problems}</ul>
    ${issue.suggested ? `<div class="series-plex-suggest"><span>建议改为</span><code>${esc(issue.suggested)}</code><button class="btn btn-sm" type="button" data-suggest="${esc(issue.suggested)}" onclick="seriesPlexCopySuggestion(this)">复制</button></div>` : ""}
  </article>`;
}

function seriesPlexPanelHtml(lib, show, planData, missing) {
  if (!planData) {
    return `<div class="empty-tip">读不到多季方案：确认已登录，并让该媒体库完成一次扫描（索引里没有文件时方案也是空的）。</div>`;
  }
  const showPlan = seriesPlexShowInPlan(planData, show);
  const head = `<div class="series-plex-head">
    <div><b>${esc(show.title || "")}</b><small>${esc([show.year, `${(show.seasonList || []).length} 季`, `共 ${seriesShowEpisodeCount(show)} 集`].filter(Boolean).join(" · "))}</small></div>
    <div class="series-plex-actions">
      <label class="series-plex-check"><input type="checkbox" id="seriesPlexOverwriteLocal"> 覆盖本地 NFO</label>
      <button class="btn btn-sm" type="button" onclick="seriesPlexAction('refresh',${jsAttrArg(lib.id)},${jsAttrArg(show.key)})">刷新方案</button>
      <button class="btn btn-sm" type="button" onclick="seriesPlexAction('compare',${jsAttrArg(lib.id)},${jsAttrArg(show.key)})">比对官方集数</button>
      <button class="btn btn-sm btn-primary" type="button" onclick="seriesPlexAction('scrape',${jsAttrArg(lib.id)},${jsAttrArg(show.key)})">多季全量刮削</button>
      <button class="btn btn-sm" type="button" onclick="seriesPlexAction('dance',${jsAttrArg(lib.id)},${jsAttrArg(show.key)})">重匹配（Plex Dance）</button>
    </div>
  </div>`;
  if (!showPlan) {
    return head + `<div class="empty-tip">索引里还没识别到这部剧的多季结构：先重扫该媒体库，或按「剧集名 (年份)/Season XX/剧集名 - sXXeYY - 标题.ext」整理目录后重扫。</div>`;
  }
  const stats = `<div class="series-plex-stats">
    <span>${esc(showPlan.title)}${showPlan.year ? ` (${esc(showPlan.year)})` : ""}</span>
    <span>${Number(showPlan.season_count) || 0} 季</span>
    <span>${Number(showPlan.episode_num) || 0} 集</span>
    <span class="${Number(showPlan.issue_num) ? "series-plex-bad" : "series-plex-ok"}">命名问题 ${Number(showPlan.issue_num) || 0} 条</span>
    ${showPlan.multi_season ? `<span class="series-plex-ok">多季剧集</span>` : `<span>单季</span>`}
    ${showPlan.has_specials ? `<span>含特别篇</span>` : ""}
    <span>剧根：${esc((showPlan.dirs || []).join(" / ") || "—")}</span>
  </div>`;
  const rows = (showPlan.seasons || []).map(s => seriesPlexSeasonRow(lib, show, s, missing)).join("");
  const table = `<table class="series-plex-table"><thead><tr><th>季</th><th>本地</th><th>官方</th><th>缺失集</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
  const issues = (showPlan.issues || []);
  const issueBlock = issues.length
    ? `<section class="series-plex-section"><h4>命名体检（${issues.length} 条不符合 Plex 规范）</h4>
        <p class="series-plex-tip">规则：剧根目录「剧集名 (年份)」；每季一个 Season XX 子目录（特别篇用 Season 00 / Specials）；文件名「剧集名 - sXXeYY - 标题.ext」，多集合并用 sXXeYY-eZZ；<b>方括号内容会被 Plex 完全忽略</b>，季集号不要写在方括号里。</p>
        <div class="series-plex-issues">${issues.map(seriesPlexIssueRow).join("")}</div></section>`
    : `<section class="series-plex-section"><h4>命名体检</h4><p class="series-plex-tip">全部条目符合 Plex 命名规范。</p></section>`;
  const notes = ((planData.notes || []).concat((missing && missing.notes) || [])).map(n => `<li>${esc(n)}</li>`).join("");
  return head + stats + table + issueBlock +
    (notes ? `<section class="series-plex-section"><h4>说明</h4><ul class="series-plex-notes">${notes}</ul></section>` : "");
}

async function seriesPlexRenderPanel(force, hostId, libId, showKey) {
  const ctx = seriesPlexCtx(libId, showKey);
  const host = document.getElementById(hostId || (ctx && ctx.hostId) || "seriesPlexContent");
  if (!ctx || !host) return;
  const lib = findMediaLibrary(ctx.libId), show = readSeriesShow(ctx.libId, ctx.showKey);
  if (!lib || !show) { host.innerHTML = `<div class="empty-tip">这部剧的本地信息已丢失，请回到媒体库重新进入。</div>`; return; }
  const planData = await loadSeriesPlexPlan(ctx.libId, !!force);
  host.innerHTML = seriesPlexPanelHtml(lib, show, planData, seriesPlexMissingOf(ctx.libId, ctx.showKey));
}

async function openSeriesPlexPanel(libId, showKey) {
  const modal = document.getElementById("seriesPlexModal");
  const host = document.getElementById("seriesPlexContent");
  if (!modal || !host) return;
  activeSeriesPlex = { libId: String(libId || ""), showKey: String(showKey || ""), missing: null };
  host.innerHTML = `<div class="empty-tip">正在读取多季方案…</div>`;
  openModal("seriesPlexModal");
  await seriesPlexRenderPanel(false);
}

function closeSeriesPlexPanel() {
  activeSeriesPlex = null;
  closeModal("seriesPlexModal");
}

/* 面板按钮分发。 */
async function seriesPlexAction(action, libId, showKey) {
  const ctx = seriesPlexCtx(libId, showKey);
  if (!ctx) return;
  if (action === "refresh") { delete seriesPlexPlanCache[ctx.libId]; await seriesPlexRenderPanel(true, null, ctx.libId, ctx.showKey); return; }
  if (action === "compare") { await seriesPlexCompareMissing(ctx.libId, ctx.showKey); return; }
  if (action === "scrape") {
    const overwriteLocal = seriesPlexOverwriteLocal(activeSeriesPlex && activeSeriesPlex.scope);
    await scrapeSeriesAllSeasons(ctx.libId, ctx.showKey, { overwriteLocal });
    delete seriesPlexPlanCache[ctx.libId];
    await seriesPlexRenderPanel(true, null, ctx.libId, ctx.showKey);
    return;
  }
  if (action === "dance") { await seriesPlexRematch(ctx.libId, ctx.showKey); return; }
}

/* ==================== 七、系统设置 → 刮削配置：多季剧集刮削 ====================
   v0.9.98（客户要求）：「媒体主页季度选项中的『多季诊断』与『多季全量刮削』两个按钮
   和功能迁移到系统设置的刮削配置里」。所以剧集详情页不再挂工具条，统一在设置页操作：
   选库（必选）→ 选剧集或「全部剧集（整库）」→ 诊断 / 全量刮削 / 比对 / 重匹配。
   面板复用同一套渲染（seriesPlexPanelHtml），因此两边显示的口径完全一致。 */

let plexSettingsState = { libId: "", showKey: "", entries: [], busy: false };

function plexSettingsStatus(text, kind) {
  const el = document.getElementById("plexSettingsStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "badge" + (kind ? " " + kind : "");
}
function plexSettingsSeriesLibraries() {
  try { return (localMediaLibraries || []).filter(l => l && l.type === "series"); } catch (e) { return []; }
}
/* 进入刮削配置页时调用：填库下拉，并按当前选择刷新剧集下拉。 */
async function plexSettingsInit(force) {
  const libSel = document.getElementById("plexLibSelect");
  if (!libSel) return;
  const libs = plexSettingsSeriesLibraries();
  const keep = String(plexSettingsState.libId || libSel.value || "");
  libSel.innerHTML = libs.length
    ? libs.map(l => `<option value="${esc(l.id)}">${esc(l.name || l.id)}</option>`).join("")
    : `<option value="">（没有剧集媒体库）</option>`;
  const pick = libs.some(l => l.id === keep) ? keep : (libs[0] ? libs[0].id : "");
  libSel.value = pick;
  plexSettingsState.libId = pick;
  await plexSettingsLoadShows(!!force);
}
/* 读取该库的剧集清单（走整库文件列表 + 与媒体页同一套聚合，含原盘合并）。 */
async function plexSettingsLoadShows(force) {
  const libSel = document.getElementById("plexLibSelect");
  const showSel = document.getElementById("plexShowSelect");
  if (!libSel || !showSel) return;
  const libId = String(libSel.value || "");
  plexSettingsState.libId = libId;
  if (!libId) {
    showSel.innerHTML = `<option value="">全部剧集（整库）</option>`;
    plexSettingsState.entries = [];
    plexSettingsStatus("没有剧集媒体库", "warn");
    return;
  }
  plexSettingsStatus("正在读取剧集…");
  const keep = String(plexSettingsState.showKey || showSel.value || "");
  try {
    const files = await libraryScanLoadFiles(libId);
    const shows = buildSeriesShows(files || []);
    /* v0.9.98：把剧卡写进缓存 —— 详情页、逐季刮削与诊断面板都通过 readSeriesShow 取剧卡，
       只在这里 buildSeriesShows 而不缓存，会让设置页打开面板时显示「本地信息已丢失」
       （真实浏览器验证时抓到的空白面板）。 */
    try { shows.forEach(show => { syncSeriesShowMetadata(libId, show); rememberSeriesShow(libId, show); }); } catch (e) { /* 缓存失败不阻塞列表 */ }
    plexSettingsState.entries = shows.map(show => ({ key: show.key, title: show.title || show.key, seasons: (show.seasonList || []).length }));
    showSel.innerHTML = `<option value="">全部剧集（整库 · ${shows.length} 部）</option>` +
      shows.map(s => `<option value="${esc(s.key)}">${esc(s.title || s.key)}（${(s.seasonList || []).length} 季）</option>`).join("");
    showSel.value = shows.some(s => s.key === keep) ? keep : "";
    plexSettingsState.showKey = showSel.value;
    plexSettingsStatus(shows.length ? `已就绪：${shows.length} 部剧集` : "该库暂无剧集", shows.length ? "ok" : "warn");
  } catch (e) {
    plexSettingsState.entries = [];
    showSel.innerHTML = `<option value="">全部剧集（整库）</option>`;
    plexSettingsStatus(`读取失败：${e && e.message ? e.message : e}`, "warn");
  }
}
/* 当前操作对象：选中单剧只操作它，选「全部剧集」则遍历整库。 */
function plexSettingsTargets() {
  const showSel = document.getElementById("plexShowSelect");
  const libId = plexSettingsState.libId;
  if (!libId) return [];
  const picked = String((showSel && showSel.value) || "");
  if (picked) {
    const show = readSeriesShow(libId, picked);
    return show ? [{ libId, showKey: picked, title: show.title || picked }] : [];
  }
  return plexSettingsState.entries.map(e => ({ libId, showKey: e.key, title: e.title }));
}
async function plexSettingsRun(action) {
  if (plexSettingsState.busy) { toast("已有任务在执行，请稍候"); return; }
  const targets = plexSettingsTargets();
  const panel = document.getElementById("plexSettingsPanel");
  if (!targets.length) { toast("请先选择剧集媒体库（该库暂无剧集时先重扫媒体库）"); plexSettingsStatus("没有可操作对象", "warn"); return; }
  const scope = String((document.getElementById("plexShowSelect") || {}).value || "") ? "show" : "all";
  if (action === "compare" && targets.length > 1) { toast("「比对官方集数」只对单部剧生效：请在「刮削对象」里选一部剧"); plexSettingsStatus("请选择单部剧后再比对", "warn"); return; }
  plexSettingsState.busy = true;
  let done = 0;
  try {
    for (const t of targets) {
      plexSettingsStatus(`${action === "diagnose" ? "诊断" : action === "scrape" ? "全量刮削" : action === "compare" ? "比对" : "重匹配"} ${done + 1}/${targets.length}：${t.title}`);
      /* 面板上下文：设置页作用域（覆盖本地 NFO 由设置页下拉决定）。 */
      activeSeriesPlex = { libId: t.libId, showKey: t.showKey, scope: "settings", hostId: "plexSettingsPanel" };
      if (action === "diagnose") {
        delete seriesPlexPlanCache[t.libId];
        await plexSettingsRender(t);
      } else if (action === "scrape") {
        await scrapeSeriesAllSeasons(t.libId, t.showKey, { overwriteLocal: seriesPlexOverwriteLocal("settings") });
        delete seriesPlexPlanCache[t.libId];
        await plexSettingsRender(t);
      } else if (action === "compare") {
        await seriesPlexCompareMissing(t.libId, t.showKey);
      } else if (action === "dance") {
        await seriesPlexRematch(t.libId, t.showKey);
        await plexSettingsRender(t);
      }
      done++;
    }
    plexSettingsStatus(`完成 ${done}/${targets.length} 部${scope === "all" && targets.length > 1 ? "（整库）" : ""}`, "ok");
  } catch (e) {
    plexSettingsStatus(`出错：${e && e.message ? e.message : e}`, "warn");
    toast("⚠️ 多季操作出错：" + (e && e.message ? e.message : e));
  } finally {
    plexSettingsState.busy = false;
  }
}
/* 把一部剧的诊断面板渲染进设置页（整库时多部依次追加）。 */
async function plexSettingsRender(target) {
  const host = document.getElementById("plexSettingsPanel");
  if (!host) return;
  const lib = findMediaLibrary(target.libId), show = readSeriesShow(target.libId, target.showKey);
  if (!lib || !show) { host.innerHTML = `<div class="empty-tip">这部剧本地信息已丢失，请回媒体库重进一次。</div>`; return; }
  const planData = await loadSeriesPlexPlan(target.libId, true);
  const block = seriesPlexPanelHtml(lib, show, planData, seriesPlexMissingOf(target.libId, target.showKey));
  const append = plexSettingsState.planAppend && plexSettingsState.renderIndex > 0;
  host.innerHTML = append ? host.innerHTML + block : block;
  plexSettingsState.renderIndex = (plexSettingsState.renderIndex || 0) + 1;
}
