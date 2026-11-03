"""平面直角座標系（JGD2011。第I〜XIX系）と緯度経度の相互の換算。国土地理院の式。

前処理の道具で使う。道具の本体（TypeScript、app/src/core/proj.ts）は proj4 を使い、同じ点で値が合うことをテストで確かめる。
戻り値・引数とも (X, Y)＝(北, 東)。測量の慣習どおり X が北。
既定は第VIII系（見本の小川村）。zone を渡せばほかの系でも換算できる（2026-11-03。道具の本体が系を場所から決めるようにしたので、
その回帰テストの期待値をここで出すため）。
"""

from __future__ import annotations

import math

A_ = 6378137.0
F_ = 298.257222101
M0 = 0.9999
# 各系の原点（緯度, 経度）。国土地理院の表のとおり。番号は 1 から
ZONES = [
    (33, 129.5), (33, 131), (36, 132 + 10 / 60), (33, 133.5), (36, 134 + 20 / 60), (36, 136), (36, 137 + 10 / 60), (36, 138.5),
    (36, 139 + 50 / 60), (40, 140 + 50 / 60), (44, 140.25), (44, 142.25), (44, 144.25), (26, 142), (26, 127.5), (26, 124),
    (26, 131), (20, 136), (26, 154),
]
n = 1 / (2 * F_ - 1)
A0 = 1 + n**2 / 4 + n**4 / 64
AJ = [-1.5 * (n - n**3 / 8 - n**5 / 64), 15 / 16 * (n**2 - n**4 / 4), -35 / 48 * (n**3 - 5 * n**5 / 16), 315 / 512 * n**4, -693 / 1280 * n**5]
AL = [n / 2 - 2 * n**2 / 3 + 5 * n**3 / 16 + 41 * n**4 / 180 - 127 * n**5 / 288,
      13 * n**2 / 48 - 3 * n**3 / 5 + 557 * n**4 / 1440 + 281 * n**5 / 630,
      61 * n**3 / 240 - 103 * n**4 / 140 + 15061 * n**5 / 26880,
      49561 * n**4 / 161280 - 179 * n**5 / 168,
      34729 * n**5 / 80640]
# 逆変換の係数
BT = [n / 2 - 2 * n**2 / 3 + 37 * n**3 / 96 - n**4 / 360 - 81 * n**5 / 512,
      n**2 / 48 + n**3 / 15 - 437 * n**4 / 1440 + 46 * n**5 / 105,
      17 * n**3 / 480 - 37 * n**4 / 840 - 209 * n**5 / 4480,
      4397 * n**4 / 161280 - 11 * n**5 / 504,
      4583 * n**5 / 161280]
DL = [2 * n - 2 * n**2 / 3 - 2 * n**3 + 116 * n**4 / 45 + 26 * n**5 / 45 - 2854 * n**6 / 675,
      7 * n**2 / 3 - 8 * n**3 / 5 - 227 * n**4 / 45 + 2704 * n**5 / 315 + 2323 * n**6 / 945,
      56 * n**3 / 15 - 136 * n**4 / 35 - 1262 * n**5 / 105 + 73814 * n**6 / 2835,
      4279 * n**4 / 630 - 332 * n**5 / 35 - 399572 * n**6 / 14175,
      4174 * n**5 / 315 - 144838 * n**6 / 6237,
      601676 * n**6 / 22275]
AB = M0 * A_ / (1 + n) * A0
K = 2 * math.sqrt(n) / (1 + n)


def _origin(zone: int) -> tuple[float, float, float]:
    """系の原点の緯度・経度（ラジアン）と、原点の子午線弧長。"""
    lat0, lon0 = ZONES[zone - 1]
    phi0, lam0 = math.radians(lat0), math.radians(lon0)
    sphi0 = M0 * A_ / (1 + n) * (A0 * phi0 + sum(AJ[j] * math.sin(2 * (j + 1) * phi0) for j in range(5)))
    return phi0, lam0, sphi0



def to_plane(lat: float, lon: float, zone: int = 8) -> tuple[float, float]:
    _, lam0, sphi0 = _origin(zone)
    phi, lam = math.radians(lat), math.radians(lon)
    t = math.sinh(math.atanh(math.sin(phi)) - K * math.atanh(K * math.sin(phi)))
    tb = math.sqrt(1 + t * t)
    lc, ls = math.cos(lam - lam0), math.sin(lam - lam0)
    xi = math.atan(t / lc)
    eta = math.atanh(ls / tb)
    x = AB * (xi + sum(AL[j] * math.sin(2 * (j + 1) * xi) * math.cosh(2 * (j + 1) * eta) for j in range(5))) - sphi0
    y = AB * (eta + sum(AL[j] * math.cos(2 * (j + 1) * xi) * math.sinh(2 * (j + 1) * eta) for j in range(5)))
    return x, y


def to_latlon(x: float, y: float, zone: int = 8) -> tuple[float, float]:
    _, lam0, sphi0 = _origin(zone)
    xi = (x + sphi0) / AB
    eta = y / AB
    xi2 = xi - sum(BT[j] * math.sin(2 * (j + 1) * xi) * math.cosh(2 * (j + 1) * eta) for j in range(5))
    eta2 = eta - sum(BT[j] * math.cos(2 * (j + 1) * xi) * math.sinh(2 * (j + 1) * eta) for j in range(5))
    chi = math.asin(math.sin(xi2) / math.cosh(eta2))
    lat = chi + sum(DL[j] * math.sin(2 * (j + 1) * chi) for j in range(6))
    lon = lam0 + math.atan2(math.sinh(eta2), math.cos(xi2))
    return math.degrees(lat), math.degrees(lon)
