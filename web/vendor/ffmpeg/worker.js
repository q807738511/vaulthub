/* VaultHub browser software decoder worker.
 * Executes the self-hosted @ffmpeg/core 0.12.10 WebAssembly build. The core's
 * target_features section declares simd128; the main thread also rejects this
 * engine when the browser's SIMD capability probe fails.
 */
let corePromise;
function loadCore() {
  if (corePromise) return corePromise;
  importScripts("/web/vendor/ffmpeg/ffmpeg-core.js");
  corePromise = createFFmpegCore({
    noInitialRun: true,
    locateFile(path) {
      return path.endsWith(".wasm")
        ? "/web/vendor/ffmpeg/ffmpeg-core.wasm"
        : "/web/vendor/ffmpeg/" + path;
    },
    print() {},
    printErr(line) { self.postMessage({ type: "log", line: String(line) }); },
  });
  return corePromise;
}

self.onmessage = async event => {
  const message = event.data || {};
  if (message.type !== "transcode") return;
  const id = message.id;
  try {
    const core = await loadCore();
    const input = `input-${id}`;
    const output = `output-${id}.mp4`;
    core.FS.writeFile(input, new Uint8Array(message.bytes));
    // This is a real software decode + encode pipeline inside WebAssembly.
    // A short bounded segment prevents browser memory exhaustion on multi-GB media.
    const exitCode = core.exec(
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(Math.max(0, Number(message.start) || 0)),
      "-t", String(Math.max(5, Math.min(120, Number(message.duration) || 60))),
      "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", output,
    );
    if (exitCode !== 0) throw new Error(`FFmpeg WASM exited with code ${exitCode}`);
    const result = core.FS.readFile(output);
    const bytes = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
    try { core.FS.unlink(input); core.FS.unlink(output); } catch (_) {}
    self.postMessage({ type: "done", id, bytes }, [bytes]);
  } catch (error) {
    self.postMessage({ type: "error", id, error: String(error && (error.stack || error.message) || error) });
  }
};
