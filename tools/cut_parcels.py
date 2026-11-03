#!/usr/bin/env python3
"""公図（地図XML）から、区間の周りの筆だけを GeoJSON に切り出す。

主の地図は展開すると約 170MB あり、ブラウザでそのまま読むと重い。
道具の本体には、区間の両側 200m に入る筆だけを緯度経度にして渡す。
出典と「加工して作成」は GeoJSON の properties と data/README.md に書く。

使い方:
  .venv/bin/python tools/cut_parcels.py            # data/raw/xml/*.xml → data/ogawa/parcels.geojson
  .venv/bin/python tools/cut_parcels.py --buffer 300

任意座標系の地図（<座標系>任意座標系</座標系>）は緯度経度にできないので、ここでは読み飛ばす（案A の対象）。
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
from jgd8 import to_latlon, to_plane  # noqa: E402

NS = {"t": "http://www.moj.go.jp/MINJI/tizuxml", "z": "http://www.moj.go.jp/MINJI/tizuzumen"}
Z = "{%s}" % NS["z"]
T = "{%s}" % NS["t"]

KIND_RE = re.compile(r"^(道|水|無地番|地区外|別図|筆界未定地)-")


def kind(chiban: str) -> str:
    """地番の頭で種類を分ける。公図の「道-123」「無地番-45」のような書き方に合わせる。"""
    m = KIND_RE.match(chiban or "")
    return m.group(1) if m else "ふつう"


def parse(path: Path):
    """地図XML を流し読みして、筆ごとの外周（と穴）の座標列を返す。

    点は GM_Point で定義されたものを GM_Curve が id で参照する形と、
    GM_Curve の中に座標を直接書く形の両方がある（同じファイルに混ざる）。
    """
    pts, curves, surfs, fude, meta = {}, {}, {}, [], {}
    for _, el in ET.iterparse(path, events=("end",)):
        tag = el.tag
        if tag == Z + "GM_Point":
            p = el.find(".//z:DirectPosition", NS)
            pts[el.get("id")] = (float(p.find("z:X", NS).text), float(p.find("z:Y", NS).text))
            el.clear()
        elif tag == Z + "GM_Curve":
            seq = []
            for col in el.iter(Z + "GM_PointArray.column"):
                d = col.find("z:GM_Position.direct", NS)
                seq.append((float(d.find("z:X", NS).text), float(d.find("z:Y", NS).text)) if d is not None
                           else col.find(".//z:GM_PointRef.point", NS).get("idref"))
            curves[el.get("id")] = seq
            el.clear()
        elif tag == Z + "GM_Surface":
            ext = [g.get("idref") for g in el.find(".//z:GM_SurfaceBoundary.exterior", NS).iter(Z + "GM_CompositeCurve.generator")]
            holes = [[g.get("idref") for g in r.iter(Z + "GM_CompositeCurve.generator")] for r in el.findall(".//z:GM_SurfaceBoundary.interior", NS)]
            surfs[el.get("id")] = (ext, holes)
            el.clear()
        elif tag == T + "筆":
            # id は <筆 id="H000000001"> の属性。子要素だけ集めると落ちるので、別に取る
            d = {c.tag.replace(T, ""): (c.text if c.get("idref") is None else c.get("idref")) for c in el}
            d["id"] = el.get("id")
            fude.append(d)
            el.clear()
        elif tag in (T + "座標系", T + "地図名", T + "市区町村名"):
            meta[tag.replace(T, "")] = el.text

    def ring(ids):
        out = []
        for cid in ids:
            seq = [pts[c] if isinstance(c, str) else c for c in curves[cid]]
            if out and out[-1] == seq[0]:
                seq = seq[1:]
            out.extend(seq)
        if out and out[0] != out[-1]:
            out.append(out[0])
        return out

    polys = []
    for f in fude:
        s = surfs.get(f.get("形状"))
        if s is not None:
            polys.append((f, ring(s[0]), [ring(h) for h in s[1]]))
    return meta, polys


def line_xy(geojson: Path):
    g = json.loads(geojson.read_text(encoding="utf-8"))
    return np.array([to_plane(lat, lon) for lon, lat in g["features"][0]["geometry"]["coordinates"]])


def dist_to_line(pt, line):
    """点から折れ線までの最短距離（平面直角座標系の上。m）。"""
    a, b = line[:-1], line[1:]
    d = b - a
    L = np.einsum("ij,ij->i", d, d)
    t = np.clip(np.einsum("ij,ij->i", pt - a, d) / np.where(L == 0, 1, L), 0, 1)
    q = a + t[:, None] * d
    return float(np.min(np.hypot(*(q - pt).T)))


def near(ring, line, buffer):
    """筆の外周のどれかの点が線の buffer 以内にあれば「近い」。
    大きな筆（地区外など）は点が粗いので、辺の途中も 20m ごとに補って見る。"""
    r = np.array(ring)
    bx0, by0 = line.min(axis=0) - buffer
    bx1, by1 = line.max(axis=0) + buffer
    if r[:, 0].max() < bx0 or r[:, 0].min() > bx1 or r[:, 1].max() < by0 or r[:, 1].min() > by1:
        return False
    dense = [r[0]]
    for p, q in zip(r[:-1], r[1:]):
        n = int(np.hypot(*(q - p)) // 20)
        for k in range(1, n + 1):
            dense.append(p + (q - p) * k / (n + 1))
        dense.append(q)
    return any(dist_to_line(p, line) <= buffer for p in dense)


def line_samples(line, step=10.0):
    """線を step（m）ごとに打ち直した点。包含の確認用（道具の本体の containSamples と同じ刻み）。"""
    out = [line[0]]
    carry = 0.0
    for a, b in zip(line[:-1], line[1:]):
        L = float(np.hypot(*(b - a)))
        d = step - carry
        while d <= L:
            out.append(a + (b - a) * d / L)
            d += step
        carry = L - (d - step)
    out.append(line[-1])
    return np.array(out)


def contains_any(ring, samples):
    """線の点のどれかが筆の外周の中にあれば True。外周が線から遠い大きな筆（山林の筆の中を道が通る）を落とさないため
    （Codex の指摘 2026-11-03。道具の本体の containsAny と同じ）。縁の上は「中」に倒す。"""
    r = np.array(ring)
    inside_box = (samples[:, 0] >= r[:, 0].min()) & (samples[:, 0] <= r[:, 0].max()) & (samples[:, 1] >= r[:, 1].min()) & (samples[:, 1] <= r[:, 1].max())
    for x, y in samples[inside_box]:
        inside = False
        j = len(r) - 1
        for i in range(len(r)):
            xi, yi = r[i]
            xj, yj = r[j]
            if (yi > y) != (yj > y):
                xc = (xj - xi) * (y - yi) / (yj - yi) + xi
                if x < xc:
                    inside = not inside
                elif abs(x - xc) < 1e-9:
                    return True
            j = i
        if inside:
            return True
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xml-dir", type=Path, default=REPO / "data/raw/xml")
    ap.add_argument("--section", type=Path, default=REPO / "data/ogawa/section.geojson")
    ap.add_argument("--out", type=Path, default=REPO / "data/ogawa/parcels.geojson")
    ap.add_argument("--buffer", type=float, default=200.0, help="区間の線からの距離（m）")
    args = ap.parse_args()

    line = line_xy(args.section)
    samples = line_samples(line)
    feats = []
    for xml in sorted(args.xml_dir.glob("*.xml")):
        meta, polys = parse(xml)
        if not meta.get("座標系", "").startswith("公共"):
            print(f"{xml.name}: {meta.get('座標系')} なので読み飛ばす")
            continue
        n = 0
        for f, ext, holes in polys:
            if not near(ext, line, args.buffer) and not contains_any(ext, samples):
                continue
            rings = [[list(to_latlon(x, y))[::-1] for x, y in r] for r in [ext] + holes]  # GeoJSON は [経度, 緯度]
            feats.append({
                "type": "Feature",
                "properties": {
                    "id": f"{xml.stem}:{f.get('id')}",
                    "map": xml.stem,
                    "oaza": f.get("大字名"),
                    "chiban": f.get("地番"),
                    "kind": kind(f.get("地番")),
                    "accuracy": f.get("精度区分"),
                    "survey": f.get("座標値種別"),
                },
                "geometry": {"type": "Polygon", "coordinates": [[[round(lon, 7), round(lat, 7)] for lon, lat in r] for r in rings]},
            })
            n += 1
        print(f"{xml.name}: {len(polys)} 筆のうち {n} 筆を切り出し")

    fc = {
        "type": "FeatureCollection",
        "name": "デモの区間の周りの筆（長野県上水内郡小川村）",
        "source": "「登記所備付地図データ 上水内郡小川村」（法務省）（https://www.geospatial.jp/ckan/dataset/houmusyouchizu-2026-1-995）（2026年11月2日に利用）を加工して作成。2026年版（令和8年2月時点）。区間の両側 %dm の筆だけを切り出し、公共座標8系から緯度経度に換算した" % args.buffer,
        "made_by": "tools/cut_parcels.py",
        "features": feats,
    }
    args.out.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    from collections import Counter
    print(f"合計 {len(feats)} 筆 {Counter(f['properties']['kind'] for f in feats)} → {args.out.relative_to(REPO)} ({args.out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
