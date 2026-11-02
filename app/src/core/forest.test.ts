import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkText, listChecks } from "./checks";
import { decodeForestTile, ForestIndex, forestMismatch, forestOfHits, forestOfSegments, forestText, noticeText, tileRange, type ForestPolygon } from "./forest";
import { buildSegments, leftNormals, resample } from "./geom";
import { toLonLat, type EN } from "./proj";
import type { Judgment, ParcelHit } from "./types";

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

describe("森林の区域と判定の突き合わせ", () => {
  // 東へ 200m の直線。左側（北、y>0）の 0〜100m だけが民有林の区域
  const dense = resample([[0, 0], [200, 0]], 1);
  const normals = leftNormals(dense);
  const segs = buildSegments(dense, normals, { step: 10, roadHalf: 3, bandOut: 13 });
  const index = new ForestIndex([forest("民有林", "0001", -50, 0, 100, 80)]);
  const sf = forestOfSegments(segs, index, dense, normals, 3);

  it("区切りごとの割合：区域の中は 1、外は 0。縁の近く（100m）は広げた形が混じる", () => {
    expect(sf.get("L003")!.ratio).toBeCloseTo(1, 2);
    expect(sf.get("L003")!.wide).toBeCloseTo(1, 2);
    expect(sf.get("L015")!.ratio).toBeCloseTo(0, 2);
    expect(sf.get("R003")!.ratio).toBeCloseTo(0, 2);
    expect(sf.get("L009")!.ratio).toBeCloseTo(1, 2); // 90〜100m は区域の中だが…
    expect(sf.get("L009")!.wide).toBeLessThan(0.9); // 15m 広げると区域の外が混じる
  });

  it("区域の中で木が少ない・区域の外で木が多い区切りだけを拾い、縁の近くは拾わない", () => {
    const j = (id: string, tree: number): [string, Judgment] => [id, { segmentId: id, tree, kind: "広葉樹", other: [], conf: "高", why: "", by: "Claude" }];
    const judgments = new Map<string, Judgment>([j("L003", 0), j("L004", 100), j("L009", 0), j("L015", 100), j("L016", 25), j("R003", 100)]);
    const flags = forestMismatch(segs, judgments, sf);
    expect(flags.has("L003")).toBe(true); // 区域なのに 0%
    expect(flags.get("L003")).toContain("区域なのに");
    expect(flags.has("L004")).toBe(false); // 区域で 100%：合っている
    expect(flags.has("L009")).toBe(false); // 縁の近く
    expect(flags.has("L015")).toBe(true); // 区域外なのに 100%
    expect(flags.has("L016")).toBe(false); // 区域外で 25%：合っている
    expect(flags.has("R003")).toBe(true); // 右（南）は区域外で、広げた形も道をまたがないので区域外のまま。100% なら拾う
  });

  it("確かめる所の並びは、確信「低」と森林の食い違いを区切りの順に合わせる", () => {
    const judgments = new Map<string, Judgment>([
      ["L003", { segmentId: "L003", tree: 0, kind: "なし", other: [], conf: "高", why: "", by: "Claude" }],
      ["L001", { segmentId: "L001", tree: 50, kind: "広葉樹", other: [], conf: "低", why: "影が濃い", by: "Claude" }],
    ]);
    const flags = forestMismatch(segs, judgments, sf);
    const checks = listChecks(segs, judgments, flags);
    expect(checks.map((c) => `${c.segmentId}:${c.kind}`)).toEqual(["L001:低", "L003:森林"]);
    expect(checkText(checks)).toBe("L001：影が濃い ／ L003（森林）：" + flags.get("L003"));
  });
});
