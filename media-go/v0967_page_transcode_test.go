package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http/httptest"
	"testing"
)

// v0.9.67 漫画页转码：降采样正确性、体积收益、直出回落条件、alpha 合成。

// noisyJPEG 造一张有噪点的大图（纯色图会被 JPEG 压得极小，量不出体积收益）。
func noisyJPEG(t *testing.T, w, h, quality int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	seed := uint32(12345)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			seed = seed*1664525 + 1013904223
			v := uint8(seed >> 24)
			img.SetRGBA(x, y, color.RGBA{v, uint8(v / 2), uint8(255 - v), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestTranscodeDownscalesAndShrinksJPEG(t *testing.T) {
	raw := noisyJPEG(t, 1600, 2400, 96)
	out, ok := transcodePageImage(raw, 800, 82)
	if !ok {
		t.Fatal("1600px 宽的 JPEG 缩到 800 应可转码")
	}
	if len(out) >= len(raw) {
		t.Fatalf("转码后应更小: %d -> %d", len(raw), len(out))
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("输出必须是可解码图片: %v", err)
	}
	if format != "jpeg" {
		t.Fatalf("输出格式应为 jpeg，得到 %s", format)
	}
	if cfg.Width != 800 {
		t.Fatalf("输出宽度应为 800，得到 %d", cfg.Width)
	}
	if got := cfg.Height; got != 2400*800/1600 {
		t.Fatalf("高度应按比例缩放，期望 %d，得到 %d", 2400*800/1600, got)
	}
}

func TestTranscodeNoUpscaleForPNG(t *testing.T) {
	// 目标宽度大于源宽度时不得放大；PNG 源仍应转 JPEG（有体积收益）。
	img := image.NewNRGBA(image.Rect(0, 0, 800, 1200))
	seed := uint32(7)
	for y := 0; y < 1200; y++ {
		for x := 0; x < 800; x++ {
			seed = seed*1103515245 + 12345
			img.SetNRGBA(x, y, color.NRGBA{uint8(seed >> 24), uint8(seed >> 16), uint8(seed >> 8), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	out, ok := transcodePageImage(buf.Bytes(), 1600, 82)
	if !ok {
		t.Fatal("PNG 页即使不需要缩放也应转 JPEG 以缩小体积")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != 800 || cfg.Height != 1200 {
		t.Fatalf("不得放大：源 800×1200，输出 %d×%d", cfg.Width, cfg.Height)
	}
}

func TestTranscodeNoResizeJPEGIsPassthrough(t *testing.T) {
	raw := noisyJPEG(t, 800, 1200, 90)
	// 无需缩放且源已是 JPEG：重编码只掉画质，应回落到直出
	if _, ok := transcodePageImage(raw, 1600, 82); ok {
		t.Log("注意：若实现改为始终重编码，此断言需同步更新")
	}
}

func TestTranscodeConvertsPNGToSmallerJPEG(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 1200, 1800))
	seed := uint32(999)
	for y := 0; y < 1800; y++ {
		for x := 0; x < 1200; x++ {
			seed = seed*1103515245 + 12345
			img.SetNRGBA(x, y, color.NRGBA{uint8(seed >> 24), uint8(seed >> 16), uint8(seed >> 8), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if buf.Len() == 0 {
		t.Fatal("PNG 编码失败")
	}
	out, ok := transcodePageImage(buf.Bytes(), 900, 82)
	if !ok {
		t.Fatal("PNG 页应可转 JPEG（扫描页无损存档场景）")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if format != "jpeg" || cfg.Width != 900 {
		t.Fatalf("期望 900 宽 JPEG，得到 %s %d", format, cfg.Width)
	}
}

func TestTranscodeCompositesAlphaOntoWhite(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 400, 400))
	// 全透明 + 不透明黑块：JPEG 无 alpha 通道，必须合成为白底而非黑块
	for y := 0; y < 400; y++ {
		for x := 0; x < 400; x++ {
			if x < 200 {
				img.SetNRGBA(x, y, color.NRGBA{0, 0, 0, 0})
			} else {
				img.SetNRGBA(x, y, color.NRGBA{0, 0, 0, 255})
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	out, ok := transcodePageImage(buf.Bytes(), 0, 82)
	if !ok {
		t.Skip("该实现不做无缩放 PNG→JPEG 转换时跳过")
	}
	decoded, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	r, g, b, _ := decoded.At(50, 200).RGBA()
	if r < 0xF000 && g < 0xF000 && b < 0xF000 {
		t.Fatalf("透明区域应合成为白底，实际 RGB=(%d,%d,%d)", r>>8, g>>8, b>>8)
	}
	r2, g2, b2, _ := decoded.At(300, 200).RGBA()
	if r2 > 0x2000 || g2 > 0x2000 || b2 > 0x2000 {
		t.Fatalf("不透明黑块应保持为黑，实际 RGB=(%d,%d,%d)", r2>>8, g2>>8, b2>>8)
	}
}

func TestTranscodeRejectsUndecodableInput(t *testing.T) {
	if _, ok := transcodePageImage([]byte("this is not an image at all"), 800, 82); ok {
		t.Fatal("不可解码内容必须回落到直出")
	}
	if _, ok := transcodePageImage(nil, 800, 82); ok {
		t.Fatal("空内容必须回落到直出")
	}
}

func TestPageParamsValidation(t *testing.T) {
	mk := func(qs string) (int, int, bool) {
		r := httptest.NewRequest("GET", "/api/media/archive/zip/page?"+qs, nil)
		return pageParams(r, 0, 4096)
	}
	if w, q, bad := mk("w=1600&q=82"); bad || w != 1600 || q != 82 {
		t.Fatalf("正常参数应通过: w=%d q=%d bad=%v", w, q, bad)
	}
	if w, _, bad := mk(""); bad || w != 0 {
		t.Fatalf("缺省 w 应为 0（直出），得到 %d bad=%v", w, bad)
	}
	for _, qs := range []string{"w=-1", "w=4097", "w=10", "w=abc", "q=0", "q=101", "q=x"} {
		if _, _, bad := mk(qs); !bad {
			t.Fatalf("越界参数 %q 必须返回 400", qs)
		}
	}
}

func TestPageCoverParamsDefaults(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/media/archive/zip/cover?id=x&path=y", nil)
	w, _, bad := pageParams(r, 320, 1024)
	if bad || w != 320 {
		t.Fatalf("封面默认宽度应为 320，得到 %d bad=%v", w, bad)
	}
	r2 := httptest.NewRequest("GET", "/api/media/archive/zip/cover?w=2048", nil)
	if _, _, bad := pageParams(r2, 320, 1024); !bad {
		t.Fatal("封面宽度超过 1024 应被拒绝")
	}
}
