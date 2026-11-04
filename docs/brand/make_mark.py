#!/usr/bin/env python3
"""アルクマエの印（ブレードの軌跡図）を SVG に書き出す。2026-11-04 に決めた形（try/ の X3 ＋ Z2 ＋ Z4）。

- 濃紺の地に 8px の薄い格子（製図の方眼）
- 根元が半径 R の円（台車の軸の道）をたどり、ブレード（長さ Lb）は進行方向の後ろへ。先端は半径 √(R²+Lb²) の円を掃く
- 先端の円は箱に内接（左・下・右に接し、最後のブレードの先端が上端）。軌跡は左 → 下 → 右 → 上と 270°
- ブレードは等角度に 10 本、根元が太く先が細い形の枠線。最後（いま）の 1 本だけ塗る（軌跡図で現在の車両を実線にする約束）
- 根元の円は細い完全な円。掃く面は白の 7%、先端の軌跡は細い線
- 色は 1 色（白か濃い色）。赤 #b7262a はロゴ・バナー用の版で「いまのブレード」にだけ使う

使い方:
  python3 docs/brand/make_mark.py        # mark.svg・mark-light.svg・mark-red.svg を書く
"""

from __future__ import annotations

import math
from pathlib import Path

HERE = Path(__file__).resolve().parent


def mark(bg: str, ink: str, *, grid_op: float, last: str | None = None, box: bool = True, rx: int = 14) -> str:
    m = 3.0  # 余白
    R = 11.0  # 根元の円の半径
    N = 10  # ブレードの本数
    span = 270.0  # 掃く角度
    Rt = 32 - m  # 先端の円の半径（箱に内接）
    C = (32.0, 32.0)
    Lb = math.sqrt(Rt * Rt - R * R)
    lag = math.degrees(math.atan2(Lb, R))  # 先端は根元より lag 度遅れた方位にある
    T0, T1 = 180.0, 180.0 + span

    def flip(p):  # 計算は y 上向きで、描くとき反転して「左 → 下 → 右 → 上」にする
        return (p[0], 64 - p[1])

    def tip(t):
        return flip((C[0] + Rt * math.cos(math.radians(t)), C[1] + Rt * math.sin(math.radians(t))))

    def root(t):
        a = t + lag
        return flip((C[0] + R * math.cos(math.radians(a)), C[1] + R * math.sin(math.radians(a))))

    P = lambda p: f"{p[0]:.2f} {p[1]:.2f}"  # noqa: E731
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="アルクマエ">']
    if box:
        out.append(f'<rect width="64" height="64" rx="{rx}" fill="{bg}"/><clipPath id="c"><rect width="64" height="64" rx="{rx}"/></clipPath><g clip-path="url(#c)">')
    else:
        out.append(f'<rect width="64" height="64" fill="{bg}"/><g>')
    grid = " ".join(f"M{v} 0 V64 M0 {v} H64" for v in range(0, 65, 8))
    out.append(f'<path d="{grid}" stroke="{ink}" stroke-opacity="{grid_op}" stroke-width="0.5" fill="none"/>')
    t0, t1 = tip(T0), tip(T1)
    r0, r1 = root(T0), root(T1)
    out.append(f'<path d="M{P(r0)} A{R} {R} 0 1 0 {P(r1)} L{P(t1)} A{Rt:.2f} {Rt:.2f} 0 1 1 {P(t0)} Z" fill="{ink}" fill-opacity="0.07"/>')
    out.append(f'<path d="M{P(t0)} A{Rt:.2f} {Rt:.2f} 0 1 0 {P(t1)}" fill="none" stroke="{ink}" stroke-width="0.8" stroke-linecap="round"/>')
    out.append(f'<circle cx="32" cy="32" r="{R}" fill="none" stroke="{ink}" stroke-opacity="0.5" stroke-width="0.6"/>')
    root_w, tip_w = 3.0, 0.7
    for i in range(N):
        t = T0 + span * i / (N - 1)
        rp, tp = root(t), tip(t)
        bx, by = (tp[0] - rp[0]) / Lb, (tp[1] - rp[1]) / Lb
        nx, ny = -by, bx
        pts = [
            (rp[0] + nx * root_w / 2, rp[1] + ny * root_w / 2),
            (tp[0] + nx * tip_w / 2, tp[1] + ny * tip_w / 2),
            (tp[0] - nx * tip_w / 2, tp[1] - ny * tip_w / 2),
            (rp[0] - nx * root_w / 2, rp[1] - ny * root_w / 2),
        ]
        d = "M" + " L".join(P(p) for p in pts) + " Z"
        if i == N - 1:
            col = last or ink
            out.append(f'<path d="{d}" fill="{col}" stroke="{col}" stroke-width="0.7" stroke-linejoin="round"/>')
        else:
            out.append(f'<path d="{d}" fill="none" stroke="{ink}" stroke-width="0.7" stroke-linejoin="round"/>')
    out.append("</g></svg>")
    return "\n".join(out) + "\n"


def main() -> None:
    navy, ink, white, red = "#0f1b33", "#1d232a", "#ffffff", "#b7262a"
    (HERE / "mark.svg").write_text(mark(navy, white, grid_op=0.08), encoding="utf-8")
    (HERE / "mark-light.svg").write_text(mark(white, ink, grid_op=0.10), encoding="utf-8")
    (HERE / "mark-red.svg").write_text(mark(navy, white, grid_op=0.08, last=red), encoding="utf-8")
    print("mark.svg / mark-light.svg / mark-red.svg を書きました")


if __name__ == "__main__":
    main()
