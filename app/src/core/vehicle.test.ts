import { describe, expect, it } from "vitest";
import { buildSegments, leftNormals, resample, StationIndex } from "./geom";
import type { EN } from "./proj";
import { bladeHorizontal, curveFlags, DEFAULT_BAND, extendLine, outerFromSweep, PRESETS, sweepMax, sweepVehicle } from "./vehicle";

/** 東へ 200m 進み、半径 R で左へ 90° 曲がり、北へ 200m 進む線 */
function leftTurn(R: number): EN[] {
  const pts: EN[] = [[0, 0], [200, 0]];
  for (let k = 1; k <= 30; k++) {
    const a = (Math.PI / 2) * (k / 30);
    pts.push([200 + R * Math.sin(a), R - R * Math.cos(a)]);
  }
  pts.push([200 + R, R + 200]);
  return pts;
}

describe("追従の計算（架空の軌跡図）", () => {
  const v = PRESETS.extendable.vehicle; // 水平のブレード 55m

  it("直線では、掃く幅は車体とブレードの根元のいちばん広いもの（根元の直径 4m → 左右 2m）", () => {
    const dense = resample([[0, 0], [400, 0]], 1);
    const sw = sweepVehicle(dense, leftNormals(dense), v);
    for (let i = 50; i < 350; i++) {
      expect(sw.left[i]).toBeCloseTo(2, 1);
      expect(sw.right[i]).toBeCloseTo(2, 1);
    }
  });

  it("左カーブでは、内側（左）に台車とブレードが切れ込み、外側（右）にブレードの先が振れる。どちらも直線より広い", () => {
    const dense = resample(leftTurn(40), 1);
    const sw = sweepVehicle(dense, leftNormals(dense), v);
    const { left, right } = sweepMax(sw);
    // 半径 40m・キングピン〜後軸 30m では、内側の切れ込みが 10m を超える。外側の振れは小さい（先が後軸から 22m しか出ていないため）
    expect(left).toBeGreaterThan(10);
    expect(right).toBeGreaterThan(3);
    // 曲がりから離れた直線の部分は 2m のまま
    expect(sw.left[50]).toBeCloseTo(2, 1);
    expect(sw.right[50]).toBeCloseTo(2, 1);
  });

  it("ブレードを立てるほど水平の長さが縮み、掃く幅は狭くなる（リフター：台車が短く、ブレードが幅を決める）", () => {
    const dense = resample(leftTurn(40), 1);
    const normals = leftNormals(dense);
    const lv = PRESETS.lifter.vehicle; // 既定は寝かせる（tilt 0）
    const flat = sweepMax(sweepVehicle(dense, normals, { ...lv, tilt: 0 }));
    const up = sweepMax(sweepVehicle(dense, normals, { ...lv, tilt: 60 }));
    expect(bladeHorizontal({ ...v, tilt: 60 })).toBeCloseTo(27.5, 5);
    expect(up.left).toBeLessThan(flat.left);
    expect(up.right).toBeLessThan(flat.right);
  });

  it("起立の区間：その区間を通るときだけ立てる。区間の掃く幅は全部立てたときと同じで、区間の外は寝かせたまま", () => {
    const dense = resample(leftTurn(40), 1);
    const normals = leftNormals(dense);
    const lv = { ...PRESETS.lifter.vehicle, tilt: 0 };
    const zoned = sweepVehicle(dense, normals, lv, [{ fromM: 150, toM: 330, tilt: 60 }]);
    const up = sweepVehicle(dense, normals, { ...lv, tilt: 60 });
    const flat = sweepVehicle(dense, normals, lv);
    expect(sweepMax(zoned).left).toBeCloseTo(sweepMax(up).left, 1);
    expect(sweepMax(zoned).left).toBeLessThan(sweepMax(flat).left);
    expect(zoned.left[30]).toBeCloseTo(flat.left[30], 3); // 区間に入る前
    expect(zoned.right[dense.length - 20]).toBeCloseTo(flat.right[dense.length - 20], 3); // 区間を出たあと（直線）
  });

  it("ヘアピンの外側でも、両隣より 1m 以上へこむ点がない（先が飛び越した所の幅が落ちてギザギザにならない）", () => {
    // 北へ 150m → 半径 15m で右へ 180° → 南へ 150m
    const pts: EN[] = [[0, 0], [0, 150]];
    for (let k = 1; k <= 36; k++) {
      const a = Math.PI * (k / 36);
      pts.push([15 - 15 * Math.cos(a), 150 + 15 * Math.sin(a)]);
    }
    pts.push([30, 0]);
    const dense = resample(pts, 1);
    const sw = sweepVehicle(dense, leftNormals(dense), { ...PRESETS.lifter.vehicle, tilt: 0 });
    // 右カーブの外側は左。寝かせた 60m のブレードの先が大きく振れる
    expect(sweepMax(sw).left).toBeGreaterThan(20);
    // 幅が単調に増える・減るのは先が振れる形そのもの。直すのは「1 点だけ落ちる」ノコギリなので、両隣の小さいほうとの差で見る
    let worst = 0;
    for (let i = 100; i < dense.length - 100; i++) {
      for (const a of [sw.left, sw.right]) worst = Math.max(worst, Math.min(a[i - 1], a[i + 1]) - a[i]);
    }
    expect(worst).toBeLessThan(1);
  });

  it("中心線の前後に点を足す（車両が区間の外から入って出ていくまでを計算するため）", () => {
    const ext = extendLine([[0, 0], [10, 0]], 3, 2);
    expect(ext[0]).toEqual([-3, 0]);
    expect(ext.at(-1)).toEqual([12, 0]);
    expect(ext.length).toBe(7);
  });
});

