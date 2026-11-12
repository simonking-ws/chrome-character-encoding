# -*- coding: utf-8 -*-
"""校验生成的图标是否符合 Chrome 的要求，并在浅色/深色工具栏上模拟展示。"""
import os
from PIL import Image

OUT = "icons"
SIZES = [16, 32, 48, 128]

problems = []

for size in SIZES:
    path = os.path.join(OUT, "icon%d.png" % size)
    if not os.path.exists(path):
        problems.append("缺少 %s" % path)
        continue
    img = Image.open(path)
    if img.size != (size, size):
        problems.append("%s 尺寸不对: %s" % (path, img.size))
    if img.mode != "RGBA":
        problems.append("%s 模式不对: %s（需要 RGBA 以支持透明圆角）" % (path, img.mode))
    alpha = img.getchannel("A")
    lo, hi = alpha.getextrema()
    if lo != 0 or hi != 255:
        problems.append("%s 透明通道异常: %s" % (path, (lo, hi)))
    # 圆角外应是透明的
    if alpha.getpixel((0, 0)) != 0:
        problems.append("%s 左上角不透明，圆角可能没做出来" % path)

# 拼一张模拟工具栏的图：浅色与深色背景各一条
sheet = Image.new("RGB", (560, 210), (255, 255, 255))
dark = Image.new("RGB", (560, 100), (53, 54, 56))
sheet.paste(dark, (0, 100))

for i, size in enumerate(SIZES):
    img = Image.open(os.path.join(OUT, "icon%d.png" % size)).convert("RGBA")
    sheet.paste(img, (30 + i * 130, (100 - size) // 2), img)
    sheet.paste(img, (30 + i * 130, 100 + (100 - size) // 2), img)

sheet.save(os.path.join(OUT, "toolbar-preview.png"))
print("wrote", os.path.join(OUT, "toolbar-preview.png"))

if problems:
    print("\n发现问题：")
    for p in problems:
        print("  -", p)
    raise SystemExit(1)
print("图标校验通过：尺寸、RGBA 模式、圆角透明均正常")
