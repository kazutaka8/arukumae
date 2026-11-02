"""案C の試し：区切りを作り、航空写真に重ねた画像を作る。

仕様（docs/spec.md §8.4）の区切りを、道具の本体（TypeScript）を作る前に Python で試す。
Claude に何を見せればよく判定できるかを、本体の設計より先に確かめたいため。

使い方:
  .venv/bin/python experiments/case_c/segments.py overview
  .venv/bin/python experiments/case_c/segments.py crop A 0.00 0.20
"""

from __future__ import annotations

import io
import json
import math
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
TILE_DIR = HERE / "tiles"  # 地理院タイルの写し。リポジトリには入れない（.gitignore）
OUT_DIR = HERE / "out"

STEP = 10.0  # 区切りの長さ（m）。仕様の初期値
ROAD_HALF = 3.0  # 道路の半幅（m）。区切りは道路の端から外側を取る
BAND_OUT = 13.0  # 試しの伐採範囲の外側（中心線から m）。架空の軌跡図ができるまでの仮の値
R = 6_371_008.8
Z = 18  # 全国最新写真は z18 まで（約 0.48m／画素）
PHOTO_URL = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"


def load_line():
    g = json.loads((REPO / "data/ogawa/section.geojson").read_text(encoding="utf-8"))
    coords = g["features"][0]["geometry"]["coordinates"]  # [経度, 緯度]
    lat0 = sum(c[1] for c in coords) / len(coords)
    lon0 = sum(c[0] for c in coords) / len(coords)
    return [(c[1], c[0]) for c in coords], (lat0, lon0)


def to_xy(lat, lon, origin):
    # 1.5km の区間なら、原点まわりの正距円筒で十分（ひずみは 1m に届かない）
    lat0, lon0 = origin
    return (math.radians(lon - lon0) * R * math.cos(math.radians(lat0)), math.radians(lat - lat0) * R)


def to_ll(x, y, origin):
    lat0, lon0 = origin
    return (lat0 + math.degrees(y / R), lon0 + math.degrees(x / (R * math.cos(math.radians(lat0)))))


def resample(pts, step=1.0):
    """中心線を 1m ごとの点に打ち直す。区切りの境目を距離で決めるため。"""
    out = [pts[0]]
    acc = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        L = math.hypot(x2 - x1, y2 - y1)
        d = step - acc
        while d <= L:
            t = d / L
            out.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
            d += step
        acc = L - (d - step)
    return out


def normals(pts, span=3):
    # 前後 3m の点から向きを取る。1 点ずつだと OSM の細かい折れで法線が暴れるため
    ns = []
    for i in range(len(pts)):
        a = pts[max(0, i - span)]
        b = pts[min(len(pts) - 1, i + span)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        ns.append((-ty / L, tx / L))  # 進行方向の左
    return ns


def build_segments():
    line, origin = load_line()
    xy = resample([to_xy(la, lo, origin) for la, lo in line])
    ns = normals(xy)
    n_seg = int((len(xy) - 1) // STEP)
    segs = []
    for k in range(n_seg + 1):
        i0, i1 = int(k * STEP), min(int((k + 1) * STEP), len(xy) - 1)
        if i1 - i0 < 2:
            break
        for side, sgn in (("L", 1), ("R", -1)):
            inner = [(xy[i][0] + sgn * ns[i][0] * ROAD_HALF, xy[i][1] + sgn * ns[i][1] * ROAD_HALF) for i in range(i0, i1 + 1)]
            outer = [(xy[i][0] + sgn * ns[i][0] * BAND_OUT, xy[i][1] + sgn * ns[i][1] * BAND_OUT) for i in range(i0, i1 + 1)]
            segs.append({
                "id": f"{side}{k:03d}",  # L032 = KP 0.320〜0.330 の左
                "kp_from": round(i0 / 1000, 3),
                "kp_to": round(i1 / 1000, 3),
                "side": side,
                "xy": inner + outer[::-1],
            })
    return segs, xy, origin


# --- 地理院タイル ---

def ll_to_px(lat, lon, z=Z):
    n = 2 ** z * 256
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def tile(z, x, y):
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    p = TILE_DIR / f"{z}_{x}_{y}.jpg"
    if not p.exists():
        req = urllib.request.Request(PHOTO_URL.format(z=z, x=x, y=y), headers={"User-Agent": "arukumae/0.1 (experiments)"})
        with urllib.request.urlopen(req, timeout=30) as r:
            p.write_bytes(r.read())
    return Image.open(io.BytesIO(p.read_bytes())).convert("RGB")


def mosaic(lat_min, lon_min, lat_max, lon_max, z=Z):
    x0, y1 = ll_to_px(lat_min, lon_min, z)
    x1, y0 = ll_to_px(lat_max, lon_max, z)
    tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)
    img = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            img.paste(tile(z, tx, ty), ((tx - tx0) * 256, (ty - ty0) * 256))
    crop = (int(x0 - tx0 * 256), int(y0 - ty0 * 256), int(x1 - tx0 * 256), int(y1 - ty0 * 256))
    return img.crop(crop), (x0, y0)


def font(size):
    return ImageFont.load_default(size=size)


def overview():
    segs, xy, origin = build_segments()
    lls = [to_ll(x, y, origin) for x, y in xy]
    pad = 0.0004
    la = [p[0] for p in lls]
    lo = [p[1] for p in lls]
    img, (ox, oy) = mosaic(min(la) - pad, min(lo) - pad, max(la) + pad, max(lo) + pad, z=17)
    d = ImageDraw.Draw(img)
    pts = [(ll_to_px(a, b, 17)[0] - ox, ll_to_px(a, b, 17)[1] - oy) for a, b in lls]
    d.line(pts, fill=(255, 60, 60), width=2)
    for m in range(0, len(pts), 100):
        x, y = pts[m]
        d.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(255, 255, 0))
        d.text((x + 6, y - 8), f"{m / 1000:.1f}", fill=(255, 255, 0), font=font(14), stroke_width=2, stroke_fill=(0, 0, 0))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img.save(OUT_DIR / "overview.png")
    print("書き出し:", OUT_DIR / "overview.png", img.size)


