#!/usr/bin/env python3
"""
Generate VS Code Marketplace visual assets for BoringSpinner.

Run:  .venv/bin/python gen_assets.py

Produces (in this directory):
  icon.png               128x128  marketplace icon (package.json "icon")
  icon-512.png           512x512  hi-res same design
  marketplace-banner.png 1376x768 listing banner

Design: dark dev-tool aesthetic. Background #0D1117, one bright green accent
(#2EA043 "get paid"). Icon = a circular arc spinner ring fused with a money "$"
in the center. Banner = wordmark + tagline on the left, mock terminal line on
the right showing a sponsored spinner in action.

Tooling: Pillow only. Real system TTFs (SF Pro / Arial Bold for headings,
SF Mono / Menlo for the terminal mock). No bitmap default font for text.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- palette ----------------------------------------------------------------
BG = (13, 17, 23)            # #0D1117 GitHub dark
PANEL = (22, 27, 34)         # #161B22 slightly-lighter terminal panel
PANEL_EDGE = (48, 54, 61)    # #30363D subtle border
GREEN = (46, 160, 67)        # #2EA043 "get paid" accent
GREEN_HI = (63, 185, 80)     # #3FB950 brighter green
GREEN_DIM = (35, 102, 51)    # dim trailing arc
TEXT = (230, 237, 243)       # #E6EDF3 near-white
MUTED = (139, 148, 158)      # #8B949E muted grey
AMBER = (210, 153, 34)       # #D29922 sponsored tag

# ---- fonts ------------------------------------------------------------------
SFNS = "/System/Library/Fonts/SFNS.ttf"
SFMONO = "/System/Library/Fonts/SFNSMono.ttf"
MENLO = "/System/Library/Fonts/Menlo.ttc"
ARIAL_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf"


def sf(size, variation="Heavy"):
    """SF Pro at a given named weight; fall back to Arial Bold."""
    try:
        f = ImageFont.truetype(SFNS, size)
        try:
            f.set_variation_by_name(variation)
        except Exception:
            pass
        return f
    except Exception:
        return ImageFont.truetype(ARIAL_BOLD, size)


def sf_reg(size, variation="Regular"):
    try:
        f = ImageFont.truetype(SFNS, size)
        try:
            f.set_variation_by_name(variation)
        except Exception:
            pass
        return f
    except Exception:
        return ImageFont.truetype(ARIAL, size)


def mono(size):
    try:
        return ImageFont.truetype(SFMONO, size)
    except Exception:
        return ImageFont.truetype(MENLO, size)


# ---- icon -------------------------------------------------------------------
def make_icon(size):
    """Spinner ring + $ money cue. Rendered at 4x then downsampled for AA."""
    S = 4
    W = size * S
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # rounded-square dark tile background
    pad = int(W * 0.045)
    radius = int(W * 0.22)
    d.rounded_rectangle([pad, pad, W - pad, W - pad], radius=radius, fill=BG)

    cx = cy = W / 2
    ring_r = W * 0.315
    stroke = max(2, int(W * 0.075))

    # full faint track ring
    bbox = [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r]
    d.arc(bbox, 0, 360, fill=(48, 54, 61), width=stroke)

    # bright spinner arc (~270deg, comet head) — the "thinking" motif
    # draw in segments to fade the tail
    start = -90.0
    sweep = 268.0
    segs = 90
    for i in range(segs):
        a0 = start + (sweep) * (i / segs)
        a1 = start + (sweep) * ((i + 1) / segs)
        t = i / (segs - 1)             # 0 tail -> 1 head
        # interpolate dim green -> bright green
        c = tuple(int(GREEN_DIM[k] + (GREEN_HI[k] - GREEN_DIM[k]) * t) for k in range(3))
        d.arc([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
              a0, a1 + 1.2, fill=c, width=stroke)

    # rounded head dot at the leading edge of the arc
    head_ang = math.radians(start + sweep)
    hx = cx + ring_r * math.cos(head_ang)
    hy = cy + ring_r * math.sin(head_ang)
    hr = stroke * 0.62
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=GREEN_HI)

    # center money cue: bold "$"
    dollar = sf(int(W * 0.40), "Black")
    txt = "$"
    bb = d.textbbox((0, 0), txt, font=dollar)
    tw = bb[2] - bb[0]
    th = bb[3] - bb[1]
    d.text((cx - tw / 2 - bb[0], cy - th / 2 - bb[1]), txt, font=dollar, fill=TEXT)

    img = img.resize((size, size), Image.LANCZOS)
    return img


# ---- banner -----------------------------------------------------------------
def make_banner(W=1376, H=768):
    S = 2
    img = Image.new("RGBA", (W * S, H * S), BG + (255,))
    d = ImageDraw.Draw(img)
    sw, sh = W * S, H * S

    # subtle radial-ish vignette via a soft darker corner gradient (cheap)
    # faint accent glow behind the icon area on the left
    glow = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gx, gy = int(sw * 0.16), int(sh * 0.36)
    for r in range(int(sw * 0.30), 0, -6):
        a = int(16 * (1 - r / (sw * 0.30)))
        gd.ellipse([gx - r, gy - r, gx + r, gy + r], fill=(46, 160, 67, a))
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)

    # ---- left column: icon mark + wordmark + tagline (kept within left ~46%) ----
    margin = int(sw * 0.065)
    left_max = int(sw * 0.46)            # left content must not cross this (panel starts ~0.50)

    # icon mark, top of the left column, beside the wordmark on one row
    mark_px = int(sh * 0.155)
    mark = make_icon(mark_px).resize((mark_px * S, mark_px * S), Image.LANCZOS)

    # wordmark "BoringSpinner" — size it so mark + word fits inside left_max
    wm = "BoringSpinner"
    word_size = int(sh * 0.092)
    word_f = sf(word_size, "Bold")
    gap = int(sw * 0.016)
    while True:
        bb = d.textbbox((0, 0), wm, font=word_f)
        total_w = mark_px * S + gap + (bb[2] - bb[0])
        if margin + total_w <= left_max or word_size <= int(sh * 0.05):
            break
        word_size -= 2
        word_f = sf(word_size, "Bold")

    row_y = int(sh * 0.30)
    img.paste(mark, (margin, row_y), mark)
    d = ImageDraw.Draw(img)
    bb = d.textbbox((0, 0), wm, font=word_f)
    word_h = bb[3] - bb[1]
    wx = margin + mark_px * S + gap
    word_y = row_y + (mark_px * S - word_h) // 2 - bb[1]
    d.text((wx, word_y), wm, font=word_f, fill=TEXT)

    # tagline "the BoringSpinner tagline" beneath the mark+word row
    tag_f = sf(int(sh * 0.058), "Bold")
    tag_y = row_y + mark_px * S + int(sh * 0.075)
    seg1, seg2 = "Get paid ", "while AI codes"
    bb1 = d.textbbox((0, 0), seg1, font=tag_f)
    d.text((margin, tag_y), seg1, font=tag_f, fill=GREEN_HI)
    d.text((margin + (bb1[2] - bb1[0]), tag_y), seg2, font=tag_f, fill=TEXT)

    # 50/50 revenue sub-line, small + muted
    sub_f = sf_reg(int(sh * 0.034), "Regular")
    sub_y = tag_y + (bb1[3] - bb1[1]) + int(sh * 0.055)
    d.text((margin, sub_y),
           "Monetize the AI thinking spinner. 50% of ad revenue to you.",
           font=sub_f, fill=MUTED)

    # ---- right: mock terminal panel ----
    panel_x0 = int(sw * 0.50)
    panel_x1 = sw - margin
    panel_y0 = int(sh * 0.30)
    panel_y1 = int(sh * 0.70)
    prad = int(18 * S)
    # soft drop shadow behind the panel
    sh_off = int(10 * S)
    shadow = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([panel_x0 + sh_off, panel_y0 + sh_off, panel_x1 + sh_off, panel_y1 + sh_off],
                         radius=prad, fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(14 * S)))
    img = Image.alpha_composite(img, shadow)
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([panel_x0, panel_y0, panel_x1, panel_y1], radius=prad,
                        fill=PANEL, outline=PANEL_EDGE, width=max(1, S))

    # title bar dots
    dot_y = panel_y0 + int(26 * S)
    dot_x = panel_x0 + int(28 * S)
    dr = int(7 * S)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx0 = dot_x + i * int(26 * S)
        d.ellipse([cx0 - dr, dot_y - dr, cx0 + dr, dot_y + dr], fill=c)

    # title bar label
    tb_f = mono(int(15 * S))
    d.text((dot_x + int(95 * S), dot_y - int(9 * S)), "claude code", font=tb_f, fill=MUTED)

    # divider
    div_y = panel_y0 + int(58 * S)
    d.line([panel_x0 + int(10 * S), div_y, panel_x1 - int(10 * S), div_y],
           fill=PANEL_EDGE, width=max(1, S))

    # terminal body lines
    body_x = panel_x0 + int(28 * S)
    line1_y = div_y + int(34 * S)
    m_f = mono(int(20 * S))
    m_small = mono(int(17 * S))

    # spinner glyph + status (the product line)
    # braille spinner head glyph
    spin_f = mono(int(22 * S))
    d.text((body_x, line1_y), "⠋", font=spin_f, fill=GREEN_HI)  # ⠋
    gx2 = body_x + int(30 * S)
    d.text((gx2, line1_y + int(1 * S)), "Discombobulating…", font=m_f, fill=TEXT)

    # second line: sponsored ad (the monetization line)
    line2_y = line1_y + int(56 * S)
    # leading bullet
    d.text((body_x, line2_y), "·", font=m_f, fill=MUTED)
    sx = body_x + int(22 * S)
    # "Sponsored:" amber tag
    spon = "Sponsored: "
    bbs = d.textbbox((0, 0), spon, font=m_small)
    d.text((sx, line2_y + int(3 * S)), spon, font=m_small, fill=AMBER)
    sx2 = sx + (bbs[2] - bbs[0])
    name = "Linear"
    bbn = d.textbbox((0, 0), name, font=mono(int(17 * S)))
    nf = mono(int(17 * S))
    d.text((sx2, line2_y + int(3 * S)), name, font=nf, fill=TEXT)
    sx3 = sx2 + (bbn[2] - bbn[0])
    tail = " — fast issue tracking "
    bbt = d.textbbox((0, 0), tail, font=m_small)
    d.text((sx3, line2_y + int(3 * S)), tail, font=m_small, fill=MUTED)
    sx4 = sx3 + (bbt[2] - bbt[0])
    d.text((sx4, line2_y + int(3 * S)), "→", font=nf, fill=GREEN_HI)

    # right-aligned timing "1.2s"
    tcol = mono(int(16 * S))
    tstr = "1.2s"
    bbtm = d.textbbox((0, 0), tstr, font=tcol)
    d.text((panel_x1 - int(28 * S) - (bbtm[2] - bbtm[0]), line2_y + int(4 * S)),
           tstr, font=tcol, fill=MUTED)

    # caret line
    line3_y = line2_y + int(54 * S)
    d.text((body_x, line3_y), "›", font=m_f, fill=GREEN_HI)
    d.rectangle([body_x + int(26 * S), line3_y + int(4 * S),
                 body_x + int(26 * S) + int(11 * S), line3_y + int(26 * S)],
                fill=(MUTED))

    img = img.resize((W, H), Image.LANCZOS).convert("RGB")
    return img


def main():
    icon = make_icon(128)
    icon.save(os.path.join(HERE, "icon.png"))
    print("wrote icon.png", icon.size)

    icon512 = make_icon(512)
    icon512.save(os.path.join(HERE, "icon-512.png"))
    print("wrote icon-512.png", icon512.size)

    banner = make_banner(1376, 768)
    banner.save(os.path.join(HERE, "marketplace-banner.png"))
    print("wrote marketplace-banner.png", banner.size)


if __name__ == "__main__":
    main()
