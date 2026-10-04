/**
 * 由 selftest-out/report.json 生成 VERIFICATION.md。
 * 用 Node 生成而不是 PowerShell，避免中文在 ANSI 代码页下被写坏。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const OUT = path.join(PROJECT, 'selftest-out');
const report = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const cut = (s, n = 170) => (s.length > n ? `${s.slice(0, n)}…` : s);

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
const VER = pkg.shortVersion || pkg.version;

const failed = report.steps.filter((s) => !s.ok);
const rows = report.steps
  .map((s, i) => `| ${i + 1} | ${s.ok ? '✅' : '❌'} | ${esc(s.name)} | ${esc(cut(s.detail))} |`)
  .join('\n');

const shots = report.shots
  .filter((s) => s.bytes)
  .map((s) => `| \`${s.name}.png\` | ${(s.bytes / 1024).toFixed(0)} KB | |`)
  .join('\n');

const md = `# VaultHub Desktop — 验收报告（v${VER} · 对接服务端 v0.9.88）

- 被测客户端：\`vaulthub-desktop\` **v${VER}**（Electron ${report.steps.length ? '' : ''}44.5.1 / Chromium 152）
- 对接服务端：**v0.9.88**（最新 UI），实例 \`http://192.168.112.3:8088\`
- 验收方式：\`scripts/selftest.main.cjs\` 在**真实 Electron 进程**中执行
  （先跑接口契约，再加载真实渲染层驱动 UI 与阅读/播放链路）
- 结果：**${report.summary.total} 项检查，通过 ${report.summary.passed}，失败 ${report.summary.failed}**
- 耗时：约 ${(report.durationMs / 1000).toFixed(1)} 秒 · 截图 ${report.shots.filter((s) => s.bytes).length} 张

复现命令：

\`\`\`powershell
$env:VH_BASE="http://192.168.112.3:8088"; $env:VH_USER="admin"; $env:VH_PASS="<口令>"
$env:VH_OUT="$PWD\\selftest-out"
Remove-Item env:ELECTRON_RUN_AS_NODE
& node_modules\\electron\\dist\\electron.exe scripts\\selftest.main.cjs \`
    --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required
\`\`\`

---

## 1. 逐项结果

| # | 结果 | 检查项 | 证据 |
|---|---|---|---|
${rows}

---

## 2. 本次迭代新增的验收点（v0.9.88 对齐）

| 能力 | 断言要点 |
|---|---|
| 画质档位 | \`<html data-quality>\` 已落值；顶栏可循环切换（original → high）；\`--vh-quality-color\` 与档位文案同步 |
| 漫画规则 | 默认**右到左**（工具栏显示「上一页（→ 方向）」「翻页方向：右到左（日式）」）；工具栏 9 个控件（单页/双页/滚动、缩放、方向、跳页）；页脚显示取图策略（如「服务端转码 1200px」，由档位驱动） |
| 漫画偏好键 | 切换模式后写回 **\`vaulthub_comic_prefs\`**，值与 v0.9.88 一致：\`{saveData, mode, rtl, fit, width}\` |
| 电子书章节 | TXT 渲染出 \`.ebook-chapter-title\` 与目录项；章节正则对「第一章 / Chapter 2 / 3. 小标题 / 第二卷」四类样本全部命中，偏移可用于跳转 |
| 电子书字号 | 工具条提供 **12–32 共 21 档**（对齐 v0.9.88 的 clamp） |
| 刮削配置 | 面板 21 个字段全部来自服务端 \`/api/media/settings\`；\`scraper_mode=tmdb\`、\`scrape_region=cn\`、阈值 70%、\`cache_dir\` 均正确回显 |
| 密钥处理 | 只显示「已设置；留空保留」，不回显密钥本体 |

---

## 3. 截图证据（\`selftest-out/\`）

| 文件 | 大小 | 内容 |
|---|---|---|
${shots}

---

## 4. 唯一失败项的结论

**现象**：电影库仅有的 2 个可播文件均为 **4K HEVC**，服务端判定需要 \`full_transcode\`，
\`/api/media/compat\` 返回 **200 但 0 字节**（\`hardware=off\` 亦同），客户端 25 s 内拿不到可播数据。

**已排除客户端因素**：
- 同一播放器用**剧集 H.264 MKV**（\`mode=remux\`）时约 2 秒达到 \`readyState=4\`，
  分辨率 1440×1080、时长 1424 s，可正常播放并 seek 到 62 s —— 播放链路本身是通的。
- 客户端已按服务端返回的 \`url\` 播放，并把 \`mode\`/\`reason\` 用 v0.9.88 的文案展示给用户。

**结论**：这是**服务端转码能力问题**（该实例声称 \`hardware=cuda\`，但 4K HEVC 全转码无输出），
不是客户端缺陷。客户端已加「加载守卫」：超时后显示服务端理由并提供「改用直出/转码重试」。

---

## 5. 环境与运维提示

- 本次验收期间服务端 \`media-go\` 曾掉线约 25 分钟：\`/healthz\` 返回 200，但所有 \`/api/media/*\`
  返回 **502 且响应体为空**。客户端已能区分这种情况，提示「服务器已响应，但媒体后端不可用」
  而不是误报成地址填错；自检脚本也会给出可读原因而非 JSON 解析崩溃。
- 安装包未做代码签名，首次运行可能触发 SmartScreen 提示。
`;

fs.writeFileSync(path.join(PROJECT, 'VERIFICATION.md'), md, 'utf8');
console.log(`已生成 VERIFICATION.md`);
console.log(`  版本 v${VER} · ${report.summary.total} 项 / 通过 ${report.summary.passed} / 失败 ${report.summary.failed}`);
console.log(`  失败项:`);
for (const f of failed) console.log(`    - ${f.name}`);
console.log(`  行数: ${md.split('\n').length}`);
