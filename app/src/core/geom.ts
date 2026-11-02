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
  /**
   * 伐採範囲の外側（中心線からの距離 m）。
   * 数なら全区間で一定（仮の帯）。左右別の配列なら 1m ごとの点（dense）に対応する（軌跡図・架空の軌跡図から作る）。
   * NaN は「ここには軌跡の情報がない」で、道路の半幅と同じ（切らない）扱い
   */
  bandOut: number | { left: ArrayLike<number>; right: ArrayLike<number> };
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
  /** この区切りでの伐採範囲の外側の最大（中心線からの距離 m）。詳細の表示用 */
  outerMaxM: number;
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
  const outerAt = (side: "L" | "R", i: number): number => {
    const raw = typeof opt.bandOut === "number" ? opt.bandOut : side === "L" ? opt.bandOut.left[i] : opt.bandOut.right[i];
    // 情報のない所と、掃く範囲が道路の中に収まる所は「道路の端まで」＝幅 0
    return Number.isFinite(raw) ? Math.max(raw, opt.roadHalf) : opt.roadHalf;
  };
  for (let k = 0; k <= nSeg; k++) {
    const i0 = k * opt.step;
    const i1 = Math.min((k + 1) * opt.step, dense.length - 1);
    if (i1 - i0 < 2) break;
    for (const [side, sgn] of [["L", 1], ["R", -1]] as const) {
      const inner: EN[] = [];
      const outer: EN[] = [];
      let outerMax = opt.roadHalf;
      for (let i = i0; i <= i1; i++) {
        const [nx, ny] = normals[i];
        const o = outerAt(side, i);
        if (o > outerMax) outerMax = o;
        inner.push([dense[i][0] + sgn * nx * opt.roadHalf, dense[i][1] + sgn * ny * opt.roadHalf]);
        outer.push([dense[i][0] + sgn * nx * o, dense[i][1] + sgn * ny * o]);
      }
      // 伐採範囲が道路の端より外に出ない区切りは作らない（軌跡図がない所、車両が道路に収まる所）
      if (outerMax - opt.roadHalf < 0.05) continue;
      const ring = [...inner, ...outer.reverse()];
      ring.push(ring[0]);
      segs.push({
        id: `${side}${String(k).padStart(3, "0")}`,
        side,
        fromM: i0,
        toM: i1,
        ring,
        areaM2: ringArea(ring),
        outerMaxM: Math.round(outerMax * 10) / 10,
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

/**
 * 1m ごとの点を升目に入れて、最寄りの点を速く引く。
 * 軌跡の計算では数十万点を投影するので、毎回 nearestOnLine（全点を見る）では遅い。
 */
export class StationIndex {
  private cells = new Map<string, number[]>();
  private pts: EN[];
  private cell: number;
  constructor(pts: EN[], cell = 25) {
    this.pts = pts;
    this.cell = cell;
    pts.forEach((p, i) => {
      const key = this.key(Math.floor(p[0] / cell), Math.floor(p[1] / cell));
      const arr = this.cells.get(key);
      if (arr) arr.push(i);
      else this.cells.set(key, [i]);
    });
  }
  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }
  /** maxDist（m）より遠ければ null */
  nearest(p: EN, maxDist = 100): { dist: number; index: number } | null {
    const cx = Math.floor(p[0] / this.cell);
    const cy = Math.floor(p[1] / this.cell);
    let best = { dist: Infinity, index: -1 };
    const rMax = Math.ceil(maxDist / this.cell) + 1;
    for (let r = 0; r <= rMax; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // この輪だけ
          const arr = this.cells.get(this.key(cx + dx, cy + dy));
          if (!arr) continue;
          for (const i of arr) {
            const d = Math.hypot(this.pts[i][0] - p[0], this.pts[i][1] - p[1]);
            if (d < best.dist) best = { dist: d, index: i };
          }
        }
      }
      // この輪まで見たあと、外の輪の点は少なくとも r×升 の距離にある。それより近いものが見つかっていれば終わり
      if (best.index >= 0 && best.dist <= r * this.cell) break;
    }
    return best.index >= 0 && best.dist <= maxDist ? best : null;
  }
}
