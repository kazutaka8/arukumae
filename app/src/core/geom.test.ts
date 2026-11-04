import { describe, expect, it } from "vitest";
import * as turf from "@turf/turf";
import { buildSegments, curveRadii, leftNormals, length, resample, ringArea } from "./geom";
import type { EN } from "./proj";

describe("中心線の打ち直し", () => {
  it("100m の直線を 1m ごとにすると 101 点", () => {
    const pts = resample([[0, 0], [100, 0]], 1);
    expect(pts.length).toBe(101);
    expect(pts[50]).toEqual([50, 0]);
  });
  it("折れ線でも辺をまたいで等間隔になる", () => {
    const pts = resample([[0, 0], [3.5, 0], [3.5, 6.5]], 1);
    expect(pts.length).toBe(11); // 0〜10m の 11 点
    // 3m は最初の辺の上、4m は角を曲がって 0.5m 先（道のりで 1m）
    expect(pts[3]).toEqual([3, 0]);
    expect(Math.abs(pts[4][0] - 3.5)).toBeLessThan(1e-9);
    expect(Math.abs(pts[4][1] - 0.5)).toBeLessThan(1e-9);
  });
  it("長さ", () => {
    expect(length([[0, 0], [3, 4]])).toBe(5);
  });
});

describe("区切り", () => {
  const line: EN[] = [[0, 0], [100, 0]]; // 東へ進む直線
  const dense = resample(line, 1);
  const segs = buildSegments(dense, leftNormals(dense));

  it("100m の直線は 10 個 × 左右 = 20 区切り", () => {
    expect(segs.length).toBe(20);
    expect(segs.map((s) => s.id).slice(0, 4)).toEqual(["L000", "R000", "L001", "R001"]);
  });
  it("左の区切りは北側（進行方向が東なら左は北）", () => {
    const l = segs.find((s) => s.id === "L003")!;
    expect(l.ring.every(([, n]) => n >= 3 - 1e-9 && n <= 13 + 1e-9)).toBe(true);
    const r = segs.find((s) => s.id === "R003")!;
    expect(r.ring.every(([, n]) => n <= -3 + 1e-9 && n >= -13 - 1e-9)).toBe(true);
  });
  it("起点からの距離は 10m 刻み", () => {
    const s = segs.find((s) => s.id === "L003")!;
    expect([s.fromM, s.toM]).toEqual([30, 40]);
  });
  it("直線の区切りの面積は 10m × 10m = 100m²", () => {
    for (const s of segs) expect(Math.abs(s.areaM2 - 100)).toBeLessThan(1e-6);
  });
  it("面積の合計は帯の面積と合う（2 × 100m × 10m）", () => {
    const total = segs.reduce((a, s) => a + s.areaM2, 0);
    expect(Math.abs(total - 2000)).toBeLessThan(1e-6);
  });
});

describe("多角形の面積", () => {
  it("3-4-5 の直角三角形は 6", () => {
    expect(ringArea([[0, 0], [3, 0], [0, 4]])).toBe(6);
  });
});

describe("ヘアピンの区切り", () => {
  /** 東へ 60m → 半径 8m で左へ 180° → 西へ 60m */
  const line: EN[] = [[0, 0], [60, 0]];
  for (let k = 1; k <= 36; k++) {
    const a = Math.PI * (k / 36);
    line.push([60 + 8 * Math.sin(a), 8 - 8 * Math.cos(a)]);
  }
  line.push([0, 16]);
  const dense = resample(line, 1);
  const segs = buildSegments(dense, leftNormals(dense), { step: 10, roadHalf: 3, bandOut: 13, minAreaM2: 30 });

  it("曲がりの半径がだいたい出る（直線は無限大、円弧は 8m 前後で左曲がり）", () => {
    const r = curveRadii(dense);
    expect(r[20].radius).toBe(Infinity);
    const mid = r[60 + 12];
    expect(mid.turn).toBe(1);
    expect(mid.radius).toBeGreaterThan(6);
    expect(mid.radius).toBeLessThan(11);
  });

  it("内側（左）の区切りの線は折り返さず（自分で交わらず）、面積は正", () => {
    for (const s of segs) {
      expect(s.areaM2).toBeGreaterThan(0);
      const kinks = turf.kinks(turf.polygon([s.ring.map((p) => [p[0], p[1]])]));
      expect(kinks.features.length, `${s.id} が自分で交わる`).toBe(0);
    }
  });

  it("内側の小さい区切りは隣と合わせられ、30m² 未満の区切りは残らない。番号と範囲はつながる", () => {
    const left = segs.filter((s) => s.side === "L");
    for (const s of left) expect(s.areaM2).toBeGreaterThanOrEqual(30);
    expect(left.some((s) => s.toM - s.fromM > 10)).toBe(true); // 合わせた区切りがある
    for (let i = 1; i < left.length; i++) expect(left[i].fromM).toBe(left[i - 1].toM);
    // 外側（右）は 10m のまま
    expect(segs.filter((s) => s.side === "R").every((s) => s.toM - s.fromM <= 10)).toBe(true);
  });
});

describe("長い道の区切りの番号", () => {
  it("10km を超えると 4 桁になり（L1000）、案件ファイルの番号の検め（/^[LR]\\d{3,}$/）と合う", () => {
    const dense = resample([[0, 0], [10_050, 0]] as EN[], 1);
    const segs = buildSegments(dense, leftNormals(dense));
    const ids = segs.map((s) => s.id);
    expect(ids).toContain("L999");
    expect(ids).toContain("L1000");
    expect(ids).toContain("R1004");
    expect(ids.every((id) => /^[LR]\d{3,}$/.test(id))).toBe(true);
  });
});

describe("終端の余り（Codex の指摘 2026-11-04）", () => {
  it("101m の直線は最後の 1m も区切りに入る（前の区切りに合わさって 90〜101m）", () => {
    const dense = resample([[0, 0], [101, 0]] as EN[], 1);
    const segs = buildSegments(dense, leftNormals(dense));
    const left = segs.filter((s) => s.side === "L");
    expect(left.length).toBe(10);
    expect([left.at(-1)!.fromM, left.at(-1)!.toM]).toEqual([90, 101]);
  });
  it("100m ちょうどなら 10 個のまま、終わりは 100m", () => {
    const dense = resample([[0, 0], [100, 0]] as EN[], 1);
    const left = buildSegments(dense, leftNormals(dense)).filter((s) => s.side === "L");
    expect(left.length).toBe(10);
    expect(left.at(-1)!.toM).toBe(100);
  });
  it("104m なら余りの 4m は独立した区切り（3m 以上は残す）", () => {
    const dense = resample([[0, 0], [104, 0]] as EN[], 1);
    const left = buildSegments(dense, leftNormals(dense)).filter((s) => s.side === "L");
    expect(left.length).toBe(11);
    expect([left.at(-1)!.fromM, left.at(-1)!.toM]).toEqual([100, 104]);
  });
});
