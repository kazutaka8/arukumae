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
  /**
   * これより小さい区切りは隣と合わせる（m²）。省くと 15。
   * 既定の車両（寝かせたブレード）だと直線の区切りがちょうど 30m²（幅 3m × 10m）なので、30 にすると直線まで合わさってしまう。
   * 急カーブの内側で潰れた区切りだけを拾うため 15 にした（2026-11-02）
   */
  minAreaM2?: number;
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
 * 1m ごとの点で、曲がりの半径（m）と向き。向きは +1 が左曲がり（左が内側）、-1 が右曲がり、0 がほぼ直線。
 * 前後 span m の向きの差から出す。急カーブの内側で区切りの外側の線が折り返して重なるのを防ぐために使う
 */
export function curveRadii(dense: EN[], span = 3): { radius: number; turn: 1 | -1 | 0 }[] {
  const n = dense.length;
  return dense.map((_, i) => {
    const a = dense[Math.max(0, i - span)];
    const b = dense[i];
    const c = dense[Math.min(n - 1, i + span)];
    // 端では前後の点が取れず弦が潰れる。そこは直線とみなす
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5 || Math.hypot(c[0] - b[0], c[1] - b[1]) < 0.5) return { radius: Infinity, turn: 0 };
    const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = t2 - t1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (Math.abs(d) < 1e-4 || len === 0) return { radius: Infinity, turn: 0 };
    // 2 本の弦の向きの差は、弦の真ん中から真ん中まで（道のり len/2）の向きの変化。半径 = 道のり ÷ 角度
    return { radius: len / 2 / Math.abs(d), turn: d > 0 ? 1 : -1 };
  });
}

/**
 * 1m ごとの点列から区切りを作る（spec §8.4）。
 * - 急カーブの内側では、外側の線が曲がりの中心を越えて折り返し、隣の区切りと重なる。
 *   そこで内側の区切りの外側の幅を「曲がりの半径 − 0.5m」までに抑える。重なった分は、中心線に近い所に入るのと同じこと
 * - その結果、面積が minAreaM2 未満に潰れた区切りは、次の区切り（最後なら前）と合わせる。番号は先のほうを残し、距離の範囲が広がる
 */
export function buildSegments(dense: EN[], normals: EN[], opt: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): Segment[] {
  const minArea = opt.minAreaM2 ?? 15;
  const nSeg = Math.floor((dense.length - 1) / opt.step);
  const radii = curveRadii(dense);
  const outerAt = (side: "L" | "R", i: number): number => {
    const raw = typeof opt.bandOut === "number" ? opt.bandOut : side === "L" ? opt.bandOut.left[i] : opt.bandOut.right[i];
    // 情報のない所と、掃く範囲が道路の中に収まる所は「道路の端まで」＝幅 0
    let o = Number.isFinite(raw) ? Math.max(raw, opt.roadHalf) : opt.roadHalf;
    // 曲がりの内側では、半径を越えると線が折り返す。半径の手前で止める
    const r = radii[i];
    const inner = (side === "L" && r.turn === 1) || (side === "R" && r.turn === -1);
    if (inner && Number.isFinite(r.radius)) o = Math.max(opt.roadHalf, Math.min(o, r.radius - 0.5));
    return o;
  };
  const build = (side: "L" | "R", i0: number, i1: number): { ring: EN[]; outerMax: number } => {
    const sgn = side === "L" ? 1 : -1;
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
    const ring = [...inner, ...outer.reverse()];
    ring.push(ring[0]);
    return { ring, outerMax };
  };

  const segs: Segment[] = [];
  for (const side of ["L", "R"] as const) {
    // まず 10m ごとの範囲を並べ、作れないもの（幅 0）を除く
    const ranges: { k: number; i0: number; i1: number }[] = [];
    for (let k = 0; k <= nSeg; k++) {
      const i0 = k * opt.step;
      const i1 = Math.min((k + 1) * opt.step, dense.length - 1);
      if (i1 - i0 < 2) break;
      const { outerMax } = build(side, i0, i1);
      // 伐採範囲が道路の端より外に出ない区切りは作らない（軌跡図がない所、車両が道路に収まる所）
      if (outerMax - opt.roadHalf < 0.05) continue;
      ranges.push({ k, i0, i1 });
    }
    // 小さすぎる区切りを、つながっている次の区切りと合わせる（次が無ければ前と）
    let idx = 0;
    while (idx < ranges.length) {
      const cur = ranges[idx];
      const area = ringArea(build(side, cur.i0, cur.i1).ring);
      if (area >= minArea) {
        idx++;
        continue;
      }
      const next = ranges[idx + 1];
      const prev = ranges[idx - 1];
      if (next && next.i0 === cur.i1) {
        ranges.splice(idx, 2, { k: cur.k, i0: cur.i0, i1: next.i1 });
      } else if (prev && prev.i1 === cur.i0) {
        ranges.splice(idx - 1, 2, { k: prev.k, i0: prev.i0, i1: cur.i1 });
        idx--;
      } else {
        idx++; // 隣とつながっていなければそのまま残す
      }
    }
    for (const r of ranges) {
      const { ring, outerMax } = build(side, r.i0, r.i1);
      segs.push({
        id: `${side}${String(r.k).padStart(3, "0")}`,
        side,
        fromM: r.i0,
        toM: r.i1,
        ring,
        areaM2: ringArea(ring),
        outerMaxM: Math.round(outerMax * 10) / 10,
      });
    }
  }
  // 起点から順、同じ所は左→右
  return segs.sort((a, b) => a.fromM - b.fromM || (a.side === "L" ? -1 : 1));
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
