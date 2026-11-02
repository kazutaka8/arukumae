/**
 * かかる筆の拾い方の回帰テスト（spec §10）。
 * 2026-11-02 に見本で確かめた「地区外の区画が隣の地図の筆を丸ごと含む」事実を、小さな形で固定する。
 */
import { describe, expect, it } from "vitest";
import type { Feature, Polygon } from "geojson";
import { buildSegments, leftNormals, resample } from "./geom";
import { findHits, type ParcelFeature } from "./parcels";
import { toLonLat, type EN } from "./proj";
import type { ParcelKind } from "./types";

/** 平面座標（m）の四角を、緯度経度の筆にする */
function parcel(id: string, kind: ParcelKind, x0: number, y0: number, x1: number, y1: number): ParcelFeature {
  const ring: EN[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const f: Feature<Polygon> = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring.map((p) => toLonLat(p))] } };
  return { ...f, properties: { id, map: "t", oaza: null, chiban: id, kind } } as ParcelFeature;
}

// 東西にまっすぐ 100m の中心線（原点の近く。平面直角 VIII 系の原点は東経138.5度・北緯36度）
const line: EN[] = [[0, 0], [100, 0]];
const dense = resample(line, 1);
const segs = buildSegments(dense, leftNormals(dense)); // 左（北側）y=3〜13、右（南側）y=-13〜-3

describe("findHits", () => {
  it("帯に少しでも重なる筆を拾い、重なる面積と区切りを返す", () => {
    const p = parcel("a", "ふつう", 20, 5, 40, 30); // 北側、帯（y 3〜13）と 20m×8m 重なる
    const hits = findHits([p], segs);
    expect(hits).toHaveLength(1);
    expect(hits[0].areaM2).toBeCloseTo(160, 0);
    expect(hits[0].sides).toEqual(["L"]);
    expect(hits[0].segmentIds).toEqual(["L002", "L003"]);
    expect(hits[0].fromM).toBe(20);
    expect(hits[0].toM).toBe(40);
    expect(hits[0].shape.type).toBe("MultiPolygon");
  });

  it("帯から離れた筆は拾わない", () => {
    expect(findHits([parcel("b", "ふつう", 20, 20, 40, 30)], segs)).toHaveLength(0);
  });

  it("地区外・別図は、帯を丸ごと覆っていても拾わない（隣の地図を指す印で、土地ではない）", () => {
    const outside = parcel("c", "地区外", -10, -30, 110, 30);
    const other = parcel("d", "別図", -10, -30, 110, 30);
    const real = parcel("e", "ふつう", 20, 5, 40, 30);
    const hits = findHits([outside, other, real], segs);
    expect(hits.map((h) => h.parcelId)).toEqual(["e"]);
  });

  it("かかる部分の面積は、重なる区切りの面積の合計を超えない", () => {
    const big = parcel("f", "ふつう", -50, -50, 150, 50); // 帯を全部含む大きな筆
    const [h] = findHits([big], segs);
    const total = segs.reduce((a, s) => a + s.areaM2, 0);
    expect(h.areaM2).toBeLessThanOrEqual(total + 0.1);
    expect(h.areaM2).toBeGreaterThan(total - 1);
    expect(h.sides).toEqual(["L", "R"]);
  });
});
