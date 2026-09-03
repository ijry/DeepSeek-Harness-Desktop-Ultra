#!/usr/bin/env python
"""生成应用图标源文件 src-tauri/icons/app-icon.png (1024x1024)。

为什么用几何绘制而不是渲染 SVG:
  - 不依赖 cairosvg/librsvg,任何装了 Pillow 的机器都能重现
  - 不依赖系统字体,字形在所有平台上完全一致

为什么图标只放一个 "D" 而不是完整的 "DSH":
  应用图标要在 16x16 的任务栏和 32x32 的标题栏里可辨认。三个字母在那个
  尺寸下会糊成一团。完整字标保留在启动页(56px,足够清晰)和 README 里。

用法:
    python scripts/make-icon.py
    npm run tauri -- icon src-tauri/icons/app-icon.png
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
# 4 倍超采样后缩小,得到平滑边缘(PIL 的绘制不做抗锯齿)
SS = 4

# 品牌渐变:天蓝 → 靛蓝
GRADIENT_START = (56, 189, 248)   # #38BDF8
GRADIENT_END = (99, 102, 241)     # #6366F1

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "app-icon.png"


def diagonal_gradient(size: int) -> Image.Image:
    """135° 线性渐变。逐像素太慢,用垂直渐变 + 旋转近似。"""
    # 先做一条竖直渐变,再旋转 45°,取中心裁切
    span = int(size * 1.5)
    strip = Image.new("RGB", (1, span))
    for y in range(span):
        t = y / (span - 1)
        strip.putpixel(
            (0, y),
            tuple(
                round(a + (b - a) * t)
                for a, b in zip(GRADIENT_START, GRADIENT_END)
            ),
        )
    # +45° 让渐变从左上(天蓝)走到右下(靛蓝),与 CSS 里的
    # linear-gradient(135deg, #38BDF8, #6366F1) 和启动页的方块保持一致
    gradient = strip.resize((span, span), Image.NEAREST).rotate(
        45, resample=Image.BICUBIC, expand=False
    )
    left = (span - size) // 2
    return gradient.crop((left, left, left + size, left + size))


def rounded_mask(size: int, radius: int) -> Image.Image:
    """整个图标的圆角方形遮罩。"""
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius, fill=255
    )
    return mask


def glyph_mask(size: int) -> Image.Image:
    """字母 D 的遮罩。

    不用 PIL 的 rounded_rectangle:它要求圆角半径 <= 短边的一半,而 D 的碗
    需要一个半径等于字高一半的正半圆,必然超过这个限制。
    改成「矩形 + 整圆」求并,再把溢出左边界的部分切掉。
    """
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)

    height = round(size * 0.53)
    width = round(height * 0.78)
    # 笔画粗细:太细在 16px 下会消失,太粗内孔会糊成实心块
    stroke = round(height * 0.235)

    x0 = (size - width) // 2
    y0 = (size - height) // 2
    x1, y1 = x0 + width, y0 + height

    def draw_d(left: int, top: int, right: int, bottom: int, ink: int) -> None:
        bowl = bottom - top          # 碗是直径等于字高的正圆
        seam = right - bowl // 2     # 直边与碗的接缝
        draw.rectangle((left, top, seam, bottom), fill=ink)
        draw.ellipse((right - bowl, top, right, bottom), fill=ink)

    draw_d(x0, y0, x1, y1, 255)
    draw_d(x0 + stroke, y0 + stroke, x1 - stroke, y1 - stroke, 0)

    # 碗的圆比字宽,左半部分会溢出到 x0 左侧,切掉它才有平直的竖笔
    draw.rectangle((0, 0, x0 - 1, size), fill=0)
    return mask


def main() -> None:
    big = SIZE * SS

    icon = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    icon.paste(diagonal_gradient(big), (0, 0))
    icon.putalpha(rounded_mask(big, radius=round(big * 0.22)))

    white = Image.new("RGBA", (big, big), (255, 255, 255, 255))
    icon = Image.composite(white, icon, glyph_mask(big))
    # composite 会把字形区域的 alpha 也换成白色的 255,圆角外的透明需要恢复
    icon.putalpha(rounded_mask(big, radius=round(big * 0.22)))

    icon = icon.resize((SIZE, SIZE), Image.LANCZOS)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUT, "PNG")
    print(f"已生成 {OUT} ({SIZE}x{SIZE})")

    # 顺手输出几个小尺寸的预览,便于人眼确认小图是否还认得出
    for preview in (16, 32, 48):
        path = OUT.with_name(f"preview-{preview}.png")
        icon.resize((preview, preview), Image.LANCZOS).save(path, "PNG")
        print(f"已生成预览 {path}")


if __name__ == "__main__":
    main()
