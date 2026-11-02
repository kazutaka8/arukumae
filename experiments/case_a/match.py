#!/usr/bin/env python3
"""案A の粗い正解づくり：任意座標系の地図（20588-1000-1）を、地番の並びから公共座標系の地図（-6）の上に置く。

任意座標系の地図は図面の中だけの座標で、そのままでは地図に重ならない（spec §8.5）。
小川村の -1（大字稲丘、ふつうの筆 407）と同じ大字・地番の筆は、公共座標系の地図には 1 つもなかった（2026-11-03 に数えた）。
-1 の地番（474〜1189）は -6 の地番の並びの隙間に当たり、-6 には同じ「地番の底」（枝番の前の数。537-1 と 537-2 など）の筆が 19 ある。
枝番違いの筆はふつう隣り合うので、その重心どうしを「だいたい同じ所」とみなしてヘルマート変換（平行移動・回転・縮尺）を最小二乗で求める。
数十 m の誤差を含む粗い正解で、Claude の出す基準点の組（run.py）が「当たらずとも遠からず」かを測る物差しにする。

使い方:
  .venv/bin/python experiments/case_a/match.py   # → out/truth.json、out/map1_truth.geojson
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "tools"))
from cut_parcels import kind, parse  # noqa: E402
from jgd8 import to_latlon  # noqa: E402

OUT = Path(__file__).resolve().parent / "out"
XML = REPO / "data/raw/xml"


def centroid(ring):
    """多角形の重心（面積で重み付け）。X=北、Y=東のまま。"""
    r = np.array(ring, dtype=float)
    x, y = r[:, 0], r[:, 1]
    cross = x[:-1] * y[1:] - x[1:] * y[:-1]
    a = cross.sum() / 2
    if abs(a) < 1e-9:
        return r.mean(axis=0), 0.0
    cx = ((x[:-1] + x[1:]) * cross).sum() / (6 * a)
    cy = ((y[:-1] + y[1:]) * cross).sum() / (6 * a)
    return np.array([cx, cy]), abs(a)


def helmert(src, dst):
    """src（n×2）を dst に重ねる 4 パラメータの相似変換 dst ≈ s·R·src + t を最小二乗で求める。
    返すのは (a, b, tx, ty)：dst_x = a·x − b·y + tx、dst_y = b·x + a·y + ty。縮尺 = hypot(a, b)、回転 = atan2(b, a)。"""
    n = len(src)
    A = np.zeros((2 * n, 4))
    A[0::2, 0] = src[:, 0]
    A[0::2, 1] = -src[:, 1]
    A[0::2, 2] = 1
    A[1::2, 0] = src[:, 1]
    A[1::2, 1] = src[:, 0]
    A[1::2, 3] = 1
    b = dst.reshape(-1)
    p, *_ = np.linalg.lstsq(A, b, rcond=None)
    return p


def apply(p, pts):
    a, b, tx, ty = p
    pts = np.asarray(pts, dtype=float)
    return np.stack([a * pts[:, 0] - b * pts[:, 1] + tx, b * pts[:, 0] + a * pts[:, 1] + ty], axis=1)


def main():
    meta1, polys1 = parse(XML / "20588-1000-1.xml")
    assert not meta1.get("座標系", "").startswith("公共"), meta1
    # 地番の底ごとに、筆の重心の平均（面積で重み付け）を取る
    def base(chiban):
        m = re.match(r"(\d+)", chiban or "")
        return int(m.group(1)) if m else None

    def collect(polys, stem):
        acc = {}
        for f, ext, _ in polys:
            if kind(f.get("地番")) != "ふつう":
                continue
            c, area = centroid(ext)
            key = (f.get("大字名"), base(f.get("地番")))
            cs, w, n = acc.get(key, (np.zeros(2), 0.0, 0))
            acc[key] = (cs + c * max(area, 1), w + max(area, 1), n + 1)
        return {k: ((cs / w), w, n, stem) for k, (cs, w, n) in acc.items()}

    arb = collect(polys1, "20588-1000-1")
    print(f"-1（{meta1.get('座標系')}）：地番の底 {len(arb)}、大字 {sorted({k[0] for k in arb})}")

    pub = {}
    for xml in sorted(XML.glob("*.xml")):
        if xml.stem == "20588-1000-1":
            continue
        meta, polys = parse(xml)
        if not meta.get("座標系", "").startswith("公共"):
            continue
        for key, (c, w, n, stem) in collect(polys, xml.stem).items():
            if key in arb:
                pub.setdefault(key, []).append((stem, c, w))
    dup = {k: v for k, v in pub.items() if len(v) > 1}
    keys = sorted(k for k in pub if len(pub[k]) == 1)
    print(f"同じ大字・地番の底が公共座標系にある {len(pub)}（うち 2 枚以上の地図にある {len(dup)} は外す）→ 使う組 {len(keys)}")
    by_map = {}
    for k in keys:
        by_map[pub[k][0][0]] = by_map.get(pub[k][0][0], 0) + 1
    print("地図ごと：", by_map)

    src = np.array([arb[k][0] for k in keys])
    dst = np.array([pub[k][0][1] for k in keys])
    use = np.ones(len(keys), bool)
    for it in range(20):
        p = helmert(src[use], dst[use])
        res = np.hypot(*(apply(p, src) - dst).T)
        rms = math.sqrt((res[use] ** 2).mean())
        thr = max(3 * rms, 30.0)  # 枝番違いの筆は隣どうしなので、数十 m はずれて当たり前
        new_use = res <= thr
        print(f"  {it}: 使う {use.sum()}、RMS {rms:.2f}m、最大 {res[use].max():.2f}m、縮尺 {math.hypot(p[0], p[1]):.5f}、回転 {math.degrees(math.atan2(p[1], p[0])):.3f}°")
        if (new_use == use).all():
            break
        use = new_use
    a, b, tx, ty = p
    scale = math.hypot(a, b)
    rot = math.degrees(math.atan2(b, a))
    res_use = res[use]
    print(f"結果：組 {use.sum()}／{len(keys)}、RMS {math.sqrt((res_use**2).mean()):.2f}m、中央値 {np.median(res_use):.2f}m、9割 {np.percentile(res_use, 90):.2f}m、外した {int((~use).sum())}")
    print(f"縮尺 {scale:.5f}、回転 {rot:.3f}°、平行移動 X(北) {tx:.1f}、Y(東) {ty:.1f}")

    # 任意座標系の地図の範囲と、置いた先の範囲
    all_pts = np.array([pt for _, ext, _ in polys1 for pt in ext])
    placed = apply(p, all_pts)
    lat0, lon0 = to_latlon(*placed.min(axis=0))
    lat1, lon1 = to_latlon(*placed.max(axis=0))
    print(f"任意座標の範囲：X {all_pts[:,0].min():.0f}〜{all_pts[:,0].max():.0f}、Y {all_pts[:,1].min():.0f}〜{all_pts[:,1].max():.0f}（{np.ptp(all_pts[:,0]):.0f}m × {np.ptp(all_pts[:,1]):.0f}m）")
    print(f"置いた先：北緯 {lat0:.5f}〜{lat1:.5f}、東経 {lon0:.5f}〜{lon1:.5f}")

    truth = {
        "source": "20588-1000-1（任意座標系）を、同じ大字・地番の底（枝番の前の数）の筆が -6 にあることから粗く置いた。重心どうしのヘルマート変換（最小二乗、3σ で外れを除く）。数十 m の誤差を含む",
        "pairs_used": int(use.sum()),
        "pairs_total": len(keys),
        "rms_m": float(math.sqrt((res_use**2).mean())),
        "median_m": float(np.median(res_use)),
        "p90_m": float(np.percentile(res_use, 90)),
        "scale": scale,
        "rotation_deg": rot,
        "helmert": {"a": a, "b": b, "tx": tx, "ty": ty, "note": "X=北, Y=東。dst_x = a·x − b·y + tx、dst_y = b·x + a·y + ty"},
        "bbox_arbitrary": {"x": [float(all_pts[:, 0].min()), float(all_pts[:, 0].max())], "y": [float(all_pts[:, 1].min()), float(all_pts[:, 1].max())]},
        "bbox_placed_lonlat": [lon0, lat0, lon1, lat1],
        "pairs": [
            {"oaza": k[0], "chiban_base": k[1], "map": pub[k][0][0], "arb_xy": [float(v) for v in arb[k][0]], "pub_xy": [float(v) for v in pub[k][0][1]], "residual_m": float(res[i]), "used": bool(use[i])}
            for i, k in enumerate(keys)
        ],
    }
    (OUT / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1), encoding="utf-8")

    feats = []
    for f, ext, holes in polys1:
        rings = [apply(p, r) for r in [ext] + holes]
        feats.append({
            "type": "Feature",
            "properties": {"id": f"20588-1000-1:{f.get('id')}", "oaza": f.get("大字名"), "chiban": f.get("地番"), "kind": kind(f.get("地番"))},
            "geometry": {"type": "Polygon", "coordinates": [[[round(lon, 7), round(lat, 7)] for lat, lon in (to_latlon(x, y) for x, y in r)] for r in rings]},
        })
    fc = {"type": "FeatureCollection", "name": "任意座標系の地図 -1 を正解の変換で置いたもの（試し）", "source": "「登記所備付地図データ 上水内郡小川村」（法務省）を加工して作成", "features": feats}
    (OUT / "map1_truth.geojson").write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"→ {OUT / 'truth.json'}、{OUT / 'map1_truth.geojson'}（{len(feats)} 筆）")


if __name__ == "__main__":
    main()
