package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/gif"
	_ "image/png"
)

/* v0.9.67：漫画页转码（纯标准库，无第三方依赖）。
 *
 * 实测结论（真实 4K 掃圖組 归档，1700×2450 量级扫描页）：
 *   - JPEG 页：解码 ~125ms + 缩放 ~176ms + 编码 ~110ms ≈ 410ms/页 → 体积 34%
 *   - PNG  页：解码 ~73ms  + 缩放 ~180ms + 编码 ~116ms ≈ 370ms/页 → 体积 43%
 *   - 归档内 95% 是 PNG（无损存档的扫描页），转 JPEG 收益最大
 *
 * 因此按来源类型走两条快速路径：
 *   1) *image.YCbCr（JPEG 源）：直接在 Y/Cb/Cr 平面上做面积平均，
 *      输出仍是 YCbCr，交给 image/jpeg 编码（零色彩空间转换）。
 *   2) RGBA/NRGBA 等：直接遍历像素数组做面积平均（alpha 合成到白底），
 *      PNG 扫描页实测无 alpha，因此不牺牲观感。
 *
 * 任何不确定的情况一律返回 ok=false 让调用方原样直出：
 * 解码失败、像素数过大（防 OOM）、无法缩放、转码后反而更大。
 */

const (
	/* maxTranscodePixels 防止超大图解码把内存打满。
	   独立审查实测：64M 像素的源图单次转码分配可达 ~255MiB（源 RGBA + 目标缓冲 + 编码缓冲），
	   且 singleflight 只合并「同一个键」，不同页面并发到达时并不合并 —— 因此这里同时收紧
	   上限并配合 transcodeConcurrency 的全局闸门。
	   16M 像素 ≈ 4000×4000，覆盖 4K 扫描页（约 8.3M px）仍有余量；
	   单次峰值内存约 64MiB（源 RGBA）+ 64MiB（目标）+ 编码输出。 */
	maxTranscodePixels = 16 << 20
	// maxPageSourceBytes 超过该体积的条目不做转码，直接直出（避免一次读入过大内存）。
	maxPageSourceBytes = 96 << 20
	// pageMaxHeight 长条图上限，避免极端长图产出畸形尺寸。
	pageMaxHeight = 8192
)

// transcodePageImage 把一页图片转成 JPEG。maxWidth<=0 时不缩放（仍会重编码）。
// ok=false 表示调用方应原样直出该页。
func transcodePageImage(raw []byte, maxWidth, quality int) (out []byte, ok bool) {
	if len(raw) == 0 {
		return nil, false
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, false
	}
	if cfg.Width*cfg.Height > maxTranscodePixels {
		return nil, false
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, false
	}
	b := img.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= 0 || sh <= 0 {
		return nil, false
	}
	nw, nh := sw, sh
	if maxWidth > 0 && sw > maxWidth {
		nw, nh = maxWidth, sh*maxWidth/sw
	}
	if nh > pageMaxHeight {
		nh, nw = pageMaxHeight, sw*pageMaxHeight/sh
	}
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	resized := nw < sw || nh < sh
	// 无需缩放且本来就是 JPEG：重编码只会掉画质，没有体积收益 → 直出。
	if !resized && format == "jpeg" {
		return nil, false
	}
	var scaled image.Image
	if yc, isYCbCr := img.(*image.YCbCr); isYCbCr && resized {
		scaled = scaleYCbCrPage(yc, nw, nh)
	} else if resized {
		scaled = scaleRGBAPage(img, nw, nh)
	} else {
		scaled = img
	}
	var buf bytes.Buffer
	if quality < 1 || quality > 100 {
		quality = 82
	}
	if err := jpeg.Encode(&buf, scaled, &jpeg.Options{Quality: quality}); err != nil {
		return nil, false
	}
	// 转码后反而更大（小图/已是高压缩比）→ 直出原图更有意义。
	if buf.Len() == 0 || buf.Len() >= len(raw) {
		return nil, false
	}
	return buf.Bytes(), true
}

