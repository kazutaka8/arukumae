import { describe, expect, it } from "vitest";
import { leftNormals, resample } from "./geom";
import type { EN } from "./proj";
import { computeTrack, DEFAULT_TRACK, describeTrack, tiltZonesOf, type TrackSetting } from "./trackstate";
import { PRESETS, sweepMax, type TiltZone } from "./vehicle";

/** 東へ 200m 進み、半径 40m で左へ 90° 曲がり、北へ 200m 進む線 */
function leftTurn(): EN[] {
  const R = 40;
  const pts: EN[] = [[0, 0], [200, 0]];
  for (let k = 1; k <= 30; k++) {
    const a = (Math.PI / 2) * (k / 30);
    pts.push([200 + R * Math.sin(a), R - R * Math.cos(a)]);
  }
  pts.push([200 + R, R + 200]);
  return pts;
}

describe("起立の区間はブレードリフターだけ（Codex の指摘 2026-11-06：伸縮トレーラーに区間が残り、掃く範囲が狭く出た）", () => {
  const dense = resample(leftTurn(), 1);
  const normals = leftNormals(dense);
  const zones: TiltZone[] = [{ fromM: 150, toM: 320, tilt: 60 }];
  const of = (preset: "lifter" | "extendable", tiltZones: TiltZone[]): TrackSetting => ({ ...DEFAULT_TRACK, source: { kind: "vehicle", preset, vehicle: { ...PRESETS[preset].vehicle }, tiltZones } });

  it("伸縮トレーラーに区間が付いていても、区間なしと同じ範囲になる（狭く出ない）", () => {
    const withZones = computeTrack(dense, normals, of("extendable", zones));
    const without = computeTrack(dense, normals, of("extendable", []));
    expect(Array.from(withZones.sweep.left)).toEqual(Array.from(without.sweep.left));
    expect(Array.from(withZones.sweep.right)).toEqual(Array.from(without.sweep.right));
    expect(withZones.segments.map((s) => [s.id, s.areaM2])).toEqual(without.segments.map((s) => [s.id, s.areaM2]));
    expect(tiltZonesOf(of("extendable", zones).source)).toEqual([]);
    expect(describeTrack(of("extendable", zones))).not.toContain("起立の区間");
  });

  it("リフターでは区間が効き、曲がりの外側の振れが小さくなる", () => {
    const flat = computeTrack(dense, normals, of("lifter", []));
    const tilted = computeTrack(dense, normals, of("lifter", zones));
    expect(sweepMax(tilted.sweep).right).toBeLessThan(sweepMax(flat.sweep).right - 3);
    expect(tiltZonesOf(of("lifter", zones).source)).toEqual(zones);
    expect(describeTrack(of("lifter", zones))).toContain("起立の区間 1");
  });
});
