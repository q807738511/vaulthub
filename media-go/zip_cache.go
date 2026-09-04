package main

import (
	"archive/zip"
	"container/list"
	"os"
	"sync"
)

// zipCacheEntry 缓存一次 ZIP/CBZ 中央目录解析结果（条目列表 + 展示名 + 索引）。
// 漫画翻页/首屏会连续请求同一归档的目录与每个页面条目；旧实现每次请求都重新
// zip.OpenReader 全量解析目录并逐条 iconv 解码文件名（decodeZipNames），
// 大压缩包 + 非 UTF-8 文件名时单页请求就要付出整个归档的解析代价。
// v0.9.53：同一归档的目录解析只做一次，后续请求直接复用内存索引。
type zipCacheEntry struct {
	rc      *zip.ReadCloser
	files   []*zip.File
	display []string
	rawIdx  map[string]int
	showIdx map[string]int
}

// indexOf 返回 raw 名或 decode 展示名（老前端链接用 raw 名）对应的条目下标。
func (e *zipCacheEntry) indexOf(want string) int {
	if i, ok := e.rawIdx[want]; ok {
		return i
	}
	if i, ok := e.showIdx[want]; ok {
		return i
	}
	return -1
}

type cachedZip struct {
	path    string
	size    int64
	mod     int64
	ent     *zipCacheEntry
	refs    int  // in-flight 请求数；>0 时淘汰只标记 closing，等归零再关句柄
	closing bool // 已被替换/淘汰，refs 归零后立即 Close
}

// zipArchiveCache 是进程内 LRU：path -> 打开的归档。条目按 (size, mtime)
// 与磁盘核对，文件被替换/删除时自动重开，旧句柄在无请求引用后关闭。
type zipArchiveCache struct {
	mu      sync.Mutex
	cap     int
	items   map[string]*list.Element // path -> lru element (value *cachedZip)
	lru     *list.List
	orphans map[*zip.ReadCloser]int // 已被逐出但仍有请求在用的句柄：refs 归零时 Close
}

func newZipArchiveCache(capacity int) *zipArchiveCache {
	if capacity < 1 {
		capacity = 1
	}
	return &zipArchiveCache{
		cap:     capacity,
		items:   map[string]*list.Element{},
		lru:     list.New(),
		orphans: map[*zip.ReadCloser]int{},
	}
}

// acquire 返回 path 的缓存条目并 +1 引用；响应结束后必须调用 release。
func (c *zipArchiveCache) acquire(path string) (*zipCacheEntry, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	cur := fi.Size()
	mod := fi.ModTime().UnixNano()
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[path]; ok {
		cz := el.Value.(*cachedZip)
		if cz.size == cur && cz.mod == mod {
			cz.refs++
			c.lru.MoveToFront(el)
			return cz.ent, nil
		}
		c.dropLocked(el)
	}
	rc, err := zip.OpenReader(path)
	if err != nil {
		return nil, err
	}
	ent := parseZipEntries(rc)
	cz := &cachedZip{path: path, size: cur, mod: mod, ent: ent, refs: 1}
	c.items[path] = c.lru.PushFront(cz)
	for c.lru.Len() > c.cap {
		c.dropLocked(c.lru.Back())
	}
	return ent, nil
}

// release 归还一次引用；closing 且无引用时真正关闭句柄。
func (c *zipArchiveCache) release(ent *zipCacheEntry) {
	if ent == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for el := c.lru.Front(); el != nil; el = el.Next() {
		cz := el.Value.(*cachedZip)
		if cz.ent != ent {
			continue
		}
		cz.refs--
		if cz.refs <= 0 && cz.closing {
			c.dropLocked(el)
		}
		return
	}
	if n, ok := c.orphans[ent.rc]; ok {
		if n <= 1 {
			delete(c.orphans, ent.rc)
			_ = ent.rc.Close()
		} else {
			c.orphans[ent.rc] = n - 1
		}
	}
}

// dropLocked 从表与 LRU 移除 cz；仍有请求引用时挂入 orphans，等 release 关闭。
func (c *zipArchiveCache) dropLocked(el *list.Element) {
	cz := el.Value.(*cachedZip)
	delete(c.items, cz.path)
	c.lru.Remove(el)
	if cz.refs <= 0 {
		_ = cz.ent.rc.Close()
	} else {
		cz.closing = true
		c.orphans[cz.ent.rc] = cz.refs
	}
}

// parseZipEntries 把打开的归档解析为顺序条目（与历史 archive() 行为一致：跳过目录）。
// decodeZipNames 只在这里跑一次，而非每次页面请求都跑。
func parseZipEntries(rc *zip.ReadCloser) *zipCacheEntry {
	files := make([]*zip.File, 0, len(rc.File))
	rawNames := make([]string, 0, len(rc.File))
	for _, x := range rc.File {
		if x.FileInfo().IsDir() {
			continue
		}
		files = append(files, x)
		rawNames = append(rawNames, x.Name)
	}
	display := decodeZipNames(rawNames)
	rawIdx := make(map[string]int, len(files))
	showIdx := make(map[string]int, len(files))
	for i, x := range files {
		if _, ok := rawIdx[x.Name]; !ok {
			rawIdx[x.Name] = i
		}
		if _, ok := showIdx[display[i]]; !ok {
			showIdx[display[i]] = i
		}
	}
	return &zipCacheEntry{rc: rc, files: files, display: display, rawIdx: rawIdx, showIdx: showIdx}
}
