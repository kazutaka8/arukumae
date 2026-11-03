import { describe, expect, it } from "vitest";
import { currentZone, setZone, toLonLat, toLonLatZone, toPlane, toPlaneZone, zoneFromCrs, zoneLabel, zoneOf } from "./proj";

// 期待値は tools/jgd8.py（国土地理院の式）で出した。proj4 と 1cm 以内で合うことを固定する
const CASES: { lonlat: [number, number]; en: [number, number] }[] = [
  { lonlat: [138.5, 36.0], en: [0, 0] }, // 第VIII系の原点
  { lonlat: [137.991895, 36.644648], en: [-45432.5, 71646.443] }, // デモの区間の起点
  { lonlat: [139.0, 37.0], en: [44501.543, 111074.067] },
];

describe("平面直角座標系 第VIII系（既定。系を場所から決めるようにしても値が変わらない）", () => {
  it("既定の系は第VIII系", () => {
    expect(currentZone()).toBe(8);
  });
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

// 第X系（原点 北緯 40 度・東経 140 度 50 分）。期待値は tools/jgd8.py の to_plane(lat, lon, zone=10)。EN は [東, 北]
const CASES_X: { lonlat: [number, number]; en: [number, number] }[] = [
  { lonlat: [140 + 50 / 60, 40.0], en: [0, 0] },
  { lonlat: [141.0, 39.9], en: [14251.627, -11088.961] },
  { lonlat: [140.5, 40.5], en: [-28253.121, 55567.544] },
  { lonlat: [140.9, 38.3], en: [5830.98, -188710.24] },
];

describe("ほかの系", () => {
  for (const c of CASES_X) {
    it(`第X系 ${c.lonlat} → 東 ${c.en[0]} 北 ${c.en[1]}、往復で戻る`, () => {
      const [e, n] = toPlaneZone(10, c.lonlat);
      expect(Math.abs(e - c.en[0])).toBeLessThan(0.01);
      expect(Math.abs(n - c.en[1])).toBeLessThan(0.01);
      const [lon, lat] = toLonLatZone(10, [e, n]);
      expect(Math.abs(lon - c.lonlat[0])).toBeLessThan(1e-8);
      expect(Math.abs(lat - c.lonlat[1])).toBeLessThan(1e-8);
    });
  }
  it("第IX系・第I系・第XII系の 1 点ずつ（jgd8.py の値）", () => {
    const near = (a: [number, number], b: [number, number]) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.01);
    near(toPlaneZone(9, [139.7, 35.7]), [-12065.989, -33275.346]);
    near(toPlaneZone(1, [129.9, 33.5]), [37165.42, 55520.517]);
    near(toPlaneZone(12, [141.4, 43.1]), [-69190.57, -99632.424]);
  });
  it("setZone で toPlane の系が変わり、戻せる", () => {
    setZone(10);
    try {
      expect(currentZone()).toBe(10);
      const [e, n] = toPlane([141.0, 39.9]);
      expect(Math.abs(e - 14251.627)).toBeLessThan(0.01);
      expect(Math.abs(n + 11088.961)).toBeLessThan(0.01);
    } finally {
      setZone(8);
    }
    expect(() => setZone(20)).toThrow(/1〜19/);
    expect(() => setZone(0)).toThrow(/1〜19/);
  });
});

describe("場所から系を決める", () => {
  it("見本の小川村は第VIII系、東北の内陸は第X系、東京は第IX系、札幌は第XII系、那覇は第XV系", () => {
    expect(zoneOf([137.9895, 36.6475])).toBe(8);
    expect(zoneOf([141.0, 39.9])).toBe(10);
    expect(zoneOf([139.7, 35.7])).toBe(9);
    expect(zoneOf([141.35, 43.06])).toBe(12);
    expect(zoneOf([127.68, 26.21])).toBe(15);
    expect(zoneOf([142.19, 27.09])).toBe(14); // 小笠原
    expect(zoneOf([124.2, 24.4])).toBe(16); // 石垣
    expect(zoneOf([130.4, 33.6])).toBe(2); // 福岡
  });
  it("地図XML の <座標系> から系を読む。任意座標系は null", () => {
    expect(zoneFromCrs("公共座標8系")).toBe(8);
    expect(zoneFromCrs("公共座標系第10系")).toBe(10);
    expect(zoneFromCrs("公共座標１０系")).toBe(10);
    expect(zoneFromCrs("公共座標VIII系")).toBe(8);
    expect(zoneFromCrs("任意座標系")).toBeNull();
    expect(zoneFromCrs("")).toBeNull();
    expect(zoneFromCrs("公共座標25系")).toBeNull();
    expect(zoneLabel(8)).toBe("第VIII系");
  });
});
