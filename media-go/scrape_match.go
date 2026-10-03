package main

import (
	"math"
	"strconv"
	"strings"
)

/* ==================== v0.9.88：标题匹配阈值（最低识别字符占比） ====================
客户要求：「TMDB 刮削配置优化，无需对标题进行全量刮削（最低识别字符数量为 70%，
如有异常后续进行手动调整命名进行辅助优化）」。

含义：不再要求候选标题与资源标题逐字全等，**70% 的字符能对上就算命中**；
剩下的异常条目靠「编辑名称 / 年份」手动辅助（override 文件已是跨设备持久化）。
阈值在服务端持久化（media-runtime.json 的 scrape_min_match），前端读取后
用于候选打分，因此换浏览器/换设备阈值一致。

本文件只负责服务端侧：读取环境变量、校验、归一化。
*/

// defaultScrapeMinMatch 与前端默认值一致（70%）。
const defaultScrapeMinMatch = 0.7

// scrapeMinMatchFloor / Ceil 限定可配置范围：低于 0.3 会大面积误匹配，
// 高于 1.0 则永远不可能命中（含标点的标题也会被全量要求）。
const (
	scrapeMinMatchFloor = 0.3
	scrapeMinMatchCeil  = 1.0
)

func envFloat(k string, d float64) float64 {
	raw := strings.TrimSpace(env(k, ""))
	if raw == "" {
		return d
	}
	if strings.HasSuffix(raw, "%") {
		if v, err := strconv.ParseFloat(strings.TrimSuffix(raw, "%"), 64); err == nil {
			return v / 100
		}
		return d
	}
	if v, err := strconv.ParseFloat(raw, 64); err == nil {
		return v
	}
	return d
}

func validScrapeMinMatch(v float64) bool {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return false
	}
	return v >= scrapeMinMatchFloor && v <= scrapeMinMatchCeil
}

// normalizeScrapeMinMatch 夹到合法区间并保留两位小数（0.55 → 55%）。
func normalizeScrapeMinMatch(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 {
		return defaultScrapeMinMatch
	}
	if v < scrapeMinMatchFloor {
		v = scrapeMinMatchFloor
	}
	if v > scrapeMinMatchCeil {
		v = scrapeMinMatchCeil
	}
	return math.Round(v*100) / 100
}
