package main

/* v1.0.3（需求2）：NFO 识别加固 + 外置 NFO 与内置刮削的合并写回。
 *
 * 覆盖点：
 *   A. 外置 NFO（用户手写）与刮削结果冲突 → 保留原值、补齐缺失、冲突不覆盖；
 *   B. 已经完整的外置 NFO → 一个字节都不写（kept）；
 *   C. 无法解析的 NFO → 绝不破坏；
 *   D. VaultHub 自己写的 NFO → 仍按新结果整份重写（刮削更新能落地）；
 *   E. BOM / UTF-16 编码的 NFO 能被解析（识别加固）；
 *   F. `Movie.NFO` 这类大写扩展名能被找到（大小写不敏感兜底）；
 *   G. 演员/类型按语义键去重，不产生重复节点。
 */

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func v1003Doc() nfoWriteDoc {
	return nfoWriteDoc{
		Title:         "刮削标题",
		OriginalTitle: "Scraped Title",
		Year:          "2024",
		Premiered:     "2024-05-01",
		Plot:          "刮削简介：一段完整剧情。",
		Outline:       "短简介",
		Runtime:       "120",
		Rating:        "8.6",
		Genres:        []string{"动作", "科幻"},
		Actors: []nfoActor{
			{Name: "张三", Role: "主角", Thumb: "https://img.example.com/a.jpg"},
			{Name: "李四", Role: "配角"},
		},
		UniqueIDs: []nfoUniqueID{{Type: "tmdb", Value: "123456"}},
		Thumbs:    []nfoThumb{{Aspect: "poster", Value: "poster.jpg"}},
	}
}

