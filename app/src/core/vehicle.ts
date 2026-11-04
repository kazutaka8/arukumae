/**
 * 架空の軌跡図（spec §11.4）。中心線と車両の寸法から、車体とブレードが掃く範囲を計算する。
 *
 * 本物の軌跡図は運送会社が専用のソフトで描き、届くのが遅く、版もよく変わる。
 * ここでは「現地を歩く前の下調べに使える程度」の簡易なものを、ブレードの長さを入れるだけで作れるようにする。
 *
 * - 前軸が中心線をたどり、駆動軸（キングピン）と台車の軸群がそれを追う（追従＝トラクトリクス）
 * - 多軸台車は後輪も操舵するので、実際の台車の切れ込みはこれより小さいことが多い。操舵なしで計算し、広め（安全側）に倒す
 * - ブレードは根元を台車の上の受け（リフター）に置き、後ろ向きに伸ばす。立てた角度 tilt の分だけ水平の投影が短くなる（L·cos tilt）
 * - 高さは見ない。立てたブレードが高い枝をかすめるかどうかは、この道具の外
 *
 * 結果は「中心線の 1m ごとの点で、左右それぞれどこまで掃いたか（m）」。
 * 軌跡図のファイルを読んだときも同じ形にするので（track.ts）、区切りの作り方は1つで済む。
 */
import { StationIndex } from "./geom";
import type { EN } from "./proj";

export interface Vehicle {
  /** トラクタ：前軸より前のはみ出し、軸距（前軸→駆動軸。後軸が複数なら中心で代表）、幅（m） */
  tractorFront: number;
  tractorWheelbase: number;
  tractorWidth: number;
  /** キングピン（駆動軸の真上とみなす）から台車の軸群の中心まで（m） */
  kingpinToAxle: number;
  /** 台車：キングピンより前のはみ出し（グースネック）、軸群の中心から後端まで、幅（m） */
  trailerFront: number;
  trailerTail: number;
  trailerWidth: number;
  /** ブレード：長さ、根元の直径、先の幅、根元の位置（キングピンから後ろへ m。負なら前）、立てた角度（度） */
  bladeLength: number;
  bladeRootDia: number;
  bladeTipWidth: number;
  bladeRootAt: number;
  tilt: number;
}

/**
 * 起立の区間：起点から fromM〜toM の間を通るとき、ブレードを tilt 度に立てる（それ以外は Vehicle.tilt）。
 * 立てられるかは場所による（電線をくぐる所では立てられない）ので、カーブごとに人が決める。
 * どの区間にいるかは「ブレードの根元の位置」で見る
 */
export interface TiltZone {
  fromM: number;
  toM: number;
  tilt: number;
}

export type PresetId = "lifter" | "extendable";

/**
 * 寸法の初期値。実機の写真（ブレードリフターを載せた多軸台車）と、伸縮トレーラーの一般的な寸法から置いた目安。
 * 案件ごとに運送会社の車両に合わせて直す前提。
 */
export const PRESETS: Record<PresetId, { name: string; note: string; vehicle: Vehicle }> = {
  lifter: {
    name: "ブレードリフター（公道）",
    note: "港から積み替え場までの公道で多い。立てられる曲がりでだけブレードを立てて水平の長さを縮める（電線をくぐる所では立てられない）。既定は寝かせたまま＝広め（安全側）",
    vehicle: {
      tractorFront: 1.5,
      tractorWheelbase: 4.0,
      tractorWidth: 2.5,
      kingpinToAxle: 10,
      trailerFront: 1.5,
      trailerTail: 3,
      trailerWidth: 3.0,
      bladeLength: 60,
      bladeRootDia: 4.0,
      bladeTipWidth: 0.5,
      bladeRootAt: 6,
      tilt: 0,
    },
  },
  extendable: {
    name: "伸縮トレーラー（公道。ブレードは水平）",
    note: "公道を走れるトレーラー。ブレードは寝たままなので、曲がりで先が大きく外へ振れ、内側も大きく切れ込む。ヤードの中（公道の外）で使う多軸台車（自走式）は、この道具の外",
    vehicle: {
      tractorFront: 1.5,
      tractorWheelbase: 4.0,
      tractorWidth: 2.5,
      kingpinToAxle: 30,
      trailerFront: 1.5,
      trailerTail: 3,
      trailerWidth: 3.0,
      bladeLength: 55,
      bladeRootDia: 4.0,
      bladeTipWidth: 0.5,
      bladeRootAt: -3,
      tilt: 0,
    },
  },
};

