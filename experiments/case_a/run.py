#!/usr/bin/env python3
"""案A の試し：任意座標系の公図の線画と航空写真を Claude に見せ、「公図の点 ↔ 写真の点」の組を出させる（spec §8.5）。

送るのは render.py が作った 2 枚（公図の線画・航空写真）だけ。どちらも公開データで、案件名や座標は送らない。
返ってきた組を粗い正解（match.py）と比べ、組ごとのずれ（m）と、組から求めた置き場所のずれを出す。

使い方:
  .venv/bin/python experiments/case_a/run.py            # Fable 1 回
  .venv/bin/python experiments/case_a/run.py sonnet 2   # Sonnet 2 回
API キーはキーチェーンの arukumae-anthropic-api-key から読む。
"""

from __future__ import annotations

import base64
import json
import math
import re
import subprocess
import sys
import time
from pathlib import Path

import anthropic
import numpy as np

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from jgd8 import to_plane  # noqa: E402
from match import apply, helmert  # noqa: E402
from render import px_to_lonlat  # noqa: E402

OUT = Path(__file__).resolve().parent / "out"
MODELS = {"fable": "claude-fable-5-1", "sonnet": "claude-sonnet-5-5"}

PROMPT = """あなたは測量の補助をしています。2 枚の画像を渡します。

画像1：公図（土地の境界の図面）を線画にしたもの。北が上。座標はこの図面の中だけのもので、地図の座標はありません。灰色に塗った細長い筆は「道」、青く塗った筆は「水路」です。数字は地番（土地の番号）で、位置の手がかりにはなりません。
画像2：同じ辺りの航空写真（北が上、約 1 m／画素）。公図の範囲はこの写真のどこかに入っているはずですが、写真のほうが広い範囲を写しています。

どちらの画像にも、200 画素ごとの桃色の格子と、画素の目盛り（左上が 0,0）を入れてあります。

やってほしいこと：両方に写っている同じ地物（道の折れ曲がり・分かれ道・水路と道の交点・区画の角など）を探し、「画像1 の画素 ↔ 画像2 の画素」の組を 3〜6 組、選んだ理由と一緒に返してください。
公図は明治の図面が元で、形がゆがんでいたり縮尺が違ったりすることがあります。全体の形（道・水路の走り方、区画のまとまりの並び）から当たりを付け、確かめられる点だけを返してください。自信のない組は返さず、自信の程度も書いてください。

返事は次の JSON だけにしてください（前後に文を付けない）：
{"pairs": [{"map_px": [x, y], "photo_px": [x, y], "feature": "地物の説明", "why": "対応すると考えた理由"}], "confidence": "高" | "中" | "低", "note": "全体の所見（公図の範囲が写真のどの辺りか、合わない所など）"}"""


def api_key() -> str:
    return subprocess.run(["security", "find-generic-password", "-s", "arukumae-anthropic-api-key", "-w"], check=True, capture_output=True, text=True).stdout.strip()


def img(path: Path, media: str):
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": base64.b64encode(path.read_bytes()).decode()}}


def ask(client: anthropic.Anthropic, model: str) -> tuple[dict, dict]:
    t0 = time.time()
    res = client.messages.create(
        model=model,
        max_tokens=4000,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": [{"type": "text", "text": "画像1（公図の線画）"}, img(OUT / "map1.png", "image/png"), {"type": "text", "text": "画像2（航空写真）"}, img(OUT / "photo.jpg", "image/jpeg"), {"type": "text", "text": PROMPT}]}],
    )
    text = "".join(b.text for b in res.content if b.type == "text")
    m = re.search(r"\{[\s\S]*\}", text)
    parsed = json.loads(m.group(0)) if m else {"pairs": [], "raw": text}
    usage = {"seconds": round(time.time() - t0, 1), "input_tokens": res.usage.input_tokens, "output_tokens": res.usage.output_tokens}
    return parsed, usage


