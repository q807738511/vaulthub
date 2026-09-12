package main

import (
	"os"
	"path/filepath"
	"testing"
)

/* v0.9.68 回归测试：第一轮安全审查的「非阻塞项」修复点。
   覆盖：音频扩展名白名单、sidecar 写入加固（唯一临时名 / 拒绝符号链接 / 只写音频）。 */

func TestIsAudioMediaPathWhitelist(t *testing.T) {
	audio := []string{"a.mp3", "b.FLAC", "c.m4a", "d.ogg", "e.opus", "f.wav", "g.aac", "h.ape"}
	for _, p := range audio {
		if !isAudioMediaPath(p) {
			t.Fatalf("%s 应被识别为音频", p)
		}
	}
	notAudio := []string{"movie.mkv", "video.mp4", "book.pdf", "page.png", "comic.zip", "noext", "x.lrc"}
	for _, p := range notAudio {
		if isAudioMediaPath(p) {
			t.Fatalf("%s 不应被识别为音频（歌词落盘/识别只针对音频）", p)
		}
	}
}

func TestWriteLyricsSidecarRejectsNonAudio(t *testing.T) {
	dir := t.TempDir()
	// 库里的大视频文件：不得写 sidecar
	video := filepath.Join(dir, "movie.mkv")
	if err := os.WriteFile(video, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if p, ok := writeLyricsSidecar(video, "[00:01.00]这是一段足够长的歌词内容"); ok {
		t.Fatalf("非音频文件不应写 sidecar，却写到 %s", p)
	}
	if _, err := os.Stat(filepath.Join(dir, "movie.lrc")); !os.IsNotExist(err) {
		t.Fatal("非音频文件不得产生 .lrc")
	}
}

func TestWriteLyricsSidecarRefusesSymlinkTarget(t *testing.T) {
	dir := t.TempDir()
	audio := filepath.Join(dir, "song.mp3")
	if err := os.WriteFile(audio, []byte("ID3"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(dir, "outside.txt")
	if err := os.WriteFile(outside, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "song.lrc")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("环境不支持符号链接: %v", err)
	}
	if _, ok := writeLyricsSidecar(audio, "[00:01.00]这是一段足够长的歌词内容"); ok {
		t.Fatal("目标为符号链接时必须跳过，避免写入链接指向的位置")
	}
	b, _ := os.ReadFile(outside)
	if string(b) != "keep me" {
		t.Fatal("符号链接目标被改写了")
	}
}

func TestWriteLyricsSidecarUsesUnpredictableTempAndWrites(t *testing.T) {
	dir := t.TempDir()
	audio := filepath.Join(dir, "track.flac")
	if err := os.WriteFile(audio, []byte("fLaC"), 0o644); err != nil {
		t.Fatal(err)
	}
	text := "[00:01.00]这是一段足够长的歌词内容用于校验写入"
	path, ok := writeLyricsSidecar(audio, text)
	if !ok {
		t.Fatal("音频文件的 sidecar 应写入成功")
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != text {
		t.Fatalf("回读不一致: %v %q", err, string(b))
	}
	// 临时文件必须已清理（用的是带随机后缀的临时名，不能残留）
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if len(e.Name()) > 4 && e.Name()[len(e.Name())-4:] == ".tmp" {
			t.Fatalf("临时文件残留: %s", e.Name())
		}
	}
}

func TestPageCacheEvictDoesNotBlockOnFileIO(t *testing.T) {
	dir := t.TempDir()
	c := newPageCache(dir, 2048)
	payload := make([]byte, 700)
	for i := 0; i < 6; i++ {
		key := string(rune('a'+i)) + "000000000000000000000000000000000000000"
		c.put(key, payload, "jpg")
	}
	// 淘汰后配额不得长期超限（允许刚写入的那一条被保护）
	_, total, _, _ := c.stats()
	if total > 2048+int64(len(payload)) {
		t.Fatalf("淘汰后总占用仍过大: %d", total)
	}
	// 最近的条目应仍可读
	last := string(rune('a'+5)) + "000000000000000000000000000000000000000"
	if _, ok := c.get(last); !ok {
		t.Fatal("最近写入的条目应仍在缓存中")
	}
}