/** 掃いた範囲。中心線の 1m ごとの点に対応し、左右それぞれ中心線からの距離（m）。NaN は「ここには軌跡の情報がない」 */
export interface Sweep {
  left: Float64Array;
  right: Float64Array;
}

/** ブレードの水平の投影の長さ（m）。tilt を与えればその角度で */
export function bladeHorizontal(v: Vehicle, tilt = v.tilt): number {
  return v.bladeLength * Math.cos((tilt * Math.PI) / 180);
}

const sub = (a: EN, b: EN): EN => [a[0] - b[0], a[1] - b[1]];
const add = (a: EN, b: EN): EN => [a[0] + b[0], a[1] + b[1]];
const mul = (a: EN, k: number): EN => [a[0] * k, a[1] * k];
const unit = (a: EN): EN => {
  const L = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / L, a[1] / L];
};

/** 引かれる点の追従。引く点が動いたら、引かれる点は「引く点から len だけ後ろ」に来る（1m 刻みなら十分な近似） */
function follow(target: EN, p: EN, len: number): EN {
  return sub(target, mul(unit(sub(target, p)), len));
}

/** 中心線の前後に、端の向きのまま n 個ずつ（1m ごと）点を足す。車両が区間の外から入り、外へ出ていくまでを計算するため */
export function extendLine(dense: EN[], before: number, after: number): EN[] {
  const h0 = unit(sub(dense[1], dense[0]));
  const h1 = unit(sub(dense[dense.length - 1], dense[dense.length - 2]));
  const pre: EN[] = [];
  for (let k = before; k >= 1; k--) pre.push(sub(dense[0], mul(h0, k)));
  const post: EN[] = [];
  for (let k = 1; k <= after; k++) post.push(add(dense[dense.length - 1], mul(h1, k)));
  return [...pre, ...dense, ...post];
}

/**
 * 車両を中心線に沿って 1m ずつ進め、車体とブレードが掃いた面（各歩の形と、1 歩前からの動きを合わせた凸包）を集め、
 * 中心線の各点の法線でその面を横切って、道路から続く範囲の左右の端を取る。
 *
 * 2026-11-04 まで：縁の点を「法線が通る最寄りの点」に投影して左右の最大を取っていた。
 * ヘアピンでは、点が飛び越した区切りに何も当たらず幅が 1〜2m に落ちる穴や、隣と 60m 違う段ができ、
 * 画面では軌跡の帯が欠けて見えた（2026-11-04 に別の道で確認。見本でも 14 か所あった）。
 * 面を横切る形なら、動く物が通った所は必ず連続して埋まるので、穴が出ない。
 *
 * 法線は無限に伸びるので、ヘアピンの反対側の脚にいる車両を拾わないように、
 * (1) 見る歩は「その点の少し手前から、車両の長さ＋30m 先まで」に限り、
 * (2) 法線の上で道路（中心）から切れ目なく（1m 以下の隙間まで）続く範囲だけを掃いた幅にする。
 * 脚と脚の間の土地は掃かれないので、向こうの脚の車両は切れ目の先になり、数えない
 */
const GAP_M = 1.0;

