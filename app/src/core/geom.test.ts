import { describe, expect, it } from "vitest";
import { buildSegments, leftNormals, length, resample, ringArea } from "./geom";
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
