// 直接从 npmmirror 拉取 Electron 二进制并校验 SHA256，然后解压到 node_modules/electron/dist
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = '44.5.1';
const PLATFORM = 'win32-x64';
const MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const ZIP = path.join(CACHE, `electron-v${VERSION}-${PLATFORM}.zip`);
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

const zipUrl = `${MIRROR}${VERSION}/electron-v${VERSION}-${PLATFORM}.zip`;
const sumsUrl = `${MIRROR}${VERSION}/SHASUMS256.txt`;

fs.mkdirSync(CACHE, { recursive: true });

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let lastPct = -1;
  const out = fs.createWriteStream(dest);
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= lastPct + 5) {
      lastPct = pct;
      process.stdout.write(`  ${pct}% (${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MiB)\n`);
    }
  }
  await new Promise((r) => out.end(r));
}

(async () => {
  // 1) 期望的哈希
  const sumsTxt = await (await fetch(sumsUrl)).text();
  const line = sumsTxt.split(/\r?\n/).find((l) => l.includes(`electron-v${VERSION}-${PLATFORM}.zip`));
  if (!line) throw new Error(`SHASUMS256.txt 中未找到 ${PLATFORM} 条目`);
  const expect = line.trim().split(/\s+/)[0];
  console.log(`期望 SHA256: ${expect}`);

  // 2) 下载（已存在且校验通过则复用）
  let ok = false;
  if (fs.existsSync(ZIP)) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex');
    ok = h === expect;
    console.log(`缓存 zip ${ok ? '校验通过，复用' : '校验失败，重新下载'} (${h})`);
  }
  if (!ok) {
    console.log(`下载 ${zipUrl}`);
    await download(zipUrl, ZIP);
    const h = crypto.createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex');
    console.log(`实际 SHA256: ${h}`);
    if (h !== expect) throw new Error('SHA256 校验失败，拒绝使用该二进制');
    console.log('SHA256 校验通过');
  }

  // 3) 解压
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  console.log(`解压到 ${DIST}`);
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${DIST}' -Force`,
  ], { stdio: 'inherit' });

  // 4) path.txt（electron 的 index.js 读它来定位可执行文件）
  fs.writeFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'electron.exe', 'utf8');

  const exe = path.join(DIST, 'electron.exe');
  if (!fs.existsSync(exe)) throw new Error('解压后未找到 electron.exe');
  const size = fs.statSync(exe).size;
  console.log(`\n完成: ${exe} (${(size / 1048576).toFixed(1)} MiB)`);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
