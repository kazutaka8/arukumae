import { describe, expect, it } from "vitest";
import { estimateKp, formatKp } from "./kp";

const marks = [
  { atM: 100, kp: 12.0 },
  { atM: 600, kp: 12.5 },
  { atM: 1100, kp: 13.1 }, // 改築で 500m あたり 0.6km ずれている、という作り
];

describe("estimateKp", () => {
  it("距離標が 2 本未満なら出さない", () => {
    expect(estimateKp([], 300)).toBeNull();
    expect(estimateKp([marks[0]], 300)).toBeNull();
  });

  it("挟む 2 本の間で直線補間し、根拠を出す", () => {
    const e = estimateKp(marks, 350)!;
    expect(e.kp).toBeCloseTo(12.25, 6);
    expect(e.extrapolated).toBe(false);
    expect(e.basis).toBe("距離標 12.00〜12.50 から補間");
  });

  it("近いほうの 2 本を使う（850m は 12.5〜13.1 の間）", () => {
    const e = estimateKp(marks, 850)!;
    expect(e.kp).toBeCloseTo(12.8, 6);
    expect(e.basis).toBe("距離標 12.50〜13.10 から補間");
  });

  it("距離標の外側は端の 2 本で外挿し、外挿と書く", () => {
    const before = estimateKp(marks, 0)!;
    expect(before.kp).toBeCloseTo(11.9, 6);
    expect(before.extrapolated).toBe(true);
    expect(before.basis).toContain("外挿");
    const after = estimateKp(marks, 1600)!;
    expect(after.kp).toBeCloseTo(13.7, 6);
    expect(after.basis).toBe("距離標 12.50〜13.10 から外挿");
  });

  it("距離標の上ではその値になる", () => {
    expect(estimateKp(marks, 600)!.kp).toBeCloseTo(12.5, 6);
  });

  it("表示の形", () => {
    expect(formatKp("小川長野線", estimateKp(marks, 350))).toBe("小川長野線 12.25km 付近（推定）");
    expect(formatKp("小川長野線", null)).toBe("");
  });
});