func v1003Write(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

// A：冲突保留 + 缺失互补 + 未知节点/注释原样保留。
func TestV1003MergeKeepsExternalAndFillsMissing(t *testing.T) {
	dir := t.TempDir()
	p := v1003Write(t, dir, "movie.nfo", `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <!-- 用户手写，别删我 -->
  <title>用户标题</title>
  <studio>HBO</studio>
  <genre>动作</genre>
</movie>
`)
	written, kept, mr, err := writeNFOFile(p, v1003Doc(), false)
	if err != nil {
		t.Fatalf("merge err: %v", err)
	}
	if !written || kept {
		t.Fatalf("应合并写回: written=%v kept=%v", written, kept)
	}
	if !containsStr(mr.Conflicts, "title") {
		t.Fatalf("title 冲突未记录: %+v", mr.Conflicts)
	}
	for _, want := range []string{"plot", "actor:张三", "actor:李四", "uniqueid:tmdb", "genre:科幻"} {
		if !containsStr(mr.Merged, want) {
			t.Fatalf("缺少补入字段 %q，实际 %+v", want, mr.Merged)
		}
	}
	b, _ := os.ReadFile(p)
	got := string(b)
	if !strings.Contains(got, "用户标题") || strings.Contains(got, "刮削标题") {
		t.Fatalf("原有标题应保留且不被覆盖:\n%s", got)
	}
	for _, want := range []string{"HBO", "别删我", "刮削简介", "<name>张三</name>", "<uniqueid type=\"tmdb\">123456</uniqueid>"} {
		if !strings.Contains(got, want) {
			t.Fatalf("合并结果缺少 %q:\n%s", want, got)
		}
	}
	if n := strings.Count(got, "<genre>动作</genre>"); n != 1 {
		t.Fatalf("genre 去重失败，出现 %d 次", n)
	}
	if !strings.HasSuffix(strings.TrimSpace(got), "</movie>") {
		t.Fatalf("根闭合标签被破坏:\n%s", got)
	}
}

// B：字段齐全时零写入。
func TestV1003MergeNoopWhenComplete(t *testing.T) {
	dir := t.TempDir()
	body := `<movie><title>全都有了</title><plot>简介</plot><year>2024</year>
<genre>动作</genre><genre>科幻</genre>
<actor><name>张三</name><role>主角</role></actor><actor><name>李四</name></actor>
<uniqueid type="tmdb">123456</uniqueid><thumb aspect="poster">poster.jpg</thumb>
<originaltitle>Scraped Title</originaltitle><premiered>2024-05-01</premiered>
<outline>短简介</outline><runtime>120</runtime><rating>8.6</rating></movie>`
	p := v1003Write(t, dir, "movie.nfo", body)
	written, kept, mr, err := writeNFOFile(p, v1003Doc(), false)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if written || !kept || mr.Changed {
		t.Fatalf("字段齐全不应写盘: written=%v kept=%v changed=%v", written, kept, mr.Changed)
	}
	if b, _ := os.ReadFile(p); string(b) != body {
		t.Fatalf("文件被改动")
	}
}

// C：无法解析 → 保持原样。
func TestV1003UnparsableNFOUntouched(t *testing.T) {
	dir := t.TempDir()
	body := "这不是 XML，只是用户随手记的笔记\n"
	p := v1003Write(t, dir, "movie.nfo", body)
	written, kept, _, err := writeNFOFile(p, v1003Doc(), false)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if written || !kept {
		t.Fatalf("不可解析应 kept: written=%v kept=%v", written, kept)
	}
	if b, _ := os.ReadFile(p); string(b) != body {
		t.Fatalf("不可解析文件被改动")
	}
}

// D：VaultHub 自己的 NFO 仍整份重写。
func TestV1003VaultHubOwnedNFORewrites(t *testing.T) {
	dir := t.TempDir()
	p := v1003Write(t, dir, "movie.nfo", "<?xml version=\"1.0\"?>\n<!-- written by VaultHub -->\n<movie><title>旧标题</title></movie>\n")
	written, kept, _, err := writeNFOFile(p, v1003Doc(), false)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !written || kept {
		t.Fatalf("自家 NFO 应重写: written=%v kept=%v", written, kept)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "刮削标题") {
		t.Fatalf("未按新结果重写:\n%s", string(b))
	}
}

// E：BOM / UTF-16 识别。
func TestV1003ParseHandlesBOMAndUTF16(t *testing.T) {
	dir := t.TempDir()
	bom := append([]byte{0xEF, 0xBB, 0xBF}, []byte("<movie><title>带BOM的标题</title></movie>")...)
	p1 := filepath.Join(dir, "bom.nfo")
	if err := os.WriteFile(p1, bom, 0644); err != nil {
		t.Fatal(err)
	}
	if d, ok := parseNFODocument(p1); !ok || d.Title != "带BOM的标题" {
		t.Fatalf("BOM 解析失败: ok=%v title=%q", ok, d.Title)
	}

	// UTF-16LE + BOM
	text := "<movie><title>UTF16标题</title></movie>"
	le := []byte{0xFF, 0xFE}
	for _, r := range text {
		le = append(le, byte(r), byte(r>>8))
	}
	p2 := filepath.Join(dir, "u16.nfo")
	if err := os.WriteFile(p2, le, 0644); err != nil {
		t.Fatal(err)
	}
	if d, ok := parseNFODocument(p2); !ok || d.Title != "UTF16标题" {
		t.Fatalf("UTF-16 解析失败: ok=%v title=%q", ok, d.Title)
	}
}

// F：大写扩展名 / 大写文件名能被找到。
func TestV1003CaseInsensitiveNFOLookup(t *testing.T) {
	dir := t.TempDir()
	v1003Write(t, dir, "Movie.NFO", "<movie><title>大写扩展名</title></movie>")
	if got := firstExistingFile(dir, []string{"movie.nfo"}); got == "" {
		t.Fatalf("Movie.NFO 未被识别")
	}
	v1003Write(t, dir, "POSTER.JPG", "x")
	if got := firstExistingFile(dir, []string{"poster.jpg"}); got == "" {
		t.Fatalf("POSTER.JPG 未被识别")
	}
}

// G：演员重复不追加。
func TestV1003ActorDedupe(t *testing.T) {
	dir := t.TempDir()
	p := v1003Write(t, dir, "movie.nfo", `<movie><title>已有</title>
<actor><name>张三</name><role>主角</role></actor></movie>`)
	if _, _, _, err := writeNFOFile(p, v1003Doc(), false); err != nil {
		t.Fatalf("err: %v", err)
	}
	b, _ := os.ReadFile(p)
	if n := strings.Count(string(b), "<name>张三</name>"); n != 1 {
		t.Fatalf("演员去重失败，出现 %d 次:\n%s", n, string(b))
	}
	if !strings.Contains(string(b), "<name>李四</name>") {
		t.Fatalf("新演员未补入:\n%s", string(b))
	}
}

func containsStr(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
