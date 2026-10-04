"""生成 VaultHub Desktop 应用图标（.ico 多尺寸 + 预览 PNG）。
设计：青瓷主色圆角方块 + 保险库表盘环 + 中央 V 字，取自服务端主题令牌 --accent #2BC4B4 / --accent-ink #06231F。
"""
from PIL import Image, ImageDraw
import os
import sys

ACCENT = (43, 196, 180)      # --accent (emerald dark)
INK = (6, 35, 31)            # --accent-ink
BG = (11, 20, 19)            # --bg

S = 1024                      # 主画布（超采样后缩放）
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角底板：深色，带一点层次
pad = int(S * 0.045)
radius = int(S * 0.235)
d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=BG)

# 主体：主色圆角方块
inner = int(S * 0.145)
d.rounded_rectangle([inner, inner, S - inner, S - inner], radius=int(S * 0.185), fill=ACCENT)

# 表盘外环（保险库意象）
ring_c = S / 2
for r, w, col in (
    (S * 0.295, int(S * 0.030), INK + (70,)),
    (S * 0.225, int(S * 0.016), INK + (46,)),
):
    d.ellipse([ring_c - r, ring_c - r, ring_c + r, ring_c + r], outline=col, width=w)

# 中央 V 字（用多边形绘制，保证小尺寸也清晰）
cx = S / 2
top = S * 0.315
bot = S * 0.700
half = S * 0.205
thick = S * 0.086
mid_h = S * 0.545

v = [
    (cx - half, top),
    (cx - half + thick, top),
    (cx, mid_h),
    (cx + half - thick, top),
    (cx + half, top),
    (cx + thick * 0.62, bot),
    (cx - thick * 0.62, bot),
]
d.polygon(v, fill=INK)

# 表盘刻度（四点）
for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
    rr = S * 0.295
    x = cx + dx * rr
    y = cx + dy * rr
    d.ellipse([x - S * 0.028, y - S * 0.028, x + S * 0.028, y + S * 0.028], fill=INK + (150,))

out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(out_dir, exist_ok=True)

png_path = os.path.join(out_dir, "icon.png")
img.resize((512, 512), Image.LANCZOS).save(png_path)

ico_path = os.path.join(out_dir, "icon.ico")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(ico_path, format="ICO", sizes=sizes)

print(f"PNG: {png_path} ({os.path.getsize(png_path)} B)")
print(f"ICO: {ico_path} ({os.path.getsize(ico_path)} B)")
print(f"尺寸: {', '.join(f'{w}x{h}' for w, h in sizes)}")

# 同时导出 256 PNG 供 electron-builder 兜底使用
img.resize((256, 256), Image.LANCZOS).save(os.path.join(out_dir, "icon-256.png"))