def evaluate(parsed: dict) -> dict:
    """返ってきた組を、粗い正解（match.py）と比べる。"""
    truth = json.loads((OUT / "truth.json").read_text(encoding="utf-8"))
    mf = json.loads((OUT / "map1_frame.json").read_text(encoding="utf-8"))
    pf = json.loads((OUT / "photo_frame.json").read_text(encoding="utf-8"))
    th = truth["helmert"]
    p_truth = np.array([th["a"], th["b"], th["tx"], th["ty"]])

    def map_px_to_xy(px):
        # 線画の画素 → 図面の座標（X=北、Y=東）
        return np.array([mf["x1"] - (px[1] - mf["pad"]) * mf["scale"], mf["y0"] + (px[0] - mf["pad"]) * mf["scale"]])

    def photo_px_to_xy(px):
        lon, lat = px_to_lonlat(pf["X0"] + px[0], pf["Y0"] + px[1], pf["z"])
        x, y = to_plane(lat, lon)  # jgd8.to_plane は (lat, lon) → (X 北, Y 東)
        return np.array([x, y])

    rows = []
    for pr in parsed.get("pairs", []):
        a = map_px_to_xy(pr["map_px"])
        b = photo_px_to_xy(pr["photo_px"])
        a_truth = apply(p_truth, a[None, :])[0]
        rows.append({**pr, "pair_error_m": float(np.hypot(*(a_truth - b)))})
    out = {"pairs": rows, "confidence": parsed.get("confidence"), "note": parsed.get("note")}
    if len(rows) >= 2:
        src = np.array([map_px_to_xy(r["map_px"]) for r in rows])
        dst = np.array([photo_px_to_xy(r["photo_px"]) for r in rows])
        p = helmert(src, dst)
        res = np.hypot(*(apply(p, src) - dst).T)
        # 図面の四隅と中心を、Claude の変換と粗い正解の変換で置いたときの違い
        bx, by = truth["bbox_arbitrary"]["x"], truth["bbox_arbitrary"]["y"]
        probes = np.array([[bx[0], by[0]], [bx[0], by[1]], [bx[1], by[0]], [bx[1], by[1]], [sum(bx) / 2, sum(by) / 2]])
        diff = np.hypot(*(apply(p, probes) - apply(p_truth, probes)).T)
        out["fit"] = {
            "scale": float(math.hypot(p[0], p[1])),
            "rotation_deg": float(math.degrees(math.atan2(p[1], p[0]))),
            "residual_rms_m": float(math.sqrt((res**2).mean())),
            "placement_diff_corners_m": [float(d) for d in diff[:4]],
            "placement_diff_center_m": float(diff[4]),
            "truth_scale": truth["scale"],
            "truth_rotation_deg": truth["rotation_deg"],
            "truth_rms_m": truth["rms_m"],
        }
    return out


def main():
    model_key = next((a for a in sys.argv[1:] if a in MODELS), "fable")
    runs = next((int(a) for a in sys.argv[1:] if a.isdigit()), 1)
    client = anthropic.Anthropic(api_key=api_key())
    for i in range(1, runs + 1):
        parsed, usage = ask(client, MODELS[model_key])
        ev = evaluate(parsed)
        rec = {"model": MODELS[model_key], "run": i, "usage": usage, "answer": parsed, "evaluation": ev}
        path = OUT / f"run_{model_key}_{i}.json"
        path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[{model_key} {i}] {usage['seconds']}s、入力 {usage['input_tokens']}・出力 {usage['output_tokens']} トークン、確信 {ev['confidence']}")
        for r in ev["pairs"]:
            print(f"  {r['feature']}: 公図 {r['map_px']} ↔ 写真 {r['photo_px']} → 粗い正解とのずれ {r['pair_error_m']:.0f}m")
        if "fit" in ev:
            f = ev["fit"]
            print(f"  組から求めた変換：縮尺 {f['scale']:.3f}（正解 {f['truth_scale']:.3f}）、回転 {f['rotation_deg']:.1f}°（正解 {f['truth_rotation_deg']:.1f}°）、残差 RMS {f['residual_rms_m']:.0f}m、中心の置き場所の違い {f['placement_diff_center_m']:.0f}m、四隅 {[round(d) for d in f['placement_diff_corners_m']]}")
        print(f"  所見：{ev['note']}")
        print(f"  → {path.relative_to(REPO)}")


if __name__ == "__main__":
    main()
