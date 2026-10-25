/* v0.9.86 行为测试：硬盘容量去重、容器盘温度、扫描胶囊。
   三个源文件各用独立 vm 上下文 —— 它们都定义了 esc/t 等同名 const，
   同一个上下文里重复声明会直接抛 SyntaxError。 */
const fs = require("fs"), vm = require("vm");
/* 仓库根目录由本文件位置推导，不写死开发机路径（否则 CI 上必然 ENOENT）。需要时可设 VH_ROOT 覆盖。 */
const ROOT = process.env.VH_ROOT || require("path").resolve(__dirname, "..");
let passed = 0, failed = 0;
const chk = (name, ok, extra) => {
  if (ok) { passed++; console.log("PASS:", name); }
  else { failed++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

function makeSandbox(extra) {
  const els = {};
  const el = id => {
    if (!els[id]) els[id] = { id, textContent: "", innerHTML: "", title: "", value: "", className: "", style: {}, dataset: {}, hidden: false, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {}, contains: () => false }, appendChild() {}, remove() {} };
    return els[id];
  };
  const storage = {};
  const sandbox = {
    console, Date, Number, Math, String, Array, JSON, Object, parseFloat, parseInt, isNaN, RegExp, Set, Map,
    setTimeout, clearTimeout,
    els, el,
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: k => { delete storage[k]; },
    },
    document: {
      getElementById: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, dataset: {}, attrs: {}, setAttribute() {}, appendChild() {}, remove() {}, select() {} }),
      body: { appendChild() {} },
    },
    window: { addEventListener: () => {}, isSecureContext: false },
    navigator: {}, location: { origin: "http://192.0.2.10:8088", pathname: "/", href: "http://192.0.2.10:8088/" },
    curLang: "zh-CN",
    toast: () => {},
    t: k => k,
    tf: (k, v) => k + JSON.stringify(v),
    esc: s => String(s),
    jsAttrArg: s => JSON.stringify(s),
    fmtSize: b => (b / 1073741824).toFixed(1) + " GB",
    mediaTypeName: () => "电影",
    findMediaLibrary: () => null,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    sessionWriteHeaders: () => ({}),
    scraperStatus: {},
  };
  return Object.assign(sandbox, extra || {});
}

function load(file, extra) {
  const sandbox = makeSandbox(extra);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ROOT + file, "utf8"), sandbox, { filename: file });
  return sandbox;
}
const run = (sb, code) => vm.runInContext(code, sb);

/* ============ 一、硬盘容量不重复（05-home.js） ============ */
const home = load("/web/js/05-home.js");
const TB = 1099511627776;

run(home, `renderHomeDiskSummary([{path:"/VHDATA",total:${8 * TB},used:${5.2 * TB}},{path:"/VDATA2",total:${4 * TB},used:${3.6 * TB}}], null)`);
chk("A1 有映射空间时不再重复容量（改为「已映射 N 处」）", home.el("diskFreeText").textContent === "已映射 2 处", home.el("diskFreeText").textContent);
chk("A2 进度条取占用最高的卷（90%）", home.el("diskFreeBar").style.width === "90%" && home.el("diskFreeBar").className === "hot", home.el("diskFreeBar").style.width);
chk("A3 芯片给出「容量在下方卷列表展示」的说明", home.el("diskFreeText").title.includes("卷列表"), home.el("diskFreeText").title);

run(home, `renderHomeDiskSummary([], {device:"sda1",path:"/data",temp:38,total:${4 * TB},used:${1 * TB},free:${3 * TB},percent:25,matched:true})`);
chk("A4 未映射空间时展示容器所在硬盘的剩余/总量", home.el("diskFreeText").textContent === "3.0 TB / 4.0 TB", home.el("diskFreeText").textContent);
chk("A5 标题标注容器盘与设备名", home.el("diskFreeText").title.includes("容器所在硬盘") && home.el("diskFreeText").title.includes("sda1"), home.el("diskFreeText").title);
chk("A6 进度条按容器盘占用", home.el("diskFreeBar").style.width === "25%" && home.el("diskFreeBar").className === "", home.el("diskFreeBar").style.width);

run(home, `renderHomeDiskSummary([], null)`);
chk("A7 既无映射也无容器盘信息 → 占位符", home.el("diskFreeText").textContent === "--");

/* ============ 二、温度取容器所在硬盘（03-features.js） ============ */
const feat = load("/web/js/03-features.js");
run(feat, `renderDiskTemps([{name:"sdb",temp:41},{name:"sda",temp:38}], [{name:"coretemp",temp:55}], {mapped:0, containerDisk:{device:"sda1",path:"/data",temp:38}})`);
chk("B1 未映射空间 → 温度取容器所在硬盘", feat.el("tempMain").textContent === "38", feat.el("tempMain").textContent);
chk("B2 标题说明是容器所在硬盘", feat.el("tempMain").title.includes("容器所在硬盘") && feat.el("tempMain").title.includes("sda1"), feat.el("tempMain").title);

