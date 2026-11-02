#!/usr/bin/env python3
"""案A の試しで Claude に見せる 2 枚の絵を作る（どちらも公開データ）。

1. map1.png：任意座標系の公図（20588-1000-1）の線画。白地に黒い筆界、地番、北を上（X が北と仮定）、目盛り。
   座標はこの図面の中だけのもので、位置の手がかりは地番と形だけ
2. photo.jpg：粗い正解（match.py）の置き場所の周り（余白 300m）の航空写真（地理院タイル z17）。
   どちらの絵にも 200 画素ごとの薄い格子と画素の目盛りを入れ、Claude が「どの画素か」を答えやすくする

使い方:
  .venv/bin/python experiments/case_a/render.py
"""

from __future__ import annotations

import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "tools"))
from cut_parcels import kind, parse  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
TILES = HERE / "tiles"
Z = 17
TILE = 256
FONT = "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc"


def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def grid(img: Image.Image, step=200):
    """画素の格子と目盛り。Claude が画素の位置を答えるときの物差し"""
    d = ImageDraw.Draw(img, "RGBA")
    w, h = img.size
    f = font(14)
    for x in range(0, w, step):
        d.line([(x, 0), (x, h)], fill=(255, 0, 255, 90), width=1)
        d.text((x + 3, 2), str(x), fill=(255, 0, 255, 255), font=f)
    for y in range(0, h, step):
        d.line([(0, y), (w, y)], fill=(255, 0, 255, 90), width=1)
        d.text((3, y + 2), str(y), fill=(255, 0, 255, 255), font=f)


def render_map():
    meta, polys = parse(REPO / "data/raw/xml/20588-1000-1.xml")
    pts = np.array([p for _, ext, _ in polys for p in ext])
    x0, y0 = pts.min(axis=0)
    x1, y1 = pts.max(axis=0)
    scale = 1.0  # 1 画素 = 1 m（図面の座標が m と仮定）
    pad = 40
    w = int((y1 - y0) / scale) + 2 * pad
    h = int((x1 - x0) / scale) + 2 * pad
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)

    def px(p):
        # X が北（上）、Y が東（右）
        return (pad + (p[1] - y0) / scale, pad + (x1 - p[0]) / scale)

    colors = {"道": (160, 160, 160), "水": (120, 170, 220)}
    for f, ext, holes in polys:
        k = kind(f.get("地番"))
        poly = [px(p) for p in ext]
        if k in colors:
            d.polygon(poly, fill=colors[k])
    for f, ext, holes in polys:
        for r in [ext] + holes:
            d.line([px(p) for p in r], fill="black", width=1)
    f_small = font(9)
    for f, ext, _ in polys:
        k = kind(f.get("地番"))
        if k in ("地区外", "別図"):
            continue
        r = np.array(ext)
        c = px(r.mean(axis=0))
        label = f.get("地番") or ""
        if k != "ふつう":
            label = k
        d.text((c[0] - 3 * len(label), c[1] - 5), label, fill=(60, 60, 60), font=f_small)
    # 目盛り（100m。図面の座標が m という仮定を絵にも書く）
    d.line([(pad, h - 15), (pad + 100 / scale, h - 15)], fill="black", width=3)
    d.text((pad, h - 32), "100（図面の座標の単位。m と思われる）", fill="black", font=font(12))
    d.text((w - 60, 8), "北↑", fill="black", font=font(14))
    grid(img)
    img.save(OUT / "map1.png")
    print(f"map1.png {w}×{h}、筆 {len(polys)}、範囲 X {x0:.0f}〜{x1:.0f} Y {y0:.0f}〜{y1:.0f}")
    (OUT / "map1_frame.json").write_text(json.dumps({"pad": pad, "scale": scale, "x0": x0, "x1": x1, "y0": y0, "y1": y1, "w": w, "h": h, "note": "px = (pad + (Y - y0)/scale, pad + (x1 - X)/scale)"}), encoding="utf-8")


def lonlat_to_px(lon, lat, z=Z):
    n = 2**z * TILE
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def px_to_lonlat(x, y, z=Z):
    n = 2**z * TILE
    lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def fetch_tile(x, y, z=Z):
    TILES.mkdir(exist_ok=True)
    p = TILES / f"{z}_{x}_{y}.jpg"
    if not p.exists():
        url = f"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
        req = urllib.request.Request(url, headers={"User-Agent": "arukumae-experiment"})
        with urllib.request.urlopen(req, timeout=30) as r:
            p.write_bytes(r.read())
    return Image.open(p).convert("RGB")


def render_photo():
    truth = json.loads((OUT / "truth.json").read_text(encoding="utf-8"))
    lon0, lat0, lon1, lat1 = truth["bbox_placed_lonlat"]
    # 余白 300m。緯度 1° ≈ 111km、経度 1° ≈ 89km（北緯 36.6°）
    dlat, dlon = 300 / 111_000, 300 / 89_000
    X0, Y1 = lonlat_to_px(lon0 - dlon, lat0 - dlat)
    X1, Y0 = lonlat_to_px(lon1 + dlon, lat1 + dlat)
    tx0, tx1 = int(X0 // TILE), int(X1 // TILE)
    ty0, ty1 = int(Y0 // TILE), int(Y1 // TILE)
    w, h = int(X1 - X0), int(Y1 - Y0)
    img = Image.new("RGB", (w, h))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            img.paste(fetch_tile(tx, ty), (int(tx * TILE - X0), int(ty * TILE - Y0)))
    m_per_px = 40_075_016.686 * math.cos(math.radians((lat0 + lat1) / 2)) / (2**Z * TILE)
    d = ImageDraw.Draw(img)
    d.line([(20, h - 20), (20 + 200 / m_per_px, h - 20)], fill="white", width=4)
    d.text((20, h - 40), "200m", fill="white", font=font(14))
    d.text((w - 60, 8), "北↑", fill="white", font=font(14))
    grid(img)
    img.save(OUT / "photo.jpg", quality=88)
    (OUT / "photo_frame.json").write_text(json.dumps({"X0": X0, "Y0": Y0, "z": Z, "w": w, "h": h, "m_per_px": m_per_px, "note": "lonlat = px_to_lonlat(X0 + px, Y0 + py)"}), encoding="utf-8")
    print(f"photo.jpg {w}×{h}、{m_per_px:.2f} m/px、タイル {(tx1-tx0+1)*(ty1-ty0+1)} 枚")


if __name__ == "__main__":
    render_map()
    render_photo()
