/**
 * 用 GitHub Release 分发 Windows 安装包。
 *
 * 为什么必须走 Release 而不是提交进仓库：安装包 115 MiB，超过 GitHub 单文件 100 MB 上限，
 * Git Data API 会直接拒绝；Release 附件单文件上限 2 GB，是官方推荐的分发方式。
 *
 * 用法（token 从环境变量读取，不落盘）：
 *   $env:GITHUB_TOKEN="github_pat_xxx"
 *   node scripts/github-release.mjs --tag desktop-v0.1.0.0 --branch windows-desktop
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const DIST = path.join(PROJECT, 'dist');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const REPO = arg('repo', 'q807738511/vaulthub');
const TAG = String(arg('tag', 'desktop-v0.1.0.0'));
const BRANCH = String(arg('branch', 'windows-desktop'));
const NAME = String(arg('name', `VaultHub Desktop ${TAG.replace(/^desktop-v/, '')}`));
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

const auth = () => ({
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vaulthub-desktop-release',
  'X-GitHub-Api-Version': '2022-11-28',
});

async function api(base, p, { method = 'GET', body, raw } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...auth(),
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}),
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const e = new Error(`${method} ${p} -> ${res.status} ${json?.message || text.slice(0, 200)}`);
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return json;
}

(async () => {
  if (!TOKEN) {
    console.error('缺少 GITHUB_TOKEN');
    process.exit(2);
  }
  if (!fs.existsSync(DIST)) {
    console.error(`没有 dist 目录，请先执行 scripts\\build-win.ps1`);
    process.exit(2);
  }

  const assets = fs
    .readdirSync(DIST)
    .filter((f) => /\.(exe|blockmap|yml)$/i.test(f))
    .map((f) => ({ name: f, p: path.join(DIST, f), size: fs.statSync(path.join(DIST, f)).size }));
  if (!assets.length) {
    console.error('dist 里没有可发布的产物');
    process.exit(2);
  }
  console.log(`仓库: ${REPO}`);
  console.log(`Tag : ${TAG}`);
  console.log('产物:');
  for (const a of assets) console.log(`  ${(a.size / 1048576).toFixed(2)} MiB  ${a.name}`);

  // 复用或创建 release
  let rel = null;
  try {
    rel = await api(API, `/repos/${REPO}/releases/tags/${encodeURIComponent(TAG)}`);
    console.log(`\n已存在 Release: ${rel.id}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const body = [
    '## VaultHub Desktop 0.1.0.0（Windows x64）',
    '',
    '对接服务端 **v0.9.88** 的 Windows 桌面客户端。',
    '',
    '- 画质档位 / 漫画 / 电子书 / 影视播放规则对齐服务端 `web/js/03-quality.js`、`02-media.js`',
    '- 新增「刮削与缓存」设置页（`PUT /api/media/settings` 全字段同步）',
    '- 媒体浏览、视频播放（Range/转码）、漫画与电子书阅读、阅读进度跨端同步、音乐播放',
    '',
    '源码见分支 `windows-desktop` 的 `desktop/windows/`。',
    '',
    '> 安装包未做代码签名，首次运行可能触发 SmartScreen 提示。',
  ].join('\n');

  if (!rel) {
    rel = await api(API, `/repos/${REPO}/releases`, {
      method: 'POST',
      body: {
        tag_name: TAG,
        target_commitish: BRANCH,
        name: NAME,
        body,
        draft: false,
        prerelease: false,
      },
    });
    console.log(`已创建 Release: ${rel.id}  ${rel.html_url}`);
  } else {
    rel = await api(API, `/repos/${REPO}/releases/${rel.id}`, {
      method: 'PATCH',
      body: { name: NAME, body, target_commitish: BRANCH },
    });
    console.log(`已更新 Release: ${rel.id}`);
  }

  // 同名附件先删后传（Release 不允许重名）
  const existing = await api(API, `/repos/${REPO}/releases/${rel.id}/assets?per_page=100`);
  for (const a of existing || []) {
    if (assets.some((x) => x.name === a.name)) {
      await api(API, `/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
      console.log(`  已删除旧附件 ${a.name}`);
    }
  }

  for (const a of assets) {
    const buf = fs.readFileSync(a.p);
    const res = await api(
      UPLOADS,
      `/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(a.name)}`,
      { method: 'POST', body: buf, raw: true }
    );
    console.log(`  已上传 ${a.name}  ->  ${res.browser_download_url}`);
  }

  console.log(`\n完成：${rel.html_url}`);
})().catch((e) => {
  console.error(`\n失败: ${e.message}`);
  if (e.body?.errors) console.error(JSON.stringify(e.body.errors, null, 2));
  process.exit(1);
});