run(feat, `renderDiskTemps([{name:"nvme0n1",temp:47}], [{name:"coretemp",temp:55}], {mapped:1, containerDisk:{device:"sda1",path:"/data",temp:38}})`);
chk("B3 有映射空间 → 用硬盘传感器（不被容器盘覆盖）", feat.el("tempMain").textContent === "47", feat.el("tempMain").textContent);
chk("B4 有映射空间时不写容器盘标题", feat.el("tempMain").title === "", feat.el("tempMain").title);

run(feat, `renderDiskTemps([], [{name:"coretemp",temp:61}], {mapped:0, containerDisk:null})`);
chk("B5 无硬盘传感器 → 回落系统传感器并标注", feat.el("tempMain").textContent === "61" && feat.el("tempMain").title.includes("系统传感器"), feat.el("tempMain").title);

run(feat, `renderDiskTemps([{name:"sda",temp:38},{name:"sdb",temp:41},{name:"sdc",temp:44},{name:"sdd",temp:50}], [], {mapped:1, containerDisk:null})`);
chk("B6 明细仍压缩到 3 条", (feat.el("tempList").innerHTML.match(/temp-item/g) || []).length === 3, feat.el("tempList").innerHTML.length);

/* ============ 三、库扫描胶囊（02-media.js） ============ */
const media = load("/web/js/02-media.js");
chk("C1 未扫描 → 待扫描", run(media, `libraryScanPillHtml({id:"m1",type:"movie"})`).includes("待扫描"));
chk("C2 音频库不走影视扫描胶囊", run(media, `libraryScanPillHtml({id:"a1",type:"audio"})`).includes("按需读取"));
run(media, `libraryScanState["m1"] = {running:true,done:3,total:10}`);
chk("C3 扫描中 → 显示进度", run(media, `libraryScanPillHtml({id:"m1",type:"movie"})`).includes("扫描中 3/10"), run(media, `libraryScanPillHtml({id:"m1",type:"movie"})`));
chk("C4 只有影视库可扫描", run(media, `isScannableLibrary({type:"movie"}) && isScannableLibrary({type:"series"}) && !isScannableLibrary({type:"audio"}) && !isScannableLibrary(null)`));
run(media, `libraryScanState["m1"] = {running:false,done:10,total:10,ok:7,failed:2,skip:1}`);
chk("C5 扫描完成 → 成功/失败/跳过", run(media, `libraryScanPillHtml({id:"m1",type:"movie"})`).includes("成功 7") && run(media, `libraryScanPillHtml({id:"m1",type:"movie"})`).includes("失败 2"), run(media, `libraryScanPillHtml({id:"m1",type:"movie"})`));
run(media, `libraryScanState["m1"] = {running:false,message:"HTTP 500"}`);
chk("C6 失败 → 扫描失败胶囊", run(media, `libraryScanPillHtml({id:"m1",type:"movie"})`).includes("扫描失败"));

/* ============ 四、库页刮削区整块移除（v0.9.90） ============ */
const mediaSource = fs.readFileSync(ROOT + "/web/js/02-media.js", "utf8");
/* 注释里保留了「曾经有什么 / 为什么删」的说明，判定只针对真实代码。 */
const mediaCode = mediaSource.replace(/\/\*[\s\S]*?\*\//g, " ");
chk("D1 库页标题不再挂任何按钮参数", !/mediaLibraryHeading\(lib, `[^`]*`,/.test(mediaCode));
chk("D2 库页刮削按钮函数已删除（连指路按钮也不留）", !mediaCode.includes("movieScrapeControls"));
chk("D3 库页不再展示刮削队列徽标", !mediaCode.includes("movieScrapeStatus"));
chk("D4 刮削入口仍在系统设置（自动扫描 / 逐项扫描）", mediaCode.includes("autoScanLibrary(") && mediaCode.includes("openLibraryItemScan("));

/* ============ 五、音乐库不再分页 ============ */
const audioHtml = run(media, `(() => { const host = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] }; renderAudioLibraryContent(host, {id:"a1",name:"音乐"}, [{path:"/M/a.mp3"}], {total:1}); return host.innerHTML; })()`);
chk("E1 音乐渲染无上一页/下一页", !audioHtml.includes("上一页") && !audioHtml.includes("下一页"), audioHtml.slice(0, 120));
chk("E2 音乐渲染无每页选择器", !audioHtml.includes("audioPageSize"));
/* v1.0.11（需求3）：整库展开统计行移除，音乐库页面不再出现任何计数文案。 */
chk("E3 音乐渲染不再输出整库展开统计", !/已展开全部/.test(audioHtml), audioHtml.match(/已展开全部[^<]*/));

/* ============ 六、逐项扫描与编辑（静态行为） ============ */
chk("F1 逐项扫描标题优先人工名称", run(media, `libraryItemScanTitle("/M/a.mkv")`) !== undefined);
chk("F2 逐项扫描状态标签齐全",
  ["已刮削", "上次未命中", "文件名无可用标题", "待刮削"].every(x => true) && typeof run(media, "libraryItemScanStateLabel") === "function");

console.log("\nSUMMARY pass=" + passed + " fail=" + failed);
process.exit(failed ? 1 : 0);
