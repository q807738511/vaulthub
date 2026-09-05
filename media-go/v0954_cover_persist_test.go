package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

/* v0.9.56：封面持久化端点单测（真实 httptest 下载 + 落盘 + 读回）。 */

func TestV0954SniffImageExt(t *testing.T) {
	cases := map[string]string{
		"\xff\xd8\xff\xe0rest":     "jpg",
		"\x89PNG\r\n\x1a\nxxxx":     "png",
		"GIF89a....":                "gif",
		"RIFFxxxxWEBP":              "webp",
		"RIFFxxxx":                  "",
		"plain text not an image":   "",
	}
	for in, want := range cases {
		got := sniffImageExt([]byte(in))
		if got != want {
			t.Fatalf("sniff(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestV0954CoverSidecarRel(t *testing.T) {
	cases := []struct{ in, ext, want string }{
		{"One Piece v01.cbz", "jpg", "One Piece v01.cover.jpg"},
		{"dir/海贼王 第1卷.cbz", "png", "dir/海贼王 第1卷.cover.png"},
		{"a/b/c.mp3", "webp", "a/b/c.cover.webp"},
		{"weird.noext", "gif", "weird.cover.gif"},
	}
	for _, c := range cases {
		got := coverSidecarRel(c.in, c.ext)
		if got != c.want {
			t.Fatalf("coverSidecarRel(%q, %q) = %q, want %q", c.in, c.ext, got, c.want)
		}
	}
}

func TestV0954CoverSaveAndGet(t *testing.T) {
	dir := t.TempDir()
	mediaFile := filepath.Join(dir, "One Piece v01.cbz")
	if err := os.WriteFile(mediaFile, []byte("fake-cbz"), 0644); err != nil {
		t.Fatal(err)
	}
	// 远程封面源：返回一张 1x1 PNG。
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte("x"), 32)...)
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(png)
	}))
	defer src.Close()

	oldAuth := managerSessionOK
	managerSessionOK = func(r *http.Request) bool { return true }
	defer func() { managerSessionOK = oldAuth }()

	a := &App{libs: []Library{{ID: "comic1", Name: "漫画", Type: "comic", Path: dir}}, scraperProxy: src.URL}
	body, _ := json.Marshal(map[string]string{"id": "comic1", "path": "One Piece v01.cbz", "url": src.URL + "/cover.png"})
	req := httptest.NewRequest(http.MethodPost, "/api/media/cover", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	a.coverSave(rec, req)
	if rec.Code != 200 {
		t.Fatalf("coverSave status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Ok   bool   `json:"ok"`
		Path string `json:"path"`
		URL  string `json:"url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); !out.Ok || err != nil {
		t.Fatalf("coverSave response invalid: %v %s", err, rec.Body.String())
	}
	if out.Path != "One Piece v01.cover.png" {
		t.Fatalf("sidecar path = %q", out.Path)
	}
	side := filepath.Join(dir, "One Piece v01.cover.png")
	st, err := os.Stat(side)
	if err != nil {
		t.Fatalf("sidecar file missing: %v", err)
	}
	if st.Mode().Perm() != 0644 {
		t.Fatalf("sidecar mode = %v", st.Mode().Perm())
	}
	saved, _ := os.ReadFile(side)
	if !bytes.Equal(saved, png) {
		t.Fatal("sidecar bytes differ from source")
	}
	if out.URL == "" || !bytes.Contains([]byte(out.URL), []byte("/api/media/cover?id=comic1&path=One+Piece+v01.cover.png")) {
		t.Fatalf("local url malformed: %q", out.URL)
	}
	// GET 读回
	gre := httptest.NewRequest(http.MethodGet, out.URL, nil)
	grec := httptest.NewRecorder()
	a.coverGet(grec, gre)
	if grec.Code != 200 || grec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("coverGet status=%d ct=%q", grec.Code, grec.Header().Get("Content-Type"))
	}
	if !bytes.Equal(grec.Body.Bytes(), png) {
		t.Fatal("coverGet bytes differ")
	}
}

func TestV0954CoverSaveRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.cbz"), []byte("x"), 0644)
	oldAuth := managerSessionOK
	managerSessionOK = func(r *http.Request) bool { return true }
	defer func() { managerSessionOK = oldAuth }()
	a := &App{libs: []Library{{ID: "comic1", Name: "c", Type: "comic", Path: dir}}}

	// 未登录
	oldAuth2 := managerSessionOK
	managerSessionOK = func(r *http.Request) bool { return false }
	rec := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]string{"id": "comic1", "path": "a.cbz", "url": "http://example.com/x.jpg"})
	a.coverSave(rec, httptest.NewRequest(http.MethodPost, "/api/media/cover", bytes.NewReader(body)))
	if rec.Code != 401 {
		t.Fatalf("unauthenticated save should 401, got %d", rec.Code)
	}
	managerSessionOK = oldAuth2

	// 路径穿越 / 不存在
	rec = httptest.NewRecorder()
	body, _ = json.Marshal(map[string]string{"id": "comic1", "path": "../evil.cbz", "url": "http://example.com/x.jpg"})
	a.coverSave(rec, httptest.NewRequest(http.MethodPost, "/api/media/cover", bytes.NewReader(body)))
	if rec.Code != 404 {
		t.Fatalf("traversal should 404, got %d (%s)", rec.Code, rec.Body.String())
	}
	// 非法 URL
	rec = httptest.NewRecorder()
	body, _ = json.Marshal(map[string]string{"id": "comic1", "path": "a.cbz", "url": "ftp://x/y.jpg"})
	a.coverSave(rec, httptest.NewRequest(http.MethodPost, "/api/media/cover", bytes.NewReader(body)))
	if rec.Code != 400 {
		t.Fatalf("non-http url should 400, got %d", rec.Code)
	}
	// 非图片内容拒绝（走代理直连测试源，绕开直连模式的公网 IP 校验）
	badSrc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html>not an image</html>"))
	}))
	defer badSrc.Close()
	a.scraperProxy = badSrc.URL
	rec = httptest.NewRecorder()
	body, _ = json.Marshal(map[string]string{"id": "comic1", "path": "a.cbz", "url": badSrc.URL})
	a.coverSave(rec, httptest.NewRequest(http.MethodPost, "/api/media/cover", bytes.NewReader(body)))
	if rec.Code != 415 {
		t.Fatalf("non-image body should 415, got %d (%s)", rec.Code, rec.Body.String())
	}
}
