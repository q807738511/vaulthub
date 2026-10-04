/* ============================================================================
   路径索引：记录各库已翻页过的文件路径。
   用途：定位同目录下的旁挂字幕（.srt/.ass/.vtt）等文件 —— 服务端没有目录列举端点，
   只能从 /api/media/files 的分页结果里积累。
   ========================================================================= */

const registry = new Map(); // libId -> Set<path>

export function registerPaths(libId, paths) {
  let set = registry.get(libId);
  if (!set) registry.set(libId, (set = new Set()));
  for (const p of paths) set.add(p);
}

export function allPaths(libId) {
  return registry.get(libId) || new Set();
}

const SUB_EXT = ['.srt', '.ass', '.ssa', '.vtt', '.sub'];

/**
 * 找视频的同目录旁挂字幕。
 * @returns {Array<{path:string, name:string}>}
 */
export function findSubtitles(libId, videoPath) {
  const dir = videoPath.includes('/') ? videoPath.slice(0, videoPath.lastIndexOf('/')) : '';
  const stem = videoPath.slice(dir ? dir.length + 1 : 0).replace(/\.[^.]+$/, '');
  const out = [];
  for (const p of allPaths(libId)) {
    const pdir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (pdir !== dir) continue;
    const lower = p.toLowerCase();
    if (!SUB_EXT.some((e) => lower.endsWith(e))) continue;
    const pstem = p.slice(pdir ? pdir.length + 1 : 0).replace(/\.[^.]+$/, '');
    // 同名优先，其次是 language 后缀（movie.zh.srt）
    if (pstem === stem || pstem.startsWith(`${stem}.`) || pstem.startsWith(`${stem}_`)) {
      out.push({ path: p, name: p.slice(pdir ? pdir.length + 1 : 0) });
    }
  }
  if (!out.length) {
    // 退一步：同目录任意字幕（很多发布组只给一个）
    for (const p of allPaths(libId)) {
      const pdir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      if (pdir !== dir) continue;
      if (SUB_EXT.some((e) => p.toLowerCase().endsWith(e))) {
        out.push({ path: p, name: p.slice(pdir ? pdir.length + 1 : 0) });
      }
    }
  }
  return out.slice(0, 8);
}

/** 找同目录下的其他视频（上一集/下一集） */
export function siblings(libId, videoPath, isVideoFn) {
  const dir = videoPath.includes('/') ? videoPath.slice(0, videoPath.lastIndexOf('/')) : '';
  const list = [...allPaths(libId)].filter((p) => {
    const pdir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    return pdir === dir && isVideoFn(p);
  });
  list.sort((a, b) => a.localeCompare(b, 'zh'));
  return list;
}

export function clearRegistry() {
  registry.clear();
}
