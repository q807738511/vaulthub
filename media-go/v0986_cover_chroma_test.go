package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

/* v0.9.86 回归测试：封面缩略图「上截正常、下截发绿」。
 *
 * 缺陷：scaleYCbCrPage 用 dst.COffset(0, cy) 定位目标色度行，而 cy 已经是色度行号，
 * COffset 会按采样比再除一次（4:2:0 除 2）→ 只写到色度平面的上半部分，
 * 下半部分保持 0。Cb=Cr=0 在 JPEG 里就是饱和纯绿，所以封面下半截发绿。
 *
 * 本测试构造 4:2:0 的彩色 JPEG，缩略到一半宽，再解码结果：
 *   - 修复前：下半部分 Cb/Cr 均值 ≈ 0（发绿）
 *   - 修复后：下半部分 Cb/Cr 均值与源图接近（约 128 中性 + 真实色度）
 */

func makeYCbCrJPEG(t *testing.T, w, h int, ratio image.YCbCrSubsampleRatio) []byte {
	t.Helper()
	src := image.NewYCbCr(image.Rect(0, 0, w, h), ratio)
	// 上蓝下红的横向渐变：Y 保持可见细节，色度上下差异明显。
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			src.Y[src.YOffset(x, y)] = uint8(40 + 200*x/w)
			i := src.COffset(x, y)
			if y < h/2 {
				src.Cb[i] = 200 // 偏蓝
				src.Cr[i] = 60
			} else {
				src.Cb[i] = 60 // 偏红
				src.Cr[i] = 200
			}
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: 92}); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return buf.Bytes()
}

// chromaRowMeans 解码 JPEG，返回 (上半 / 下半) 的 Cb、Cr 均值。
func chromaRowMeans(t *testing.T, raw []byte) (cbTop, crTop, cbBottom, crBottom float64) {
	t.Helper()
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	yc, ok := img.(*image.YCbCr)
	if !ok {
		t.Fatalf("decoded image is %T, want *image.YCbCr", img)
	}
	b := yc.Bounds()
	var nTop, nBottom float64
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := yc.COffset(x, y)
			if y < b.Dy()/2 {
				cbTop += float64(yc.Cb[i])
				crTop += float64(yc.Cr[i])
				nTop++
			} else {
				cbBottom += float64(yc.Cb[i])
				crBottom += float64(yc.Cr[i])
				nBottom++
			}
		}
	}
	if nTop == 0 || nBottom == 0 {
		t.Fatalf("empty half: top=%v bottom=%v", nTop, nBottom)
	}
	return cbTop / nTop, crTop / nTop, cbBottom / nBottom, crBottom / nBottom
}

func TestV0986ThumbChromaCoversBottomHalf(t *testing.T) {
	const w, h = 240, 240
	raw := makeYCbCrJPEG(t, w, h, image.YCbCrSubsampleRatio420)
	out, ok := transcodePageImage(raw, 120, 82)
	if !ok {
		t.Fatalf("transcodePageImage returned ok=false（应当能缩略这张 120px 宽的图）")
	}
	cbTop, crTop, cbBottom, crBottom := chromaRowMeans(t, out)
	/*
	 * 断言一：下半部分色度不能是「零平面」。
	 * 源图下半部分是偏红（Cb≈60、Cr≈200），修复后应当明显偏离 0；
	 * 修复前这里恒为 0（Cb=Cr=0 → 纯绿）。
	 */
	if cbBottom < 20 {
		t.Fatalf("下半部分 Cb 均值 %.1f ≈ 0：色度平面未被写入（这正是「下截发绿」的成因）", cbBottom)
	}
	if crBottom < 100 {
		t.Fatalf("下半部分 Cr 均值 %.1f 过低：源图下半是偏红，色度没有传下来", crBottom)
	}
	/*
	 * 断言二：上下两半的色度必须不同（源图上半偏蓝、下半偏红）。
	 * 修复前下半是 0，看起来「有差异」但方向错误，所以前一条断言更关键；
	 * 这里再钉住方向性：下半 Cr 必须明显高于上半。
	 */
	_ = cbTop
	if !(crBottom > crTop+60) {
		t.Fatalf("色度上下未分离：下半 Cr %.1f vs 上半 Cr %.1f", crBottom, crTop)
	}
}

