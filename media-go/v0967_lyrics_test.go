package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v0.9.67 歌词识别与填充：占位过滤、LRC 时间轴剥离、ID3 USLT / Vorbis / MP4 解析、sidecar 读写。

func TestLyricsValidityFilter(t *testing.T) {
	bad := []string{
		"",
		"暂无歌词",
		"[00:00.00]暂无歌词",
		"此歌曲为没有填词的纯音乐，请您欣赏",
		"short",
		"[00:01.00]",
	}
	for _, b := range bad {
		if lyricsLooksValid(b) {
			t.Fatalf("应判定为无效歌词: %q", b)
		}
	}
	good := []string{
		"[00:00.54]原曲：载雪行春\n[00:05.36]会昌五年春，岁在乙丑。",
		"Look at the stars, look how they shine for you",
		"让我掉下眼泪的 不止昨夜的酒",
	}
	for _, g := range good {
		if !lyricsLooksValid(g) {
			t.Fatalf("应判定为有效歌词: %q", g)
		}
	}
}

func TestLrcStripTimestamps(t *testing.T) {
	in := "[ti:稻香]\n[ar:周杰倫]\n[00:12.34]对这个世界如果你有太多的抱怨\n[00:18.00]跌倒了就不敢继续往前走"
	out := lrcStripTimestamps(in)
	if strings.Contains(out, "[ti:") || strings.Contains(out, "00:12") {
		t.Fatalf("应剥掉时间轴与元信息标签，得到: %q", out)
	}
	if !strings.Contains(out, "对这个世界如果你有太多的抱怨") {
		t.Fatalf("正文应保留，得到: %q", out)
	}
}

func buildID3USLT(text string) []byte {
	body := []byte{3}      // UTF-8
	body = append(body, 'e', 'n', 'g')
	body = append(body, 0) // 空的 descriptor 结束符
	body = append(body, []byte(text)...)
	frame := []byte("USLT")
	size := make([]byte, 4)
	binary.BigEndian.PutUint32(size, uint32(len(body)))
	frame = append(frame, size...)
	frame = append(frame, 0, 0) // flags
	frame = append(frame, body...)
	header := []byte("ID3")
	header = append(header, 3, 0, 0) // v2.3, revision, flags
	sz := len(frame)
	header = append(header, byte(sz>>21&0x7F), byte(sz>>14&0x7F), byte(sz>>7&0x7F), byte(sz&0x7F))
	return append(header, frame...)
}

func TestID3USLTParsing(t *testing.T) {
	want := "[00:01.00]让我掉下眼泪的\n[00:05.00]不止昨夜的酒"
	raw := buildID3USLT(want)
	got, ok := id3USLT(raw)
	if !ok {
		t.Fatal("应能解析出 USLT 歌词")
	}
	if got != want {
		t.Fatalf("歌词不一致:\n got %q\nwant %q", got, want)
	}
	if _, ok := id3USLT([]byte("not an id3 tag")); ok {
		t.Fatal("非 ID3 数据不应解析成功")
	}
}

func TestVorbisLyricsParsing(t *testing.T) {
	want := "对这个世界如果你有太多的抱怨\n跌倒了就不敢继续往前走"
	raw := append([]byte("fLaC\x00\x00\x00\x22"), []byte("LYRICS="+want)...)
	raw = append(raw, 0x00)
	got, ok := vorbisLyrics(raw)
	if !ok {
		t.Fatal("应能从 Vorbis comment 解析歌词")
	}
	if !strings.Contains(got, "对这个世界如果你有太多的抱怨") {
		t.Fatalf("歌词内容不符: %q", got)
	}
	if _, ok := vorbisLyrics([]byte("fLaC no lyrics here")); ok {
		t.Fatal("无 LYRICS 键时不应解析成功")
	}
}

func TestMP4LyricsParsing(t *testing.T) {
	want := "[00:01.00]Look at the stars\n[00:05.00]look how they shine for you"
	payload := []byte{0, 0, 0, 0, 0, 0, 0, 0} // version+flags+locale
	payload = append(payload, []byte(want)...)
	dataAtom := []byte("data")
	size := make([]byte, 4)
	binary.BigEndian.PutUint32(size, uint32(8+len(payload)))
	dataAtom = append(dataAtom, size...)
	dataAtom = append(dataAtom, payload...)
	lyr := []byte{0xA9, 'l', 'y', 'r'}
	lsize := make([]byte, 4)
	binary.BigEndian.PutUint32(lsize, uint32(8+len(dataAtom)))
	raw := append(append(append([]byte("ftypM4A "), lsize...), lyr...), dataAtom...)
	got, ok := mp4Lyrics(raw)
	if !ok {
		t.Fatal("应能解析 ©lyr 原子")
	}
	if !strings.Contains(got, "look how they shine for you") {
		t.Fatalf("歌词内容不符: %q", got)
	}
}

func TestSidecarLyricsPreferredOverEmbedded(t *testing.T) {
	dir := t.TempDir()
	audio := filepath.Join(dir, "song.mp3")
	if err := os.WriteFile(audio, buildID3USLT("[00:01.00]内嵌歌词内容在这里"), 0o644); err != nil {
		t.Fatal(err)
	}
	sidecar := "[00:01.00]同名 lrc 内容在这里\n[00:05.00]应当优先使用"
	if err := os.WriteFile(filepath.Join(dir, "song.lrc"), []byte(sidecar), 0o644); err != nil {
		t.Fatal(err)
	}
	got, ok := localLyrics(audio)
	if !ok {
		t.Fatal("应读到歌词")
	}
	if got.Source != "local-lrc" {
		t.Fatalf("同名 .lrc 应优先，来源得到 %q", got.Source)
	}
	if !strings.Contains(got.Lyrics, "同名 lrc 内容在这里") {
		t.Fatalf("内容不符: %q", got.Lyrics)
	}
}

func TestWriteLyricsSidecarAtomicAndPath(t *testing.T) {
	dir := t.TempDir()
	audio := filepath.Join(dir, "track.flac")
	if err := os.WriteFile(audio, []byte("fLaC"), 0o644); err != nil {
		t.Fatal(err)
	}
	text := "[00:01.00]这是一段足够长的歌词内容用于校验"
	path, ok := writeLyricsSidecar(audio, text)
	if !ok {
		t.Fatal("写入 sidecar 应成功")
	}
	if filepath.Base(path) != "track.lrc" {
		t.Fatalf("sidecar 名称应为 track.lrc，得到 %s", filepath.Base(path))
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != text {
		t.Fatalf("回读内容不一致: %v %q", err, string(b))
	}
	if _, ok := writeLyricsSidecar(audio, "   "); ok {
		t.Fatal("空白歌词不应写入")
	}
	if _, ok := writeLyricsSidecar(audio, strings.Repeat("x", 64*1024+10)); ok {
		t.Fatal("超过 64KB 的歌词不应写入")
	}
}

func TestAudioCacheEntryClampsLyrics(t *testing.T) {
	// 缓存条目的歌词上限：防止异常大文本把 sqlite 表撑爆。
	if audioCacheLyricsLimit > 1<<20 {
		t.Fatalf("歌词上限过大: %d", audioCacheLyricsLimit)
	}
}
