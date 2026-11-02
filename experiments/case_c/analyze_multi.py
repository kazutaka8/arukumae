"""撮影日の違う写真の試しをまとめる。

- 年ごと：2022年（results/ の Sonnet）と 2023年（results_single/ の Sonnet）の判定を突き合わせ、差の大きい区切りを「変化」とみなす
- 一緒に：results_multi/ の「今の割合・前の割合・変化・確信」を、モデルごとに見る

使い方: .venv/bin/python experiments/case_c/analyze_multi.py
"""

from __future__ import annotations

import json
import statistics as st
from collections import Counter, defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"


def load(d):
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted((OUT / d).glob("*.json"))]


def med(xs):
    return st.median(xs) if xs else None


def main():
    single22 = [r for r in load("results") if "sonnet" in r["model"]]
    single23 = load("results_single")
    multi = load("results_multi")
    lines = []

    # 区切りごとの値を集める
    v22, v23, c22, c23 = defaultdict(list), defaultdict(list), Counter(), Counter()
    for r in single22:
        for s in r["segments"]:
            v22[(r["window"], s["id"])].append(s["tree"]); c22[s["conf"]] += 1
    for r in single23:
        for s in r["segments"]:
            v23[(r["window"], s["id"])].append(s["tree"]); c23[s["conf"]] += 1
    mv = defaultdict(lambda: defaultdict(lambda: {"now": [], "old": [], "change": [], "conf": [], "why": []}))
    mconf = defaultdict(Counter)
    for r in multi:
        m = r["model"].replace("claude-", "")
        for s in r["segments"]:
            d = mv[m][(r["window"], s["id"])]
            d["now"].append(s["tree_now"]); d["old"].append(s["tree_old"]); d["change"].append(s["change"]); d["conf"].append(s["conf"]); d["why"].append(s["why"])
            mconf[m][s["conf"]] += 1

    keys = sorted(v22, key=lambda k: (k[0], k[1][1:], k[1][0]))
    lines.append("## 時間と費用（1回あたりの平均）\n")
    lines.append("| 方式 | モデル | 回数 | 秒 | 入力 | 出力 | 費用（$） |")
    lines.append("|---|---|---|---|---|---|---|")
    for name, rs in (("2023年だけ", single23),) + tuple((f"2枚を一緒に", [r for r in multi if r["model"] == m]) for m in sorted({r["model"] for r in multi})):
        if rs:
            lines.append(f"| {name} | {rs[0]['model']} | {len(rs)} | {st.mean(r['seconds'] for r in rs):.0f} | {st.mean(r['input_tokens'] for r in rs):.0f} | {st.mean(r['output_tokens'] for r in rs):.0f} | {st.mean(r['usd'] for r in rs):.3f} |")

    lines.append("\n## 確信「低」の割合\n")
    tot = lambda c: sum(c.values()) or 1
    lines.append(f"- 2022年だけ（Sonnet）：{c22['低'] / tot(c22):.0%}")
    lines.append(f"- 2023年だけ（Sonnet）：{c23['低'] / tot(c23):.0%}")
    for m, c in sorted(mconf.items()):
        lines.append(f"- 2枚を一緒に（{m}）：{c['低'] / tot(c):.0%}（高 {c['高'] / tot(c):.0%}）")

    lines.append("\n## 年ごとの判定の差（Sonnet。中央値の差が50以上を「変化」とみなす）\n")
    changed = [k for k in keys if v23.get(k) and abs(med(v22[k]) - med(v23[k])) >= 50]
    lines.append(f"変化とみなした区切り：{len(changed)}  " + "、".join(f"{w}:{i}（{med(v22[(w, i)]):.0f}→{med(v23[(w, i)]):.0f}）" for w, i in changed))

    lines.append("\n## 2枚を一緒に見せたときの「変化」（各モデル2回の両方で同じ答えのもの）\n")
    for m in sorted(mv):
        flags = []
        for k in keys:
            ch = mv[m][k]["change"]
            if ch and len(set(ch)) == 1 and ch[0] != "変化なし":
                flags.append(f"{k[0]}:{k[1]}={ch[0]}")
        stable = sum(len(set(mv[m][k]["now"])) == 1 for k in keys if mv[m][k]["now"]) / max(1, sum(1 for k in keys if mv[m][k]["now"]))
        lines.append(f"- {m}（今の割合が2回とも同じ {stable:.0%}）：{len(flags)} 区切り　" + "、".join(flags))

    lines.append("\n## 区切りごと（木の割合。2022年だけ／2023年だけ／一緒に見せた今の割合：sonnet・opus・fable）\n")
    ms = sorted(mv)
    lines.append("| 区切り | 2022 | 2023 | " + " | ".join(f"今・{m.split('-')[0]}" for m in ms) + " | 変化（sonnet） |")
    lines.append("|---|---|---|" + "---|" * len(ms) + "---|")
    for k in keys:
        row = [f"{med(v22[k]):.0f}", f"{med(v23[k]):.0f}" if v23.get(k) else "-"]
        for m in ms:
            now = mv[m][k]["now"]
            row.append("/".join(str(x) for x in now) if now else "-")
        chs = mv[ms[-1]][k]["change"] if ms else []
        lines.append(f"| {k[0]}:{k[1]} | " + " | ".join(row) + f" | {'/'.join(chs)} |")

    out = OUT / "summary_multi.md"
    out.write_text("# 撮影日の違う写真の試しの結果\n\n" + "\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:30]))
    print("書き出し:", out)


if __name__ == "__main__":
    main()
