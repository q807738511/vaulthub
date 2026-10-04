// 轮询服务端直到 media-go 恢复（/api/media/* 返回 200），或超时退出。
// 用途：等你重启容器后自动触发后续的端到端自检与发布。
const BASE = process.env.VH_BASE || 'http://192.168.112.3:8088';
const MAX_MIN = Number(process.env.VH_WAIT_MIN || 40);
const deadline = Date.now() + MAX_MIN * 60 * 1000;
const t0 = Date.now();

async function probe(path) {
  try {
    const r = await fetch(BASE + path, { headers: { 'accept-encoding': 'identity' } });
    const t = await r.text();
    return { status: r.status, len: t.length };
  } catch (e) {
    return { status: 0, err: e.message };
  }
}

let n = 0;
for (;;) {
  n += 1;
  const h = await probe('/healthz');
  const lib = await probe('/api/media/libraries');
  const settings = await probe('/api/media/settings');
  const ok = lib.status === 200 && lib.len > 0 && settings.status !== 502;
  const el = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[${String(el).padStart(4)}s] #${String(n).padStart(3)} healthz=${h.status} libraries=${lib.status}(${lib.len}B) settings=${settings.status} ${ok ? '<== 已恢复' : ''}`
  );
  if (ok) {
    console.log(`MEDIA_GO_READY after ${el}s`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.log(`TIMEOUT: 等待 ${MAX_MIN} 分钟仍未恢复（libraries=${lib.status} settings=${settings.status}）`);
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