describe("余裕幅と伐採範囲", () => {
  const dense = resample(leftTurn(40), 1);
  const curve = curveFlags(dense);

  it("直線はカーブでなく、半径 40m の曲がりはカーブ", () => {
    expect(curve[50]).toBe(false);
    expect(curve[200 + 30]).toBe(true); // 曲がりの途中
    expect(curve[dense.length - 50]).toBe(false);
  });

  it("伐採範囲の外側 = 掃く範囲 + 余裕幅（直線 1 / カーブ 2）+ 伐採の幅 3", () => {
    const sw = sweepVehicle(dense, leftNormals(dense), PRESETS.lifter.vehicle);
    const outer = outerFromSweep(sw, curve, DEFAULT_BAND);
    expect(outer.left[50]).toBeCloseTo(sw.left[50] + 1 + 3, 6);
    expect(outer.left[230]).toBeCloseTo(sw.left[230] + 2 + 3, 6);
  });
});

describe("区切りを包絡線から作る", () => {
  const dense = resample([[0, 0], [100, 0]], 1);
  const normals = leftNormals(dense);

  it("外側が左右の配列でも作れ、幅が道路の端を越えない所の区切りは作らない", () => {
    const left = new Float64Array(dense.length).fill(8);
    const right = new Float64Array(dense.length).fill(2); // 道路の半幅 3 より内側 → 右は切らない
    const segs = buildSegments(dense, normals, { step: 10, roadHalf: 3, bandOut: { left, right } });
    expect(segs.every((s) => s.side === "L")).toBe(true);
    expect(segs.length).toBe(10);
    expect(segs[0].outerMaxM).toBe(8);
    expect(Math.abs(segs[0].areaM2 - 50)).toBeLessThan(1e-6); // 10m × (8-3)m
  });

  it("NaN（軌跡図がない所）は切らない扱い", () => {
    const left = new Float64Array(dense.length).fill(NaN);
    left.fill(10, 0, 30); // 0〜29m だけ情報がある（30m の区切りには 1 点もかからない）
    const right = new Float64Array(dense.length).fill(NaN);
    const segs = buildSegments(dense, normals, { step: 10, roadHalf: 3, bandOut: { left, right } });
    expect(segs.map((s) => s.id)).toEqual(["L000", "L001", "L002"]);
  });
});

describe("最寄りの点の索引", () => {
  it("全点を見る nearestOnLine と同じ答え", () => {
    const dense = resample(leftTurn(40), 1);
    const idx = new StationIndex(dense);
    const p: EN = [230, 20];
    const got = idx.nearest(p, 200)!;
    let best = { dist: Infinity, index: -1 };
    dense.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best.dist) best = { dist: d, index: i };
    });
    expect(got.index).toBe(best.index);
    expect(idx.nearest([5000, 5000], 100)).toBeNull();
  });
});
