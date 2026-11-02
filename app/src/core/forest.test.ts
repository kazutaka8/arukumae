import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeForestTile, forestOfHits, forestText, noticeText, tileRange, type ForestPolygon } from "./forest";
import { toLonLat, type EN } from "./proj";
import type { ParcelHit } from "./types";

/** 平面座標（m）の四角を、緯度経度のかかる筆にする */
function hit(id: string, x0: number, y0: number, x1: number, y1: number): ParcelHit {
  const ring: EN[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  return { parcelId: id, areaM2: (x1 - x0) * (y1 - y0), fromM: 0, toM: 10, sides: ["L"], segmentIds: [], segAreas: {}, shape: { type: "MultiPolygon", coordinates: [[ring.map((p) => toLonLat(p))]] } };
}
function forest(kind: ForestPolygon["kind"], rinpan: string, x0: number, y0: number, x1: number, y1: number): ForestPolygon {
  const ring: EN[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  return { kind, rinpan, asOf: "2024/9/1", geometry: { type: "Polygon", coordinates: [ring.map((p) => toLonLat(p))] } };
}

describe("森林の区域", () => {
  it("保存したタイル（小川村、z16）を読むと民有林の多角形と林班が取れる", () => {
    const buf = readFileSync(new URL("./fixtures/forest_16_57888_25588.pbf", import.meta.url));
    const polys = decodeForestTile(buf, 57888, 25588, 16);
    expect(polys.length).toBe(3);
    expect(polys.every((p) => p.kind === "民有林")).toBe(true);
    expect(polys.map((p) => p.rinpan).sort()).toEqual(["0057", "0058", "0059"]);
    expect(polys[0].asOf).toBe("2024/9/1");
    const c = polys[0].geometry.type === "Polygon" ? polys[0].geometry.coordinates[0][0] : polys[0].geometry.coordinates[0][0][0];
    expect(c[0]).toBeGreaterThan(137.98);
    expect(c[1]).toBeGreaterThan(36.64);
  });

  it("タイルの番号は箱を覆う", () => {
    const r = tileRange([137.985, 36.645, 137.995, 36.655], 16);
    expect(r.x0).toBeLessThanOrEqual(57888);
    expect(r.x1).toBeGreaterThanOrEqual(57888);
    expect(r.y0).toBeLessThanOrEqual(25588);
    expect(r.y1).toBeGreaterThanOrEqual(25588);
  });

  it("かかる部分が区域に丸ごと入れば民有林、半分未満なら「一部」、外なら区域外。届出の目印は民有林だけ", () => {
    const polys = [forest("民有林", "0058", 0, 0, 100, 100), forest("国有林", "", 200, 0, 300, 100)];
    const hits = [hit("in", 10, 10, 30, 30), hit("part", 90, 10, 130, 30), hit("out", 150, 10, 170, 30), hit("nat", 210, 10, 230, 30)];
    const m = forestOfHits(hits, polys);
    expect(m.get("in")!.ratio).toBeCloseTo(1, 2);
    expect(forestText(m.get("in"))).toBe("民有林（林班 0058）");
    expect(noticeText(m.get("in"))).toBe("要るかもしれない（市町村に確かめる）");
    expect(m.get("part")!.ratio).toBeCloseTo(0.25, 2);
    expect(forestText(m.get("part"))).toBe("一部 民有林（林班 0058）");
    expect(forestText(m.get("out"))).toBe("区域外");
    expect(noticeText(m.get("out"))).toBe("");
    expect(forestText(m.get("nat"))).toBe("国有林");
    expect(noticeText(m.get("nat"))).toBe("");
  });
});