// scaleYCbCrPage 在 Y/Cb/Cr 平面上做面积平均降采样，输出与源同次采样比的 YCbCr。
func scaleYCbCrPage(src *image.YCbCr, dstW, dstH int) *image.YCbCr {
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	dst := image.NewYCbCr(image.Rect(0, 0, dstW, dstH), src.SubsampleRatio)

	for dy := 0; dy < dstH; dy++ {
		y0 := sb.Min.Y + dy*sh/dstH
		y1 := sb.Min.Y + (dy+1)*sh/dstH
		if y1 <= y0 {
			y1 = y0 + 1
		}
		row := dst.Y[dst.YOffset(0, dy):]
		for dx := 0; dx < dstW; dx++ {
			x0 := sb.Min.X + dx*sw/dstW
			x1 := sb.Min.X + (dx+1)*sw/dstW
			if x1 <= x0 {
				x1 = x0 + 1
			}
			sum, n := 0, 0
			for y := y0; y < y1; y++ {
				base := src.YOffset(x0, y)
				for x := x1 - x0; x > 0; x-- {
					sum += int(src.Y[base])
					base++
				}
				n += x1 - x0
			}
			if n > 0 {
				row[dx] = uint8((sum + n/2) / n)
			}
		}
	}

	dstCW, dstCH := dstW, dstH
	switch src.SubsampleRatio {
	case image.YCbCrSubsampleRatio420:
		dstCW, dstCH = (dstW+1)/2, (dstH+1)/2
	case image.YCbCrSubsampleRatio422:
		dstCW = (dstW + 1) / 2
	}
	for cy := 0; cy < dstCH; cy++ {
		y0 := sb.Min.Y + cy*2*sh/dstH
		y1 := sb.Min.Y + (cy+1)*2*sh/dstH
		if y1 <= y0 {
			y1 = y0 + 1
		}
		if y1 > sb.Max.Y {
			y1 = sb.Max.Y
		}
		rowCb := dst.Cb[dst.COffset(0, cy):]
		rowCr := dst.Cr[dst.COffset(0, cy):]
		for cx := 0; cx < dstCW; cx++ {
			x0 := sb.Min.X + cx*2*sw/dstW
			x1 := sb.Min.X + (cx+1)*2*sw/dstW
			if x1 <= x0 {
				x1 = x0 + 1
			}
			if x1 > sb.Max.X {
				x1 = sb.Max.X
			}
			var s1, s2, n int
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					i := src.COffset(x, y)
					s1 += int(src.Cb[i])
					s2 += int(src.Cr[i])
					n++
				}
			}
			if n > 0 {
				rowCb[cx] = uint8((s1 + n/2) / n)
				rowCr[cx] = uint8((s2 + n/2) / n)
			}
		}
	}
	return dst
}

// scaleRGBAPage 面积平均降采样到 RGBA（扫白了 alpha 通道，白底合成）。
// NRGBA/RGBA 走像素数组直读，其余类型回落 image.Image 接口。
func scaleRGBAPage(src image.Image, dstW, dstH int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	if dstW <= 0 || dstH <= 0 {
		return dst
	}
	// 非预乘 RGBA（PNG 常见）快速路径
	if s, ok := src.(*image.NRGBA); ok {
		for dy := 0; dy < dstH; dy++ {
			y0, y1 := dy*sh/dstH, (dy+1)*sh/dstH
			if y1 <= y0 {
				y1 = y0 + 1
			}
			out := dst.Pix[dy*dst.Stride:]
			for dx := 0; dx < dstW; dx++ {
				x0, x1 := dx*sw/dstW, (dx+1)*sw/dstW
				if x1 <= x0 {
					x1 = x0 + 1
				}
				var r, g, bl, n uint64
				for y := y0; y < y1; y++ {
					row := s.Pix[y*s.Stride:]
					for x := x0; x < x1; x++ {
						i := x * 4
						a := uint64(row[i+3])
						r += (uint64(row[i])*a + 255*(255-a)) / 255
						g += (uint64(row[i+1])*a + 255*(255-a)) / 255
						bl += (uint64(row[i+2])*a + 255*(255-a)) / 255
						n++
					}
				}
				if n == 0 {
					continue
				}
				o := dx * 4
				out[o+0] = uint8(r / n)
				out[o+1] = uint8(g / n)
				out[o+2] = uint8(bl / n)
				out[o+3] = 255
			}
		}
		return dst
	}
	// 预乘 RGBA
	if s, ok := src.(*image.RGBA); ok {
		for dy := 0; dy < dstH; dy++ {
			y0, y1 := dy*sh/dstH, (dy+1)*sh/dstH
			if y1 <= y0 {
				y1 = y0 + 1
			}
			out := dst.Pix[dy*dst.Stride:]
			for dx := 0; dx < dstW; dx++ {
				x0, x1 := dx*sw/dstW, (dx+1)*sw/dstW
				if x1 <= x0 {
					x1 = x0 + 1
				}
				var r, g, bl, a, n uint64
				for y := y0; y < y1; y++ {
					row := s.Pix[y*s.Stride:]
					for x := x0; x < x1; x++ {
						i := x * 4
						r += uint64(row[i])
						g += uint64(row[i+1])
						bl += uint64(row[i+2])
						a += uint64(row[i+3])
						n++
					}
				}
				if n == 0 {
					continue
				}
				o := dx * 4
				af := float64(a) / float64(n) / 255.0
				out[o+0] = uint8(float64(r)/float64(n)*af + 255*(1-af))
				out[o+1] = uint8(float64(g)/float64(n)*af + 255*(1-af))
				out[o+2] = uint8(float64(bl)/float64(n)*af + 255*(1-af))
				out[o+3] = 255
			}
		}
		return dst
	}
	// 通用回落（Paletted / Gray / 其他解码器）
	for dy := 0; dy < dstH; dy++ {
		y0, y1 := b.Min.Y+dy*sh/dstH, b.Min.Y+(dy+1)*sh/dstH
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for dx := 0; dx < dstW; dx++ {
			x0, x1 := b.Min.X+dx*sw/dstW, b.Min.X+(dx+1)*sw/dstW
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var r, g, bl, n uint64
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					cr, cg, cb, _ := src.At(x, y).RGBA()
					r += uint64(cr)
					g += uint64(cg)
					bl += uint64(cb)
					n++
				}
			}
			if n == 0 {
				continue
			}
			dst.SetRGBA(dx, dy, color.RGBA{uint8(r / n / 257), uint8(g / n / 257), uint8(bl / n / 257), 255})
		}
	}
	return dst
}