/** 凸包（Andrew の単調連鎖）。1 歩の形と 1 歩前の形を合わせた面に使う。点は 8 つなので速さは問わない */
function hull(pts: EN[]): EN[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: EN, a: EN, b: EN) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: EN[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: EN[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 点 P を通り向き N の直線が凸多角形を横切る区間 [dmin, dmax]（N の向きが正）。横切らなければ null */
function crossConvex(P: EN, N: EN, poly: EN[]): [number, number] | null {
  let dmin = Infinity;
  let dmax = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i];
    const B = poly[(i + 1) % poly.length];
    const ex = B[0] - A[0];
    const ey = B[1] - A[1];
    const det = ex * N[1] - N[0] * ey;
    if (Math.abs(det) < 1e-9) continue;
    const wx = A[0] - P[0];
    const wy = A[1] - P[1];
    const u = (N[0] * wy - N[1] * wx) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const d = (ex * wy - ey * wx) / det;
    if (d < dmin) dmin = d;
    if (d > dmax) dmax = d;
  }
  return dmin <= dmax ? [dmin, dmax] : null;
}

export function sweepVehicle(dense: EN[], normals: EN[], v: Vehicle, zones: TiltZone[] = []): Sweep {
  const n = dense.length;
  const left = new Float64Array(n);
  const right = new Float64Array(n);
  const lhBase = bladeHorizontal(v);
  // 区間の外側（起立しない所）が最も長い。前後に足す長さはそれで決める
  const rearExtent = Math.max(v.kingpinToAxle + v.trailerTail, v.bladeRootAt + v.bladeLength) + v.tractorWheelbase;
  const ext = Math.ceil(rearExtent + 10);
  const path = extendLine(dense, ext, ext);
  const index = new StationIndex(dense);
  // ブレードの根元がいる起点からの距離で、起立の区間に入っているかを見る
  const lhAt = (root: EN): number => {
    if (!zones.length) return lhBase;
    const near = index.nearest(root, 150);
    if (!near) return lhBase;
    const z = zones.find((z) => near.index >= z.fromM && near.index <= z.toM);
    return z ? bladeHorizontal(v, z.tilt) : lhBase;
  };
  /** 台形の 4 隅。a→b が軸、幅は wa から wb へ変わる */
  const quad = (a: EN, b: EN, wa: number, wb: number): EN[] => {
    const axis = sub(b, a);
    const L = Math.hypot(axis[0], axis[1]) || 1e-6;
    const nrm: EN = [-axis[1] / L, axis[0] / L];
    return [add(a, mul(nrm, wa / 2)), add(b, mul(nrm, wb / 2)), sub(b, mul(nrm, wb / 2)), sub(a, mul(nrm, wa / 2))];
  };

  // 歩ごとの掃いた面（トラクタ・台車・ブレードの 3 つ。1 歩前の形と合わせた凸包）
  const faces: EN[][][] = [];
  const h0 = unit(sub(path[1], path[0]));
  let F = path[0];
  let A = sub(F, mul(h0, v.tractorWheelbase));
  let T = sub(A, mul(h0, v.kingpinToAxle));
  let prev: EN[][] | null = null;
  faces.push([]);
  for (let i = 1; i < path.length; i++) {
    F = path[i];
    A = follow(F, A, v.tractorWheelbase);
    const K = A;
    T = follow(K, T, v.kingpinToAxle);
    const ht = unit(sub(F, A));
    const hr = unit(sub(K, T));
    const root = sub(K, mul(hr, v.bladeRootAt));
    const cur: EN[][] = [
      // トラクタ：前のはみ出しから、駆動軸の 1m 後ろまで
      quad(add(F, mul(ht, v.tractorFront)), sub(A, mul(ht, 1.0)), v.tractorWidth, v.tractorWidth),
      // 台車：グースネックの前端から後端まで
      quad(add(K, mul(hr, v.trailerFront)), sub(T, mul(hr, v.trailerTail)), v.trailerWidth, v.trailerWidth),
      // ブレード：根元から後ろへ、水平の投影の長さだけ。幅は根元の直径から先の幅へ細る
      quad(root, sub(root, mul(hr, lhAt(root))), v.bladeRootDia, v.bladeTipWidth),
    ];
    faces.push(prev ? cur.map((q, k) => hull([...prev![k], ...q])) : cur);
    prev = cur;
  }

  // 各点の法線で面を横切り、道路から切れ目なく続く範囲の端を取る
  const ahead = Math.ceil(rearExtent + 30);
  const behind = Math.ceil(v.tractorFront + 30);
  for (let s = 0; s < n; s++) {
    const P = dense[s];
    const N = normals[s];
    const spans: [number, number][] = [];
    const i0 = Math.max(1, s + ext - behind);
    const i1 = Math.min(path.length - 1, s + ext + ahead);
    for (let i = i0; i <= i1; i++) {
      for (const poly of faces[i]) {
        const c = crossConvex(P, N, poly);
        if (c) spans.push(c);
      }
    }
    if (!spans.length) continue;
    spans.sort((a, b) => a[0] - b[0]);
    // 0（中心線）を含む（または 1m 以内の隙間でつながる）範囲だけを取る
    let lo = NaN;
    let hi = NaN;
    for (const [a, b] of spans) {
      if (Number.isNaN(lo)) {
        if (a > GAP_M) break; // 中心線を含む区間がない（車両はまだ来ていない）
        lo = a;
        hi = b;
        continue;
      }
      if (a <= hi + GAP_M) hi = Math.max(hi, b);
      else if (hi < -GAP_M) {
        // まだ中心線に届いていない区間だった。次へ
        lo = a;
        hi = b;
      } else break;
    }
    if (Number.isNaN(lo) || lo > GAP_M || hi < -GAP_M) continue;
    if (hi > 0) left[s] = hi;
    if (lo < 0) right[s] = -lo;
  }
  return { left, right };
}

