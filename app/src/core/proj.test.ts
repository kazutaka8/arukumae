import { describe, expect, it } from "vitest";
import { toLonLat, toPlane } from "./proj";

// 期待値は tools/jgd8.py（国土地理院の式）で出した。proj4 と 1cm 以内で合うことを固定する
const CASES: { lonlat: [number, number]; en: [number, number] }[] = [
  { lonlat: [138.5, 36.0], en: [0, 0] }, // 第VIII系の原点
  { lonlat: [137.991895, 36.644648], en: [-45432.5, 71646.443] }, // デモの区間の起点
  { lonlat: [139.0, 37.0], en: [44501.543, 111074.067] },
];

describe("平面直角座標系 第VIII系", () => {
  for (const c of CASES) {
    it(`${c.lonlat} → 東 ${c.en[0]} 北 ${c.en[1]}`, () => {
      const [e, n] = toPlane(c.lonlat);
      expect(Math.abs(e - c.en[0])).toBeLessThan(0.01);
      expect(Math.abs(n - c.en[1])).toBeLessThan(0.01);
    });
    it(`往復で元に戻る ${c.lonlat}`, () => {
      const [lon, lat] = toLonLat(toPlane(c.lonlat));
      expect(Math.abs(lon - c.lonlat[0])).toBeLessThan(1e-8);
      expect(Math.abs(lat - c.lonlat[1])).toBeLessThan(1e-8);
    });
  }
});