def crop(name, kp_from, kp_to, scale=3):
    """KP の範囲の区切りを、札なし・札ありの2枚の画像にする。"""
    segs, xy, origin = build_segments()
    sel = [s for s in segs if s["kp_from"] >= kp_from - 1e-9 and s["kp_to"] <= kp_to + 1e-9]
    lls = [to_ll(x, y, origin) for s in sel for x, y in s["xy"]]
    pad = 15 / R * 180 / math.pi  # まわりに 15m の余白
    la = [p[0] for p in lls]
    lo = [p[1] for p in lls]
    base, (ox, oy) = mosaic(min(la) - pad, min(lo) - pad / math.cos(math.radians(la[0])), max(la) + pad, max(lo) + pad / math.cos(math.radians(la[0])))
    # 0.48m／画素のままだと 10m の区切りが 20 画素ほどで札が読めないので、拡大する
    base = base.resize((base.width * scale, base.height * scale), Image.LANCZOS)

    def px(lat, lon):
        x, y = ll_to_px(lat, lon)
        return ((x - ox) * scale, (y - oy) * scale)

    plain = base.copy()
    labeled = base.copy()
    d = ImageDraw.Draw(labeled)
    for s in sel:
        poly = [px(*to_ll(x, y, origin)) for x, y in s["xy"]]
        color = (255, 230, 0) if s["side"] == "L" else (0, 220, 255)
        d.polygon(poly, outline=color, width=2)
    for s in sel:
        poly = [px(*to_ll(x, y, origin)) for x, y in s["xy"]]
        cx = sum(p[0] for p in poly) / len(poly)
        cy = sum(p[1] for p in poly) / len(poly)
        d.text((cx, cy), s["id"], fill=(255, 255, 255), font=font(15), anchor="mm", stroke_width=3, stroke_fill=(0, 0, 0))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plain.save(OUT_DIR / f"{name}_plain.jpg", quality=90)
    labeled.save(OUT_DIR / f"{name}_labeled.jpg", quality=90)
    meta = [{k: v for k, v in s.items() if k != "xy"} | {"area_m2": round(poly_area(s["xy"]), 1)} for s in sel]
    (OUT_DIR / f"{name}_segments.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{name}: 区切り {len(sel)}、画像 {plain.size}")


def poly_area(p):
    return 0.5 * abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(p, p[1:] + p[:1])))


if __name__ == "__main__":
    if sys.argv[1] == "overview":
        overview()
    elif sys.argv[1] == "crop":
        crop(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))
