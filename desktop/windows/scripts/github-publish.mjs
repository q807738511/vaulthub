/**
 * 把 VaultHub Windows 桌面端发布到 GitHub 仓库的指定分支。
 *
 * 为什么不用 git：本机没有安装 git，且 github.com 不可达；
 * 只有 api.github.com 可达，所以走 GitHub REST 的 **Git Data API**
 * （blobs → tree → commit → ref），一次提交上传全部文件。
 *
 * 用法（token 从环境变量读取，不写入任何文件）：
 *   $env:GITHUB_TOKEN="github_pat_xxx"
 *   node scripts/github-publish.mjs --repo q807738511/vaulthub --branch windows-desktop \
 *        --prefix desktop/windows --message "feat(desktop): ..."
 *
 * 可选：--dry-run 只列出将要上传的文件，不调用写接口。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const REPO = arg('repo', 'q807738511/vaulthub');
const BRANCH = arg('branch', 'windows-desktop');
const PREFIX = String(arg('prefix', 'desktop/windows')).replace(/^\/+|\/+$/g, '');
const MESSAGE = arg('message', 'feat(desktop): VaultHub Windows 桌面客户端');
const DRY = !!arg('dry-run', false);
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const API = 'https://api.github.com';

/* 需要上传的内容：源码、脚本、文档与验收产物；
   排除依赖/构建产物/缓存（node_modules 与 234MB 的二进制不能进仓库）。
   .diag-data / .pkgdata 是 Electron 运行期产生的 Chromium 缓存目录（Code Cache、
   GPUCache、Cookies 等），属于本机运行残留，绝不能进仓库。 */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  '.cache',
  '.tmp',
  '.pkgdata',
  '.diag-data',
  '.smoke-data',
  '.git',
]);
const EXCLUDE_FILES = new Set(['pnpm-debug.log', 'diag.png', 'diag-play.png']);
/* 单文件上限：GitHub blobs 接口 100MB，这里保守取 40MB */
const MAX_FILE = 40 * 1024 * 1024;

function collect(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      // 验收产物里的 userdata 是运行残留，不要上传
      if (rel === 'selftest-out/userdata') continue;
      out.push(...collect(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (entry.name.endsWith('.log')) continue;
      out.push(rel);
    }
  }
  return out;
}

function contentType(name) {
  const e = path.extname(name).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml',
      '.json': 'application/json',
      '.md': 'text/markdown',
      '.yml': 'text/yaml',
      '.yaml': 'text/yaml',
    }[e] || 'text/plain'
  );
}

async function api(p, { method = 'GET', body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'vaulthub-desktop-publish',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（例如 502 网关页） */
  }
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 200);
    const err = new Error(`${method} ${p} -> ${res.status} ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

(async () => {
  if (!TOKEN && !DRY) {
    console.error('缺少 GITHUB_TOKEN / GH_TOKEN 环境变量（本脚本不把 token 写入任何文件）');
    process.exit(2);
  }

  const files = collect(PROJECT).sort();
  let total = 0;
  const plan = files.map((rel) => {
    const abs = path.join(PROJECT, rel);
    const size = fs.statSync(abs).size;
    total += size;
    return { rel, abs, size };
  });
  const tooBig = plan.filter((f) => f.size > MAX_FILE);
  console.log(`仓库:      ${REPO}`);
  console.log(`分支:      ${BRANCH}`);
  console.log(`前缀目录:  ${PREFIX || '(根目录)'}`);
  console.log(`文件数:    ${plan.length}`);
  console.log(`总大小:    ${(total / 1048576).toFixed(2)} MiB`);
  if (tooBig.length) {
    console.log(`超过 ${MAX_FILE / 1048576}MB 的文件（跳过）:`);
    for (const f of tooBig) console.log(`  ${(f.size / 1048576).toFixed(1)} MB  ${f.rel}`);
  }

  if (DRY) {
    console.log('\n--- dry-run 文件清单 ---');
    for (const f of plan) console.log(`  ${String(f.size).padStart(9)}  ${f.rel}`);
    console.log('\n(dry-run，未调用任何写接口)');
    return;
  }

  const repoInfo = await api(`/repos/${REPO}`);
  const baseBranch = repoInfo.default_branch || 'main';
  console.log(`\n默认分支:  ${baseBranch}`);

  // 1) 基线 commit / tree
  const baseRef = await api(`/repos/${REPO}/git/ref/heads/${baseBranch}`);
  const baseSha = baseRef.object.sha;
  const baseCommit = await api(`/repos/${REPO}/git/commits/${baseSha}`);
  const baseTree = baseCommit.tree.sha;
  console.log(`基线:      ${baseSha.slice(0, 8)}`);

  // 2) 上传 blobs
  const entries = [];
  let done = 0;
  for (const f of plan) {
    if (f.size > MAX_FILE) continue;
    const buf = fs.readFileSync(f.abs);
    const isText = /\.(js|cjs|mjs|json|md|yml|yaml|css|html|ps1|cmd|npmrc|txt|ts|sh|py)$/i.test(f.rel) || !buf.includes(0);
    const blob = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: isText && f.size < 2 * 1024 * 1024
        ? { content: buf.toString('utf8'), encoding: 'utf-8' }
        : { content: buf.toString('base64'), encoding: 'base64' },
    });
    const target = PREFIX ? `${PREFIX}/${f.rel}` : f.rel;
    entries.push({ path: target, mode: '100644', type: 'blob', sha: blob.sha });
    done += 1;
    if (done % 10 === 0 || done === plan.length) console.log(`  已上传 blob ${done}/${plan.length}`);
  }

  // 3) tree
  const tree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTree, tree: entries },
  });
  console.log(`tree:      ${tree.sha.slice(0, 8)}  (${entries.length} 项)`);

  // 4) commit
  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: { message: MESSAGE, tree: tree.sha, parents: [baseSha] },
  });
  console.log(`commit:    ${commit.sha.slice(0, 8)}`);

  // 5) 建分支或移动分支
  let existed = true;
  try {
    await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  } catch (e) {
    if (e.status === 404) existed = false;
    else throw e;
  }
  if (existed) {
    await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    console.log(`已更新分支 ${BRANCH}`);
  } else {
    await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${BRANCH}`, sha: commit.sha } });
    console.log(`已创建分支 ${BRANCH}`);
  }
  console.log(`\n完成：https://github.com/${REPO}/tree/${encodeURIComponent(BRANCH)}`);
})().catch((e) => {
  console.error(`\n失败: ${e.message}`);
  if (e.body?.errors) console.error(JSON.stringify(e.body.errors, null, 2));
  process.exit(1);
});
