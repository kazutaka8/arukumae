"""緯度経度 → 平面直角座標系（第VIII系）。国土地理院の式（河瀬の式）。

長野県の航空写真（JGD2000・第VIII系、0.4m／画素）に区切りを重ねるために使う。
JGD2000 と JGD2011 の差は長野では数 cm ほどで、区切り（10m）には効かない。
戻り値は (X, Y)＝(北, 東)。測量の慣習どおり X が北。
"""

import math

A_ = 6378137.0
F_ = 298.257222101
M0 = 0.9999
PHI0 = math.radians(36.0)
LAM0 = math.radians(138.5)
n = 1 / (2 * F_ - 1)
A0 = 1 + n**2 / 4 + n**4 / 64
AJ = [-1.5 * (n - n**3 / 8 - n**5 / 64), 15 / 16 * (n**2 - n**4 / 4), -35 / 48 * (n**3 - 5 * n**5 / 16), 315 / 512 * n**4, -693 / 1280 * n**5]
AL = [n / 2 - 2 * n**2 / 3 + 5 * n**3 / 16 + 41 * n**4 / 180 - 127 * n**5 / 288,
      13 * n**2 / 48 - 3 * n**3 / 5 + 557 * n**4 / 1440 + 281 * n**5 / 630,
      61 * n**3 / 240 - 103 * n**4 / 140 + 15061 * n**5 / 26880,
      49561 * n**4 / 161280 - 179 * n**5 / 168,
      34729 * n**5 / 80640]
AB = M0 * A_ / (1 + n) * A0
SPHI0 = M0 * A_ / (1 + n) * (A0 * PHI0 + sum(AJ[j] * math.sin(2 * (j + 1) * PHI0) for j in range(5)))
K = 2 * math.sqrt(n) / (1 + n)


def to_plane(lat: float, lon: float) -> tuple[float, float]:
    phi, lam = math.radians(lat), math.radians(lon)
    t = math.sinh(math.atanh(math.sin(phi)) - K * math.atanh(K * math.sin(phi)))
    tb = math.sqrt(1 + t * t)
    lc, ls = math.cos(lam - LAM0), math.sin(lam - LAM0)
    xi = math.atan(t / lc)
    eta = math.atanh(ls / tb)
    x = AB * (xi + sum(AL[j] * math.sin(2 * (j + 1) * xi) * math.cosh(2 * (j + 1) * eta) for j in range(5))) - SPHI0
    y = AB * (eta + sum(AL[j] * math.cos(2 * (j + 1) * xi) * math.sinh(2 * (j + 1) * eta) for j in range(5)))
    return x, y
