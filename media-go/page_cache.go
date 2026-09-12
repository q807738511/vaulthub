package main

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

/* v0.9.67：归档「按页转码」磁盘缓存。
 *
 * 背景（实测）：漫画库里的扫描页平均 1.5–3.8 MB（1700×2450 量级），一本 261 页
 * 合计 918 MB。原样逐页下发在局域网很快（服务端解压仅 ~33ms/页），但在远程/蜂窝
 * 网络下会被单页体积拖死；同时这类扫描页多为 PNG/JPEG 无损存档，重编码为
 * JPEG 后可降到原来的 39%–56%。
 *
 * 因此新增「按页转码」能力：把某页解码 → 面积平均降采样 → JPEG 重编码 → 落盘，
 * 之后同一页命中磁盘缓存即 0 成本。缓存键内容寻址（含归档 size/mtime 与转码参数），
 * 归档一改键即变化，天然避免脏数据。
 *
 * 默认行为不变：只有显式带 w>0 的请求才转码；w=0 或缓存被禁用（上限 0）时
 * 一律原样直出，保证任何情况下都「永远能读」。
 */

const pageCacheKeyVersion = "pc1"

type pageCacheItem struct {
	path  string
	size  int64
	atime time.Time
}

type pageCache struct {
	mu       sync.Mutex
	dir      string
	maxBytes int64
	items    map[string]*pageCacheItem
	total    int64
	hits     uint64
	misses   uint64
}

func newPageCache(dir string, maxBytes int64) *pageCache {
	c := &pageCache{dir: dir, maxBytes: maxBytes, items: map[string]*pageCacheItem{}}
	c.rescan()
	return c
}

func (c *pageCache) enabled() bool { return c != nil && c.maxBytes > 0 && c.dir != "" }

// rescan 启动时重建索引：目录结构为 <dir>/<key前2位>/<key>.<ext>。
// 半成品（.tmp）与无法解析的文件一律清理，避免中断遗留占用配额。
func (c *pageCache) rescan() {
	if c == nil || !c.enabled() {
		return
	}
	shards, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, sh := range shards {
		if !sh.IsDir() {
			continue
		}
		ents, err := os.ReadDir(filepath.Join(c.dir, sh.Name()))
		if err != nil {
			continue
		}
		for _, ent := range ents {
			name := ent.Name()
			full := filepath.Join(c.dir, sh.Name(), name)
			if filepath.Ext(name) == ".tmp" {
				_ = os.Remove(full)
				continue
			}
			dot := indexByte(name, '.')
			if dot <= 0 {
				continue
			}
			info, err := ent.Info()
			if err != nil {
				continue
			}
			key := name[:dot]
			c.items[key] = &pageCacheItem{path: full, size: info.Size(), atime: info.ModTime()}
			c.total += info.Size()
		}
	}
	c.evictLocked("")
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// get 命中返回磁盘路径（同时刷新 LRU 访问时间）。
func (c *pageCache) get(key string) (string, bool) {
	if c == nil || !c.enabled() {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	it, ok := c.items[key]
	if !ok {
		c.misses++
		return "", false
	}
	if fi, err := os.Stat(it.path); err != nil || fi.Size() != it.size {
		// 文件被外部清理或长度不符：视为未命中并摘除索引。
		delete(c.items, key)
		c.total -= it.size
		c.misses++
		return "", false
	}
	it.atime = time.Now()
	c.hits++
	return it.path, true
}

// put 原子写入并纳入 LRU（超配额时按最久未访问淘汰）。
func (c *pageCache) put(key string, data []byte, ext string) (string, bool) {
	if c == nil || !c.enabled() || len(data) == 0 || len(key) < 3 {
		return "", false
	}
	shard := filepath.Join(c.dir, key[:2])
	if err := os.MkdirAll(shard, 0o755); err != nil {
		return "", false
	}
	final := filepath.Join(shard, key+"."+ext)
	/* tmp 名带随机后缀：并发（或极端情况下重复 leader）写同一 key 时不会互相截断。 */
	tmp := fmt.Sprintf("%s.%d.tmp", final, time.Now().UnixNano())
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", false
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.items[key]; ok {
		c.total -= old.size
	}
	c.items[key] = &pageCacheItem{path: final, size: int64(len(data)), atime: time.Now()}
	c.total += int64(len(data))
	/* 淘汰时保护刚写入的条目：否则「单页比配额还大」或配额很小时，会把自己刚写好的
	   文件删掉，调用方却以为落盘成功（随后按缓存路径下发 → 404）。 */
	c.evictLocked(key)
	if it, ok := c.items[key]; ok && it.path == final {
		return final, true
	}
	// 极端情况：仍被淘汰（配额小于条目）→ 报告未缓存，调用方回落直出。
	return "", false
}

/* evictLocked 淘汰到配额之内。留下 10% 余量，避免每次写入都触发淘汰。
   protect 指定的键（本次刚写入的条目）不会被淘汰。
   审查建议：不要在持锁期间做文件 IO —— 先摘除映射并统计配额，锁外再 unlink，
   否则批量淘汰会阻塞所有并发的 get/put。 */
func (c *pageCache) evictLocked(protect string) {
	if c.maxBytes <= 0 || c.total <= c.maxBytes {
		return
	}
	target := c.maxBytes - c.maxBytes/10
	type kv struct {
		key string
		it  *pageCacheItem
	}
	all := make([]kv, 0, len(c.items))
	for k, v := range c.items {
		all = append(all, kv{k, v})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].it.atime.Before(all[j].it.atime) })
	victims := make([]string, 0, 8)
	for _, x := range all {
		if c.total <= target {
			break
		}
		if protect != "" && x.key == protect {
			continue
		}
		delete(c.items, x.key)
		c.total -= x.it.size
		victims = append(victims, x.it.path)
	}
	if len(victims) > 0 {
		go func(paths []string) {
			for _, p := range paths {
				_ = os.Remove(p)
			}
		}(victims)
	}
}

func (c *pageCache) stats() (int, int64, uint64, uint64) {
	if c == nil {
		return 0, 0, 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items), c.total, c.hits, c.misses
}

// pageCacheKey 内容寻址键：归档身份（路径+size+mtime）+ 条目 + 转码参数 + 版本。
func pageCacheKey(libID, archivePath, entry string, zipSize, zipMtime int64, width, quality int) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s|%s|%s|%d|%d|%d|%d|%s", libID, archivePath, entry, zipSize, zipMtime, width, quality, pageCacheKeyVersion)
	return hex.EncodeToString(h.Sum(nil))
}
