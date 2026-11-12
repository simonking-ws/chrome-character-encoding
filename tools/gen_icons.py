# -*- coding: utf-8 -*-
"""生成扩展图标。

设计说明
--------
图标用「一个拉丁字母 A」与「一个汉字 文」夹在一条竖直双向箭头来表达
“字符编码转换”——箭头即转码动作，左右两种文字即不同的字符集。

选这个构图的原因：

* **缩小到 16px 仍然成立**。Chrome 工具栏只有 16px，早期把 “CE” 和
  勾号堆在一起的方案在 16px 下糊成一团；这里只有三个元素，且 A 与 文
  都是高对比度的实心块面，缩小后仍能分辨出是“两个不同文字”。
* **不依赖英文**。扩展要面对的正是中日韩页面，用 A 与 文 这两个真实
  字符比 “CE” 缩写更直观。
* **与扩展配色一致**。主色取蓝，与弹窗里的主按钮同色系。

箭头做成细杆 + 明确箭头脚的竖直双向箭头（⇅）：在 48px 以上能读出
“来回转换”的意思，在 16px 下退化成一根分隔线，仍不破坏整体。

用法::

    python tools/gen_icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- 配色

BG_TOP = (29, 78, 216)       # blue-700
BG_BOTTOM = (14, 165, 233)    # sky-500
GLYPH = (255, 255, 255)
DIVIDER = (255, 255, 255)

# ---------------------------------------------------------------- 字体

FONT_LATIN = r"C:\Windows\Fonts\arialbd.ttf"
FONT_CJK = r"C:\Windows\Fonts\msyhbd.ttc"

SIZES = [16, 32, 48, 128]
OUT_DIR = "icons"

# 圆角半径相对边长
RADIUS_RATIO = 0.225


def rounded_tile(size, scale):
    """带竖直渐变的圆角方块。"""
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    for y in range(s):
        t = y / max(s - 1, 1)
        color = tuple(
            int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)
        )
        d.line([(0, y), (s, y)], fill=color + (255,))

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=int(s * RADIUS_RATIO), fill=255
    )
    img.putalpha(mask)
    return img


def draw_glyph(draw, text, font, box, fill):
    """在 box 内居中绘制文字。"""
    x0, y0, x1, y1 = box
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = x0 + (x1 - x0 - w) / 2 - bbox[0]
    y = y0 + (y1 - y0 - h) / 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=fill)


def draw_swap_arrow(draw, cx, s):
    """竖直双向箭头：细杆 + 上下箭头脚。"""
    shaft = max(2, int(s * 0.038))
    head = s * 0.062
    draw.line(
        [(cx, s * 0.265), (cx, s * 0.735)],
        fill=DIVIDER + (230,),
        width=shaft,
    )
    draw.polygon(
        [(cx, s * 0.155), (cx - head, s * 0.262), (cx + head, s * 0.262)],
        fill=DIVIDER + (230,),
    )
    draw.polygon(
        [(cx, s * 0.845), (cx - head, s * 0.738), (cx + head, s * 0.738)],
        fill=DIVIDER + (230,),
    )


def render(size, scale=8):
    s = size * scale
    img = rounded_tile(size, scale)
    d = ImageDraw.Draw(img)

    latin = ImageFont.truetype(FONT_LATIN, int(s * 0.44))
    cjk = ImageFont.truetype(FONT_CJK, int(s * 0.42))

    draw_glyph(d, "A", latin, (s * 0.015, s * 0.15, s * 0.435, s * 0.85), GLYPH + (255,))
    draw_glyph(d, "文", cjk, (s * 0.565, s * 0.15, s * 0.985, s * 0.85), GLYPH + (255,))
    draw_swap_arrow(d, s * 0.5, s)

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        render(size).save(path)
        print("wrote", path)

    # 预览图：把各尺寸拼在一起，方便肉眼检查
    preview = Image.new("RGB", (16 + 32 + 48 + 128 + 4 * 20, 128 + 40), (245, 246, 248))
    x = 20
    for size in SIZES:
        img = render(size)
        preview.paste(img, (x, 20), img)
        x += size + 20
    preview.save(os.path.join(OUT_DIR, "preview.png"))
    print("wrote", os.path.join(OUT_DIR, "preview.png"))


if __name__ == "__main__":
    main()
