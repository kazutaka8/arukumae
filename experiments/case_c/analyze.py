"""案C の試しの結果をまとめる：モデルごとのぶれ、モデルどうしの一致、時間と費用。

使い方: .venv/bin/python experiments/case_c/analyze.py
正解の答えは用意していない。だから「同じモデルで何度やっても同じか（ぶれ）」と
「モデルどうしで同じ答えか（一致）」を見る。当たっているかは、人が写真で確かめる。
"""

from __future__ import annotations

import json
import statistics as st
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
RES = HERE / "out" / "results"


def main():
    recs = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(RES.glob("*.json"))]
    by = defaultdict(list)  # (window, model) -> [rec]
    for r in recs:
        by[(r["window"], r["model"])].append(r)
    models = sorted({r["model"] for r in recs})
    windows = sorted({r["window"] for r in recs})
    lines = []

    lines.append("## 時間と費用（1回あたりの平均）\n")
    lines.append("| モデル | 回数 | 秒 | 入力 | 出力 | 費用（$） | 拒否 | 別モデルに回った |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for m in models:
        rs = [r for r in recs if r["model"] == m]
        lines.append(f"| {m} | {len(rs)} | {st.mean(r['seconds'] for r in rs):.0f} | {st.mean(r['input_tokens'] for r in rs):.0f} | {st.mean(r['output_tokens'] for r in rs):.0f} | {st.mean(r['usd'] for r in rs):.3f} | {sum(r['stop_reason'] == 'refusal' for r in rs)} | {sum(r['fallback_ran'] for r in rs)} |")

    # 区切りごとの木の割合を (window, model) -> id -> [値...]
    tree = defaultdict(lambda: defaultdict(list))
    conf = defaultdict(Counter)
    for r in recs:
        for s in r["segments"]:
            tree[(r["window"], r["model"])][s["id"]].append(s["tree"])
            conf[r["model"]][s["conf"]] += 1

    lines.append("\n## ぶれ（同じモデル・同じ写真で3回）\n")
    lines.append("| 場所 | モデル | 3回とも同じ | 差が25以内 | 差の平均 |")
    lines.append("|---|---|---|---|---|")
    for w in windows:
        for m in models:
            vals = [v for v in tree[(w, m)].values() if len(v) >= 2]
            if not vals:
                continue
            same = sum(len(set(v)) == 1 for v in vals) / len(vals)
            near = sum(max(v) - min(v) <= 25 for v in vals) / len(vals)
            spread = st.mean(max(v) - min(v) for v in vals)
            lines.append(f"| {w} | {m} | {same:.0%} | {near:.0%} | {spread:.1f} |")

    lines.append("\n## モデルどうしの一致（各モデル3回の中央値どうし）\n")
    lines.append("| 場所 | 組 | 同じ | 差が25以内 |")
    lines.append("|---|---|---|---|")
    for w in windows:
        med = {m: {i: st.median(v) for i, v in tree[(w, m)].items()} for m in models}
        for a in range(len(models)):
            for b in range(a + 1, len(models)):
                ma, mb = models[a], models[b]
                ids = set(med[ma]) & set(med[mb])
                if not ids:
                    continue
                same = sum(med[ma][i] == med[mb][i] for i in ids) / len(ids)
                near = sum(abs(med[ma][i] - med[mb][i]) <= 25 for i in ids) / len(ids)
                lines.append(f"| {w} | {ma.replace('claude-', '')} × {mb.replace('claude-', '')} | {same:.0%} | {near:.0%} |")

    lines.append("\n## 確信の分かれ方（全判定）\n")
    for m in models:
        c = conf[m]
        tot = sum(c.values())
        lines.append(f"- {m}：高 {c['高'] / tot:.0%}・中 {c['中'] / tot:.0%}・低 {c['低'] / tot:.0%}")

    lines.append("\n## 区切りごとの中央値（木の割合）\n")
    for w in windows:
        ids = sorted({i for m in models for i in tree[(w, m)]}, key=lambda s: (s[1:], s[0]))
        lines.append(f"\n### {w}\n")
        lines.append("| 区切り | " + " | ".join(m.replace("claude-", "") for m in models) + " |")
        lines.append("|---|" + "---|" * len(models))
        for i in ids:
            row = []
            for m in models:
                v = tree[(w, m)].get(i, [])
                row.append("/".join(str(x) for x in v) if v else "-")
            lines.append(f"| {i} | " + " | ".join(row) + " |")

    out = HERE / "out" / "summary.md"
    out.write_text("# 案C の試しの結果\n\n" + "\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[: 40]))
    print("書き出し:", out)


if __name__ == "__main__":
    main()
