#!/usr/bin/env python3
"""デモの輸送路区間（中心線）を、OpenStreetMap の道路の線から作る。

区間の起点・終点は仕様書（docs/spec.md の「デモの舞台」）で決めた座標。
道路の線そのものは、期間中に OpenStreetMap から取り直して作る。
期間前に用意した線のファイルを写すと「新規制作」と区別できなくなるため。

使い方:
  python3 tools/make_section.py                    # Overpass API から取得して書き出す
  python3 tools/make_section.py --osm-json FILE    # 保存した応答から作り直す（通信しない）

標準ライブラリだけで動く。道具を増やすたびに環境づくりで止まりたくないため。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "data" / "ogawa"

# 起点（0m）と終点。南端の畑と民家のあたりから、北端の稲丘の集落へ。
START = (36.644648, 137.991895)  # (緯度, 経度)
END = (36.650153, 137.986980)

# 区間の周りだけを問い合わせる。県道401号は長いので、全線を取ると関係ない所まで繋がる。
BBOX = (36.640, 137.982, 36.655, 137.997)  # (南, 西, 北, 東)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
QUERY = (
    '[out:json][timeout:50];'
    'way["highway"]["ref"="401"]({},{},{},{});'
    'out geom tags;'
).format(*BBOX)

EARTH_R = 6_371_008.8  # 平均半径（m）。1.5km の区間なら楕円体との差は無視できる


def fetch_overpass() -> dict:
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    req = urllib.request.Request(
        OVERPASS_URL,
        data=data,
        # Overpass は名乗らない問い合わせを断ることがある
        headers={"User-Agent": "arukumae/0.1 (tools/make_section.py)"},
    )
    with urllib.request.urlopen(req, timeout=90) as res:
        return json.load(res)


def key(lat: float, lon: float) -> tuple[int, int]:
    # 隣り合う way の端点は同じノードなので、座標を丸めて突き合わせれば繋がる
    return (round(lat * 1e7), round(lon * 1e7))


def stitch(ways: list[list[tuple[float, float]]]) -> list[tuple[float, float]]:
    """端点を共有する way を1本の線に繋ぐ。

    OSM の way は向きがばらばらなので、必要なら裏返して繋ぐ。
    途中で分かれ道があると1本に決まらないので、そのときは止める
    （黙って片方を選ぶと、区間がいつの間にか別の道を通ることになる）。
    """
    ends: dict[tuple[int, int], list[int]] = {}
    for i, w in enumerate(ways):
        for p in (w[0], w[-1]):
            ends.setdefault(key(*p), []).append(i)
    for k, idx in ends.items():
        if len(idx) > 2:
            sys.exit(f"分かれ道があり、1本に繋げない: {k} に way が {len(idx)} 本")

    # 片方の端がどこにも繋がっていない way から始める
    first = next(
        i for i, w in enumerate(ways)
        if len(ends[key(*w[0])]) == 1 or len(ends[key(*w[-1])]) == 1
    )
    line = list(ways[first])
    if len(ends[key(*line[0])]) != 1:
        line.reverse()
    used = {first}
    while len(used) < len(ways):
        tail = key(*line[-1])
        nxt = [i for i in ends[tail] if i not in used]
        if not nxt:
            sys.exit("途中で途切れている。BBOX を広げるか、OSM の線を確かめる")
        w = list(ways[nxt[0]])
        if key(*w[0]) != tail:
            w.reverse()
        line.extend(w[1:])
        used.add(nxt[0])
    return line


def to_xy(p: tuple[float, float], lat0: float) -> tuple[float, float]:
    # 区間は 1km 四方ほどなので、正距円筒で平面に近似して投影の計算をする
    lat, lon = p
    x = math.radians(lon) * EARTH_R * math.cos(math.radians(lat0))
    y = math.radians(lat) * EARTH_R
    return x, y


def project(line: list[tuple[float, float]], p: tuple[float, float]) -> tuple[int, float, tuple[float, float]]:
    """点 p に最も近い線上の位置を返す（辺の番号、辺の中の割合、その位置の緯度経度）。"""
    lat0 = p[0]
    px, py = to_xy(p, lat0)
    best = (math.inf, 0, 0.0)
    for i in range(len(line) - 1):
        ax, ay = to_xy(line[i], lat0)
        bx, by = to_xy(line[i + 1], lat0)
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
        d = math.hypot(ax + t * dx - px, ay + t * dy - py)
        if d < best[0]:
            best = (d, i, t)
    d, i, t = best
    if d > 30:
        # 起点・終点が道から離れているなら、座標か取得した道のどちらかが違う
        sys.exit(f"点 {p} が道から {d:.0f}m 離れている")
    a, b = line[i], line[i + 1]
    q = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return i, t, q


def cut(line: list[tuple[float, float]], start: tuple[float, float], end: tuple[float, float]) -> list[tuple[float, float]]:
    i, ti, s = project(line, start)
    j, tj, e = project(line, end)
    if (i, ti) > (j, tj):
        # 繋いだ線の向きが北→南だったときは、裏返して南→北（輸送の向き）にそろえる
        line = line[::-1]
        i, ti, s = project(line, start)
        j, tj, e = project(line, end)
    out = [s] + line[i + 1 : j + 1] + [e]
    # 起点・終点がちょうどノードの上にあると、同じ点が2つ並ぶので除く
    dedup = [out[0]]
    for p in out[1:]:
        if key(*p) != key(*dedup[-1]):
            dedup.append(p)
    return [(round(a, 7), round(b, 7)) for a, b in dedup]


def length_m(line: list[tuple[float, float]]) -> float:
    total = 0.0
    for (la1, lo1), (la2, lo2) in zip(line, line[1:]):
        p1, p2 = math.radians(la1), math.radians(la2)
        dp, dl = p2 - p1, math.radians(lo2 - lo1)
        h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        total += 2 * EARTH_R * math.asin(math.sqrt(h))
    return total


def write_geojson(path: Path, line, props) -> None:
    fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": props,
            # GeoJSON は [経度, 緯度] の順
            "geometry": {"type": "LineString", "coordinates": [[lon, lat] for lat, lon in line]},
        }],
    }
    path.write_text(json.dumps(fc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def write_kml(path: Path, line, props) -> None:
    coords = " ".join(f"{lon:.7f},{lat:.7f},0" for lat, lon in line)
    (slat, slon), (elat, elon) = line[0], line[-1]
    # Google マイマップに読み込めるよう、スタイルは最小限にする
    kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>{props["name"]}</name>
  <description>{props["source"]}。約 {props["length_m"]} m。</description>
  <Style id="center"><LineStyle><color>ff2f6bff</color><width>4</width></LineStyle></Style>
  <Placemark>
    <name>中心線（南→北）</name>
    <styleUrl>#center</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>{coords}</coordinates></LineString>
  </Placemark>
  <Placemark><name>起点（0m）</name><Point><coordinates>{slon:.7f},{slat:.7f},0</coordinates></Point></Placemark>
  <Placemark><name>終点</name><Point><coordinates>{elon:.7f},{elat:.7f},0</coordinates></Point></Placemark>
</Document>
</kml>
"""
    path.write_text(kml, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--osm-json", type=Path, help="保存した Overpass の応答（指定すると通信しない）")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = OUT_DIR / "osm_ref401.json"
    if args.osm_json:
        osm = json.loads(args.osm_json.read_text(encoding="utf-8"))
    else:
        osm = fetch_overpass()
        # OSM は日々書き換わるので、作ったときの応答を残しておけば同じ線を作り直せる
        raw_path.write_text(json.dumps(osm, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    ways = [e for e in osm["elements"] if e["type"] == "way" and e.get("geometry")]
    if not ways:
        sys.exit("道路の線が取れなかった")
    names = sorted({w["tags"].get("name", "") for w in ways})
    line = cut(stitch([[(g["lat"], g["lon"]) for g in w["geometry"]] for w in ways]), START, END)

    props = {
        "name": "デモの輸送路区間（小川村 県道401号 小川長野線の一部。南→北）",
        "road_name": " / ".join(n for n in names if n),
        "road_ref": "401",
        "direction": "南→北（最初の点が起点）",
        "length_m": round(length_m(line)),
        "points": len(line),
        "source": "OpenStreetMap の道路の線から作成（© OpenStreetMap contributors, ODbL）",
        "osm_way_ids": sorted(w["id"] for w in ways),
        "osm_timestamp": osm.get("osm3s", {}).get("timestamp_osm_base", ""),
        "made_by": "tools/make_section.py",
    }
    write_geojson(OUT_DIR / "section.geojson", line, props)
    write_kml(OUT_DIR / "section.kml", line, props)
    print(f"点 {props['points']}、長さ 約 {props['length_m']} m、OSM の時点 {props['osm_timestamp']}")
    print(f"書き出し: {OUT_DIR.relative_to(REPO)}/section.geojson, section.kml")


if __name__ == "__main__":
    main()
