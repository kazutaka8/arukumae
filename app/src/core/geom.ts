/**
 * 中心線から区切りを作る計算（spec §8.4）。すべて平面直角座標（m）の上で行う。
 *
 * - 中心線を 1m ごとの点に打ち直し、起点からの距離を整数 m で持つ
 * - 区切りは「道路の端から外側」を、中心線に沿って 10m ごと×左右
 * - 区切りの番号 L032 は「起点から 320〜330m の左」。道路管理者の KP とは別
 */
import type { EN } from "./proj";

export interface SegmentOptions {
  /** 区切りの長さ（m） */
  step: number;
  /** 道路の半幅（m）。ここから外側を区切りにする */
  roadHalf: number;
  /** 伐採範囲の外側（中心線からの距離 m） */
  bandOut: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = { step: 10, roadHalf: 3, bandOut: 13 };

export interface Segment {
  id: string;
  side: "L" | "R";
  /** 起点からの距離（m） */
  fromM: number;
  toM: number;
  /** 外周。閉じている（最初と最後が同じ点） */
  ring: EN[];
  areaM2: number;
}

export function length(line: EN[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return total;
}

/** 折れ線を step（m）ごとの点に打ち直す。最初の点は必ず含む。 */
export function resample(line: EN[], step = 1): EN[] {
  const out: EN[] = [line[0]];
  let carry = 0; // 前の辺で使い切れなかった分
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const L = Math.hypot(bx - ax, by - ay);
    let d = step - carry;
    while (d <= L) {
      const t = d / L;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      d += step;
    }
    carry = L - (d - step);
  }
  return out;
}

/**
 * 各点での進行方向の左の単位ベクトル。
 * 前後 span 個の点から向きを取る。1点ずつだと OSM の細かい折れで法線が暴れるため。
 */
export function leftNormals(pts: EN[], span = 3): EN[] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - span)];
    const b = pts[Math.min(pts.length - 1, i + span)];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const L = Math.hypot(tx, ty) || 1;
    return [-ty / L, tx / L];
  });
}

/** 多角形の面積（m²）。閉じていてもいなくてもよい */
export function ringArea(ring: EN[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/**
 * 1m ごとの点列から区切りを作る。
 * TODO（spec §8.4）：急カーブの内側で区切りが潰れて重なる。重なった所は中心線に近いほうに入れ、
 * 30m² 未満の区切りは隣と合わせる。雛形ではまだやっていない。
 */
export function buildSegments(dense: EN[], normals: EN[], opt: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): Segment[] {
  const segs: Segment[] = [];
  const nSeg = Math.floor((dense.length - 1) / opt.step);
  for (let k = 0; k <= nSeg; k++) {
    const i0 = k * opt.step;
    const i1 = Math.min((k + 1) * opt.step, dense.length - 1);
    if (i1 - i0 < 2) break;
    for (const [side, sgn] of [["L", 1], ["R", -1]] as const) {
      const inner: EN[] = [];
      const outer: EN[] = [];
      for (let i = i0; i <= i1; i++) {
        const [nx, ny] = normals[i];
        inner.push([dense[i][0] + sgn * nx * opt.roadHalf, dense[i][1] + sgn * ny * opt.roadHalf]);
        outer.push([dense[i][0] + sgn * nx * opt.bandOut, dense[i][1] + sgn * ny * opt.bandOut]);
      }
      const ring = [...inner, ...outer.reverse()];
      ring.push(ring[0]);
      segs.push({
        id: `${side}${String(k).padStart(3, "0")}`,
        side,
        fromM: i0,
        toM: i1,
        ring,
        areaM2: ringArea(ring),
      });
    }
  }
  return segs;
}

/** 点から折れ線までの最短距離と、その足の「起点からの距離」（dense が 1m ごとなら添字＝m） */
export function nearestOnLine(dense: EN[], p: EN): { dist: number; index: number } {
  let best = { dist: Infinity, index: 0 };
  for (let i = 0; i < dense.length; i++) {
    const d = Math.hypot(dense[i][0] - p[0], dense[i][1] - p[1]);
    if (d < best.dist) best = { dist: d, index: i };
  }
  return best;
}
