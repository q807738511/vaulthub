package main

import (
	"path/filepath"
	"strconv"
	"strings"
)

/* v1.0.8（需求7）：刮削结果落到媒体同目录。
 *
 * 背景：v0.9.88 起影视刮削结果存在 /data/media-scrape-cache.json，v0.9.89 的 NFO
 * 写盘是由**浏览器**在浏览时顺带触发的（queueMovieLocalization）。实际后果是：
 *   · 只在打开过的条目上才写 NFO，整库刮完但没人翻过的条目永远没有 NFO；
 *   · 桌面客户端 / 其它播放器直接读写媒体目录时看不到任何刮削产物；
 *   · 换设备重装要重新联网刮一遍。
 * 这里把写盘挪到服务端：POST /api/media/scrape-cache 落库之后顺手写 NFO。
 *
 * 边界：
 *   · 只处理影视库（movie / series）；书籍/漫画/音乐各有自己的 sidecar 通道。
 *   · 路径必须落在库根内（safeFile）；只写 .nfo，文件名由服务端派生。
 *   · 不覆盖已有 NFO（writeNFOFile(overwrite=false)）：用户手写或其它刮削器写的一律保留。
 *   · 每条独立失败，不阻断批量；返回计数供接口回显。
 */
func (a *App) persistScrapeNFO(libID string, items map[string]scrapeCacheItem) (written, kept int) {
	lib, ok := a.find(libID)
	if !ok {
		return 0, 0
	}
	switch lib.Type {
	case "movie", "series":
	default:
		return 0, 0
	}
	for path, item := range items {
		if strings.TrimSpace(item.Title) == "" && strings.TrimSpace(item.ShowTitle) == "" {
			continue
		}
		if st := strings.ToLower(strings.TrimSpace(item.State)); st != "" && st != "ok" {
			continue
		}
		abs, _, err := safeFile(lib, path)
		if err != nil {
			continue
		}
		stem := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
		if stem == "" {
			continue
		}
		meta := nfoWriteMeta{
			Title:     firstNonEmptyStr(item.Title, item.ShowTitle, stem),
			ShowTitle: item.ShowTitle,
			Year:      item.Year,
			Overview:  item.Overview,
			Rating:    item.Rating,
			Poster:    nfoPortableArtURL(item.Poster, path),
			Fanart:    nfoPortableArtURL(item.Fanart, path),
			Backdrop:  nfoPortableArtURL(item.Backdrop, path),
			Logo:      nfoPortableArtURL(item.Logo, path),
		}
		if item.TMDBID > 0 {
			meta.TMDBID = strconv.FormatInt(item.TMDBID, 10)
		}
		if item.TVDBID > 0 {
			meta.TVDBID = strconv.FormatInt(item.TVDBID, 10)
		}
		doc := nfoBuildDoc(meta)

		targets := []string{}
		if mainAbs, _, err := nfoResolveTarget(lib, path, stem+".nfo", 0); err == nil {
			targets = append(targets, mainAbs)
		}
		extra := "movie.nfo"
		up := 0
		if lib.Type == "series" {
			extra, up = "tvshow.nfo", 1
		}
		if exAbs, _, err := nfoResolveTarget(lib, path, extra, up); err == nil {
			if !strings.EqualFold(extra, "movie.nfo") || nfoDirMediaCount(filepath.Dir(exAbs)) == 1 {
				targets = append(targets, exAbs)
			}
		}
		seen := map[string]bool{}
		for _, t := range targets {
			if seen[t] {
				continue
			}
			seen[t] = true
			wrote, keep, _, err := writeNFOFile(t, doc, false)
			if err != nil {
				continue
			}
			if wrote {
				written++
			}
			if keep {
				kept++
			}
		}
	}
	return written, kept
}


/* firstNonEmptyStr 取第一个非空白值（douban.go 的 firstNonEmpty 签名不同，避免重名）。 */
func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
