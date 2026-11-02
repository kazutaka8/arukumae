"""案C の試し：区切りごとに、林野庁の森林計画対象森林の区域に入っている割合を出す。

本体では林野庁のベクトルタイルから面で計算する予定。試しでは手早く、
ラスタタイル（区域の外は透明）を区切りの中で数え、色の付いた画素の割合を使う。

使い方: .venv/bin/python experiments/case_c/forest.py A B
"""

from __future__ import annotations

import io
import json
import math
import sys
import urllib.request

from PIL import Image, ImageDraw

from segments import OUT_DIR, TILE_DIR, build_segments, ll_to_px, to_ll

Z = 16  # 森林レイヤのラスタは z16 まで（約 2m／画素）。区切り（10m×10m）に 20 画素ほど入る
URL = "https://rinya-tiles.geospatial.jp/fr_layer_webp_2025/{z}/{x}/{y}.webp"


def tile(x, y):
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    p = TILE_DIR / f"forest_{Z}_{x}_{y}.webp"
    if not p.exists():
        req = urllib.request.Request(URL.format(z=Z, x=x, y=y), headers={"User-Agent": "arukumae/0.1 (experiments)"})
        with urllib.request.urlopen(req, timeout=30) as r:
            p.write_bytes(r.read())
    return Image.open(io.BytesIO(p.read_bytes())).convert("RGBA")


def main():
    segs, _, origin = build_segments()
    cache = {}
    for w in sys.argv[1:]:
        ids = {s["id"] for s in json.loads((OUT_DIR / f"{w}_segments.json").read_text(encoding="utf-8"))}
        out = {}
        for s in (s for s in segs if s["id"] in ids):
            pxs = [ll_to_px(*to_ll(x, y, origin), Z) for x, y in s["xy"]]
            x0, y0 = int(min(p[0] for p in pxs)), int(min(p[1] for p in pxs))
            x1, y1 = int(max(p[0] for p in pxs)) + 1, int(max(p[1] for p in pxs)) + 1
            mask = Image.new("L", (x1 - x0, y1 - y0), 0)
            ImageDraw.Draw(mask).polygon([(p[0] - x0, p[1] - y0) for p in pxs], fill=255)
            inside = colored = 0
            for yy in range(y0, y1):
                for xx in range(x0, x1):
                    if not mask.getpixel((xx - x0, yy - y0)):
                        continue
                    key = (xx // 256, yy // 256)
                    if key not in cache:
                        cache[key] = tile(*key)
                    a = cache[key].getpixel((xx % 256, yy % 256))[3]
                    inside += 1
                    colored += a > 0
            out[s["id"]] = round(colored / inside, 2) if inside else None
        (OUT_DIR / f"{w}_forest.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        vals = [v for v in out.values() if v is not None]
        print(f"{w}: 区切り {len(out)}、森林の区域に半分以上入る区切り {sum(v >= 0.5 for v in vals)}")


if __name__ == "__main__":
    main()