func TestV0986ThumbChromaAllRatios(t *testing.T) {
	/* 三种常见采样比都要正确写满色度平面（440/422 曾被 dstCH 推导错配）。 */
	for _, tc := range []struct {
		name  string
		ratio image.YCbCrSubsampleRatio
	}{
		{"420", image.YCbCrSubsampleRatio420},
		{"422", image.YCbCrSubsampleRatio422},
		{"440", image.YCbCrSubsampleRatio440},
		{"444", image.YCbCrSubsampleRatio444},
	} {
		t.Run(tc.name, func(t *testing.T) {
			/* 尺寸取奇数，覆盖 (w+1)/2 与 (h+1)/2 的取整分支。 */
			raw := makeYCbCrJPEG(t, 129, 97, tc.ratio)
			out, ok := transcodePageImage(raw, 60, 82)
			if !ok {
				t.Skipf("%s：该尺寸/采样比无需缩略或转码收益不足，跳过", tc.name)
			}
			_, crTop, cbBottom, crBottom := chromaRowMeans(t, out)
			if cbBottom < 20 || crBottom < 100 {
				t.Fatalf("%s：下半色度异常 Cb=%.1f Cr=%.1f（零平面 → 发绿）", tc.name, cbBottom, crBottom)
			}
			if !(crBottom > crTop+60) {
				t.Fatalf("%s：色度上下未分离 下半Cr=%.1f 上半Cr=%.1f", tc.name, crBottom, crTop)
			}
		})
	}
}

func TestV0986ChromaHelpers(t *testing.T) {
	if w, h := ycbcrChromaSize(image.YCbCrSubsampleRatio420, 101, 51); w != 51 || h != 26 {
		t.Fatalf("420 chroma size = %dx%d, want 51x26", w, h)
	}
	if w, h := ycbcrChromaSize(image.YCbCrSubsampleRatio422, 101, 51); w != 51 || h != 51 {
		t.Fatalf("422 chroma size = %dx%d, want 51x51", w, h)
	}
	if w, h := ycbcrChromaSize(image.YCbCrSubsampleRatio440, 101, 51); w != 101 || h != 26 {
		t.Fatalf("440 chroma size = %dx%d, want 101x26", w, h)
	}
	if hf, vf := ycbcrChromaFactors(image.YCbCrSubsampleRatio420); hf != 2 || vf != 2 {
		t.Fatalf("420 factors = %d,%d want 2,2", hf, vf)
	}
	if hf, vf := ycbcrChromaFactors(image.YCbCrSubsampleRatio422); hf != 2 || vf != 1 {
		t.Fatalf("422 factors = %d,%d want 2,1", hf, vf)
	}
	if hf, vf := ycbcrChromaFactors(image.YCbCrSubsampleRatio440); hf != 1 || vf != 2 {
		t.Fatalf("440 factors = %d,%d want 1,2", hf, vf)
	}
	if hf, vf := ycbcrChromaFactors(image.YCbCrSubsampleRatio444); hf != 1 || vf != 1 {
		t.Fatalf("444 factors = %d,%d want 1,1", hf, vf)
	}
}

/*
端到端：真的把一张「彩色底图」走一遍 JPEG 编码 → 缩略 → 解码，

	确认下截不再是纯绿（G 通道压倒 R/B）。这是客户肉眼看到的那个现象。
*/
func TestV0986ThumbBottomNotGreen(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 200, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 200; x++ {
			/* 只用红/蓝/洋红系配色：测试图自身不含任何「绿占优」的像素，
			   这样下半部分一旦出现绿像素，只可能来自色度平面缺陷。 */
			src.Set(x, y, color.RGBA{R: uint8(80 + x/2), G: uint8(20 + y/10), B: uint8(120 + y/2), A: 255})
		}
	}
	var raw bytes.Buffer
	if err := jpeg.Encode(&raw, src, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, ok := transcodePageImage(raw.Bytes(), 100, 82)
	if !ok {
		t.Fatalf("transcode returned ok=false")
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	b := img.Bounds()
	greenish := 0
	for y := b.Max.Y / 2; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			r8, g8, b8 := int(r>>8), int(g>>8), int(bl>>8)
			if g8 > 150 && g8-r8 > 60 && g8-b8 > 60 {
				greenish++
			}
		}
	}
	if greenish > 0 {
		t.Fatalf("缩略图下半部分出现 %d 个纯绿像素（旧的色度平面缺陷）", greenish)
	}
}
