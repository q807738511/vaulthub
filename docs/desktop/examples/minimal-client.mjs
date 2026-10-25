#!/usr/bin/env node
// VaultHub 最小客户端（Node 18+，零依赖）。跑通它再写界面，能排除大半「界面没问题但接口不对」。
//
//   BASE=http://<host>:8088 VH_USER=admin VH_PASS='***' node minimal-client.mjs [库ID]
//
// 演示四件事：
//   1. 会话 Cookie 的保存与复用（原生 HTTP 层，不是浏览器 fetch）
//   2. 库列表 / 文件分页
//   3. 播放决策（direct_play vs smart_stream）
//   4. 播放进度写入与读回（继续观看）
//
// 说明：这是 Node 版本；Tauri 里把 fetch 换成 reqwest（带 cookie_store），
// Electron 里换成主进程 net，逻辑一致。

const BASE = (process.env.BASE || "http://127.0.0.1:8088").replace(/\/$/, "");
const USER = process.env.VH_USER || "admin";
const PASS = process.env.VH_PASS || "";

let cookie = ""; // 生产环境请放系统钥匙串，不要放内存/日志

async function req(path, { method = "GET", body, raw = false } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const kv = c.split(";")[0];
    if (kv.startsWith("vh_session=")) cookie = kv;
  }
  if (res.status === 401) throw new Error("未登录或会话失效（401 login required）");
  if (res.status === 429) throw new Error("请求过频（429），不要重试");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 160)}`);
  }
  return raw ? res : res.json();
}

async function main() {
  if (!PASS) {
    console.error("缺少 VH_PASS");
    process.exit(2);
  }

  // 1. 公开端点：确认服务版本与认证模式
  const health = await req("/api/health");
  const mode = await req("/api/auth/mode");
  console.log(`服务 ${health.service} | 认证模式 ${mode.mode} | 默认会话 ${mode.session_default_days} 天`);

  // 2. 登录（服务端下发 vh_session，req() 已自动收进 cookie）
  const login = await req("/api/login", {
    method: "POST",
    body: { username: USER, password: PASS, keep_days: 30 },
  });
  console.log(`登录成功 | session_days=${login.session_days} | must_change=${login.must_change}`);

  // 3. 库列表
  const { libraries } = await req("/api/media/libraries");
  console.log(`媒体库 ${libraries.length} 个：${libraries.map((l) => `${l.id}(${l.type})`).join(", ")}`);
  const lib = process.argv[2] || libraries[0]?.id;
  if (!lib) throw new Error("没有可用媒体库");

  // 4. 文件分页
  const page = await req(`/api/media/files?id=${encodeURIComponent(lib)}&limit=5`);
  console.log(`库 ${lib}：total=${page.total} status=${page.status} version=${page.version?.slice(0, 8)}`);
  if (!page.files.length) throw new Error("库里没有文件");

  const file = page.files[0];
  console.log(`首个文件：${file.path}（${(file.size / 1024 / 1024).toFixed(1)} MB）`);

  // 5. 播放决策：按本机能力如实上报
  const plan = await req("/api/media/playback/plan", {
    method: "POST",
    body: {
      library_id: lib,
      path: file.path,
      quality: "auto",
      hardware: "auto",
      server_transcode: "auto",
      client: { mp4: true, mse: true, h264: true, hevc: false, vp9: false, aac: true, opus: false },
    },
  });
  console.log(`播放决策：${plan.layer}/${plan.mode} → ${plan.url}`);
  console.log(`  视频=${plan.video_action} 音频=${plan.audio_action} 原因=${plan.reason}`);

  // 6. 进度：写一条、读回、再删除（保持测试环境干净）
  await req(
    `/api/media/playback/progress?id=${encodeURIComponent(lib)}&path=${encodeURIComponent(file.path)}`,
    { method: "PUT", body: { position_ms: 61000, duration_ms: 600000 } },
  );
  const readback = await req(`/api/media/playback/progress?id=${encodeURIComponent(lib)}`);
  const entry = readback.items?.[file.path];
  console.log(`进度回读：${entry ? `${entry.position_ms}ms / ${entry.duration_ms}ms completed=${entry.completed}` : "缺失"}`);
  await req(
    `/api/media/playback/progress?id=${encodeURIComponent(lib)}&path=${encodeURIComponent(file.path)}`,
    { method: "DELETE" },
  );

  console.log("\nOK：登录 / 列表 / 决策 / 进度 四条链路打通");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
