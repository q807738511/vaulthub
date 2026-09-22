package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* v0.9.73：「历史阅读」必须能真正释放。
   用户报告已读收藏里的条目释放不掉（v0.9.70 只修了视图展开）。根因是服务端
   阅读进度库只增不减 —— 没有任何删除入口，前端能做的只有写一条 progress=0，
   而书架过滤（progress >= 99.9 才算已读）虽会把它算成未读，缓存/本地残留仍会
   把状态翻回来。这里锁定 DELETE 的语义：真删条目、幂等、按库隔离、路径受限。 */

func deleteProgress(t *testing.T, a *App, libID, path string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodDelete, "/api/media/reading/progress?id="+libID+"&path="+path, nil)
	a.readingProgress(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func getProgressItems(t *testing.T, a *App, libID string) map[string]readingProgressEntry {
	t.Helper()
	w := httptest.NewRecorder()
	a.readingProgress(w, httptest.NewRequest(http.MethodGet, "/api/media/reading/progress?id="+libID, nil))
	if w.Code != 200 {
		t.Fatalf("GET want 200 got %d: %s", w.Code, w.Body.String())
	}
	var out struct {
		Items map[string]readingProgressEntry `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Items
}

func TestV0973ReleaseRemovesEntryFromStore(t *testing.T) {
	withManagerSession(t)
	a, _ := newProgressApp(t)
	store := os.Getenv("MEDIA_READING_PROGRESS")

	if w := putProgress(t, a, "Book.txt", `{"progress":100,"page":120,"total":120}`); w.Code != 200 {
		t.Fatalf("PUT want 200 got %d: %s", w.Code, w.Body.String())
	}
	if got := getProgressItems(t, a, "books"); len(got) != 1 {
		t.Fatalf("已读条目应已写入，实际 %+v", got)
	}

	w, out := deleteProgress(t, a, "books", "Book.txt")
	if w.Code != 200 {
		t.Fatalf("DELETE want 200 got %d: %s", w.Code, w.Body.String())
	}
	if out["removed"] != true {
		t.Fatalf("DELETE 应回报 removed=true，实际 %+v", out)
	}
	if got := getProgressItems(t, a, "books"); len(got) != 0 {
		t.Fatalf("释放后进度库里必须不留条目（否则书架仍按已读统计），实际 %+v", got)
	}
	/* 直接读文件：不能只把 API 视图过滤掉，磁盘上也不能残留这条键。 */
	raw, err := os.ReadFile(store)
	if err != nil {
		t.Fatalf("reading store unreadable: %v", err)
	}
	if strings.Contains(string(raw), "Book.txt") {
		t.Fatalf("释放后磁盘仍残留条目：%s", raw)
	}
}

func TestV0973ReleaseIsIdempotent(t *testing.T) {
	withManagerSession(t)
	a, _ := newProgressApp(t)

	if w := putProgress(t, a, "Book.txt", `{"progress":100}`); w.Code != 200 {
		t.Fatalf("PUT want 200 got %d", w.Code)
	}
	if _, out := deleteProgress(t, a, "books", "Book.txt"); out["removed"] != true {
		t.Fatalf("首次释放应 removed=true，实际 %+v", out)
	}
	w, out := deleteProgress(t, a, "books", "Book.txt")
	if w.Code != 200 {
		t.Fatalf("重复释放必须是幂等 200，实际 %d: %s", w.Code, w.Body.String())
	}
	if out["removed"] != false {
		t.Fatalf("没有条目时释放应如实回报 removed=false，实际 %+v", out)
	}
	if got := getProgressItems(t, a, "books"); len(got) != 0 {
		t.Fatalf("重复释放后仍应无条目，实际 %+v", got)
	}
}

func TestV0973ReleaseScopesToLibrary(t *testing.T) {
	withManagerSession(t)
	a, _ := newProgressApp(t)
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "Comic.cbz"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	a.libs = append(a.libs, Library{ID: "comics", Name: "漫画", Type: "comic", Path: other})

	if w := putProgress(t, a, "Book.txt", `{"progress":100}`); w.Code != 200 {
		t.Fatalf("books PUT failed: %d", w.Code)
	}
	w := httptest.NewRecorder()
	a.readingProgress(w, httptest.NewRequest(http.MethodPut, "/api/media/reading/progress?id=comics&path=Comic.cbz", strings.NewReader(`{"progress":100}`)))
	if w.Code != 200 {
		t.Fatalf("comics PUT failed: %d %s", w.Code, w.Body.String())
	}

	if w, _ := deleteProgress(t, a, "books", "Book.txt"); w.Code != 200 {
		t.Fatalf("books DELETE failed: %d", w.Code)
	}
	if got := getProgressItems(t, a, "books"); len(got) != 0 {
		t.Fatalf("books 应已清空，实际 %+v", got)
	}
	if got := getProgressItems(t, a, "comics"); len(got) != 1 {
		t.Fatalf("释放 books 不得影响 comics，实际 %+v", got)
	}
}

func TestV0973ReleaseRejectsTraversalAndRequiresSession(t *testing.T) {
	withManagerSession(t)
	a, _ := newProgressApp(t)
	if w := putProgress(t, a, "Book.txt", `{"progress":100}`); w.Code != 200 {
		t.Fatalf("PUT want 200 got %d", w.Code)
	}

	if w, _ := deleteProgress(t, a, "books", "../escape.txt"); w.Code != 404 {
		t.Fatalf("穿越路径的释放必须 404，实际 %d", w.Code)
	}
	if got := getProgressItems(t, a, "books"); len(got) != 1 {
		t.Fatalf("被拒的释放不能动到真实条目，实际 %+v", got)
	}
	if w, _ := deleteProgress(t, a, "nope", "Book.txt"); w.Code != 404 {
		t.Fatalf("未知媒体库必须 404，实际 %d", w.Code)
	}

	old := managerSessionOK
	managerSessionOK = func(*http.Request) bool { return false }
	t.Cleanup(func() { managerSessionOK = old })
	if w, _ := deleteProgress(t, a, "books", "Book.txt"); w.Code != 401 {
		t.Fatalf("无会话的释放必须 401，实际 %d", w.Code)
	}
}

/* 释放后必须还能正常写入新进度：真删条目不能把进度库文件写坏。 */
func TestV0973ReleaseKeepsStoreWritable(t *testing.T) {
	withManagerSession(t)
	a, _ := newProgressApp(t)

	if w := putProgress(t, a, "Book.txt", `{"progress":100}`); w.Code != 200 {
		t.Fatalf("PUT want 200 got %d", w.Code)
	}
	if w, _ := deleteProgress(t, a, "books", "Book.txt"); w.Code != 200 {
		t.Fatalf("DELETE want 200 got %d", w.Code)
	}
	if w := putProgress(t, a, "Book.txt", `{"progress":12.5,"page":15,"total":120}`); w.Code != 200 {
		t.Fatalf("释放后重新写入必须成功，实际 %d: %s", w.Code, w.Body.String())
	}
	item, ok := getProgressItems(t, a, "books")["Book.txt"]
	if !ok || item.Progress != 12.5 || item.Page != 15 {
		t.Fatalf("重新写入的进度不完整：%+v ok=%v", item, ok)
	}
}
