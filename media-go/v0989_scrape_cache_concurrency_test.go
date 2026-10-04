package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

/* v0.9.89：刮削结果库的并发回归（只使用 HTTP 处理器这一层，因此同一份用例
 * 既能在修复后的代码上通过，也能在 v0.9.88 的旧实现上复现致命错误）。
 *
 * 背景（生产事故）：v0.9.88 的 GET/POST/DELETE 把共享 map 拿到锁外读/写，
 * 前端批量 POST 与界面 GET 并发时 Go 运行时抛
 *   fatal error: concurrent map writes
 * —— 不可 recover，整个 media-api 进程当场退出，Caddy 上游 127.0.0.1:9100
 * 拒连，全站 /api/* 变 502（客户看到「媒体库没了 / 新建报 502」）。
 *
 * 并发写 map 的 fatal 会直接终止整个测试二进制（没有 recover 机会），
 * 所以「测试进程存活 = 修复生效」。
 */

func newV0989App(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	for _, rel := range []string{"Water.Boys.2001/BDMV/STREAM/00000.m2ts", "Resume.Test.2019.1080p.mp4"} {
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a := &App{
		libs:            []Library{{ID: "movie1", Name: "电影", Type: "movie", Path: root}},
		scrapeCachePath: filepath.Join(root, "media-scrape-cache.json"),
	}
	return a, filepath.Join(root, "media-scrape-cache.json")
}

func TestV0989ScrapeCacheConcurrentAccess(t *testing.T) {
	a, cachePath := newV0989App(t)
	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return true }
	t.Cleanup(func() { managerSessionOK = old })

	const writers, readers, rounds, keysPerPost = 8, 8, 20, 240
	var wg sync.WaitGroup
	errs := make(chan string, writers*readers+8)

	// 与生产一致：前端一次批量写回几百条（旧实现就是在一次 300+ 条的写回里崩的）。
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				items := make(map[string]any, keysPerPost)
				for k := 0; k < keysPerPost; k++ {
					items[fmt.Sprintf("Water.Boys.2001/BDMV/STREAM/%05d.m2ts", w*1000+i*keysPerPost+k)] = map[string]any{
						"title":        fmt.Sprintf("并发写入 %d-%d-%d", w, i, k),
						"scrape_state": "ok",
						"checked_at":   1700000000000 + int64(i*keysPerPost+k),
					}
				}
				body, _ := json.Marshal(map[string]any{"id": "movie1", "items": items})
				rec := httptest.NewRecorder()
				a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodPost, "/api/media/scrape-cache", bytes.NewReader(body)))
				if rec.Code != 200 {
					errs <- fmt.Sprintf("POST %d-%d → HTTP %d %s", w, i, rec.Code, rec.Body.String())
				}
			}
		}(w)
	}
	for r := 0; r < readers; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				rec := httptest.NewRecorder()
				a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodGet, "/api/media/scrape-cache?id=movie1", nil))
				var out map[string]any
				if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil {
					errs <- fmt.Sprintf("GET → HTTP %d %s", rec.Code, rec.Body.String()[:min(80, rec.Body.Len())])
				}
			}
		}()
	}
	// delete 也是写 map：旧实现在并发下同样 fatal。
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 6; i++ {
			rec := httptest.NewRecorder()
			a.scrapeCacheHandler(rec, httptest.NewRequest(http.MethodDelete, "/api/media/scrape-cache?id=movie1", nil))
			if rec.Code != 200 {
				errs <- fmt.Sprintf("DELETE → HTTP %d", rec.Code)
			}
		}
	}()
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}

	raw, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatalf("结果库文件应存在：%v", err)
	}
	var parsed scrapeCacheFile
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("结果库文件必须是完整 JSON（不能是被并发写坏半截的文件）：%v (%d B)", err, len(raw))
	}
}