/** 掃く範囲の左右の最大（m）。手順 2 の画面に出す */
export function sweepMax(s: Sweep): { left: number; right: number } {
  let l = 0;
  let r = 0;
  for (let i = 0; i < s.left.length; i++) {
    if (s.left[i] > l) l = s.left[i];
    if (s.right[i] > r) r = s.right[i];
  }
  return { left: l, right: r };
}

/* ---------- 余裕幅と伐採範囲 ---------- */

export interface BandParams {
  /** 道路の半幅（m）。ここから外側を伐採範囲にする */
  roadHalf: number;
  /** 余裕幅（m）。直線とカーブで変える（spec §8.3） */
  marginStraight: number;
  marginCurve: number;
  /** 掃く範囲（＋余裕幅）のさらに外へ切る幅（m） */
  cut: number;
}

export const DEFAULT_BAND: BandParams = { roadHalf: 3, marginStraight: 1, marginCurve: 2, cut: 3 };

/**
 * カーブかどうかを 1m ごとに。前後 span m の向きの差が thresholdDeg を超えたらカーブ。
 * 既定（5m・6°）は半径 100m くらいより急な曲がり
 */
export function curveFlags(dense: EN[], span = 5, thresholdDeg = 6): boolean[] {
  const n = dense.length;
  const out = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const a = dense[Math.max(0, i - span)];
    const b = dense[i];
    const c = dense[Math.min(n - 1, i + span)];
    const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = Math.abs(t2 - t1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    out[i] = (d * 180) / Math.PI > thresholdDeg;
  }
  return out;
}

/** 掃く範囲 → 伐採範囲の外側（中心線からの距離 m、1m ごと）。軌跡の情報がない所は NaN のまま */
export function outerFromSweep(sweep: Sweep, curve: boolean[], p: BandParams): { left: Float64Array; right: Float64Array } {
  const n = sweep.left.length;
  const left = new Float64Array(n);
  const right = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = (curve[i] ? p.marginCurve : p.marginStraight) + p.cut;
    left[i] = Number.isFinite(sweep.left[i]) ? sweep.left[i] + m : NaN;
    right[i] = Number.isFinite(sweep.right[i]) ? sweep.right[i] + m : NaN;
  }
  return { left, right };
}

/** 仮の帯（中心線から一定の幅）。軌跡図も車両もないときの代わり */
export function flatSweep(n: number, halfWidth: number): Sweep {
  return { left: new Float64Array(n).fill(halfWidth), right: new Float64Array(n).fill(halfWidth) };
}
