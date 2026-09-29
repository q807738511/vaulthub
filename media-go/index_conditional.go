package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
)

/* v0.9.82：/api/media/files 的条件请求支持 —— 远程（DDNS）访问提速。
 *
 * 问题（客户反馈「用 DDNS 反向代理访问非常慢，资源多时操作迟缓」）：
 *   该接口是全量媒体索引接口，库大时单次响应可达数 MB。旧实现每次响应都带
 *   Cache-Control: no-store，客户端每次切库/刷新/重进都要在 WAN 上把整份索引
 *   重传一遍，随后还要重新 JSON.parse + 重建整墙 DOM。
 *
 * 方案：
 *   1) 用「库内文件行数 + 最大 mtime + 排序/查询/分页」合成 ETag —— 索引一变
 *      （扫描写入新行、文件被替换导致 mtime 变化）ETag 立即变化，不需要额外状态；
 *      命中 If-None-Match 直接回 304 空体（WAN 上只跑几百字节）。
 *   2) 响应体额外带 version 字段（不含分页参数），客户端可以只拉 limit=1 的一页
 *      来便宜地判断「整库索引是否变过」，从而复用会话内已拉取的全量索引。
 *   Cache-Control 从 no-store 改为 private, no-cache：允许浏览器本地留存，
 *   但每次仍强制带 ETag 回源校验，索引变更不会被缓存盖住。
 */

const filesETagVersion = "fx1"

// libraryIndexVersion 生成与分页无关的索引版本（响应体 version 字段）。
func libraryIndexVersion(libID, order, q string, total int, maxMtime int64) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s|%s|%s|%d|%d|%s", libID, order, q, total, maxMtime, filesETagVersion)
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// filesETag 生成具体某个分页 URL 的实体标签。
func filesETag(version string, off, lim int) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s|%d|%d", version, off, lim)
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// writeIndexJSON 写下索引响应；version 为空时退回旧的 no-store 行为。
// 命中 If-None-Match 时回 304（不写响应体）。
func writeIndexJSON(w http.ResponseWriter, r *http.Request, version string, off, lim int, v any) {
	if version == "" {
		writeJSON(w, 200, v)
		return
	}
	tag := filesETag(version, off, lim)
	w.Header().Set("ETag", `"`+tag+`"`)
	w.Header().Set("Cache-Control", "private, no-cache")
	if ifNoneMatchSatisfied(r.Header.Get("If-None-Match"), tag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_ = json.NewEncoder(w).Encode(v)
}
