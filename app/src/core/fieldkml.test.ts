import { describe, expect, it } from "vitest";
import { listChecks } from "./checks";
import { cleanRings, fieldGeoJSON, fieldKml, treeKmlColor, type FieldMapInput } from "./fieldkml";
import { buildSegments, leftNormals, resample } from "./geom";
import { segmentsToGeoJSON } from "./parcels";
import { toLonLat, type EN } from "./proj";
import type { Judgment, ParcelHit, ParcelProps } from "./types";

function input(): FieldMapInput {
  // 小川村のあたりに東へ 100m の直線
  const dense = resample([[-45400, 71600], [-45300, 71600]] as EN[], 1);
  const segs = buildSegments(dense, leftNormals(dense), { step: 10, roadHalf: 3, bandOut: 10 });
  const ring: EN[] = [[-45390, 71605], [-45380, 71605], [-45380, 71615], [-45390, 71615], [-45390, 71605]];
  const hit: ParcelHit = { parcelId: "m:1", areaM2: 50, fromM: 10, toM: 20, sides: ["L"], segmentIds: ["L001"], segAreas: { L001: 50 }, shape: { type: "MultiPolygon", coordinates: [[ring.map((p) => toLonLat(p))]] } };
  const judgments = new Map<string, Judgment>([
    ["L001", { segmentId: "L001", tree: 75, kind: "広葉樹", other: [], conf: "低", why: "影が濃い", by: "Claude", model: "claude-sonnet-5-5" }],
    ["R001", { segmentId: "R001", tree: 0, kind: "なし", other: ["畑"], conf: "高", why: "畑", by: "人" }],
  ]);
  const parcelById = new Map<string, { properties: ParcelProps }>([["m:1", { properties: { id: "m:1", map: "m", oaza: "大字稲丘", chiban: "2303-1", kind: "ふつう" } }]]);
  return {
    title: "見本 現地マップ",
    roadName: "小川長野線",
    dense,
    hits: [hit],
    parcelById,
    segments: segmentsToGeoJSON(segs),
    judgments,
    checks: listChecks(segs, judgments, null),
    kps: [{ atM: 0, kp: 12 }, { atM: 100, kp: 12.1 }],
    forest: null,
    madeOn: "2026-11-03",
  };
}

describe("現地マップの書き出し", () => {
  it("KML にフォルダ（中心線・距離標・かかる筆・区切り・確かめる所）と、筆の吹き出し、判定の色が入る", () => {
    const kml = fieldKml(input());
    expect(kml).toContain("<kml");
    for (const f of ["中心線", "距離標（2）", "かかる筆（1）", "区切り（20）", "現地で確かめる所（1）"]) expect(kml).toContain(`<name>${f}`);
    expect(kml).toContain("<name>大字稲丘 2303-1</name>");
    expect(kml).toContain("<name>L001 木 75%</name>");
    expect(kml).toContain("<name>R001 木 0%（人）</name>");
    expect(kml).toContain("<name>L001（確信 低）</name>");
    expect(kml).toContain("<name>KP 12.10</name>");
    expect(kml).toContain("小川長野線 12.05km 付近（推定）"); // 50m の所
    expect(kml).toContain('<Style id="tree75">');
    expect(kml).toContain("登記所備付地図データ（法務省）を加工して作成");
    // 経度・緯度が小川村のあたり
    expect(kml).toMatch(/137\.9\d+,36\.6\d+,0/);
  });

  it("GeoJSON には同じものが属性つきで入る", () => {
    const fc = fieldGeoJSON(input());
    const kinds = new Map<string, number>();
    for (const f of fc.features) kinds.set(String(f.properties!.kind), (kinds.get(String(f.properties!.kind)) ?? 0) + 1);
    expect(kinds.get("hit")).toBe(1);
    expect(kinds.get("segment")).toBe(20);
    expect(kinds.get("check")).toBe(1);
    expect(kinds.get("kp")).toBe(2);
    expect(kinds.get("centerline")).toBe(1);
    const hit = fc.features.find((f) => f.properties!.kind === "hit")!;
    expect(hit.properties!.treeMax).toBe(75);
    expect(hit.properties!.chiban).toBe("2303-1");
  });

  it("現地の記録があれば、確かめる所の名前に○△×が付き、済みの印になり、吹き出しに入る", () => {
    const inp = input();
    inp.notes = new Map([["L001", { segmentId: "L001", result: "×", memo: "電線あり", at: "2026-11-03T01:00:00Z" }]]);
    const kml = fieldKml(inp);
    expect(kml).toContain("<name>L001（確信 低） ×</name>");
    expect(kml).toContain("#check-done");
    expect(kml).toContain("×：電線あり");
    const gj = fieldGeoJSON(inp);
    expect(gj.features.find((f) => f.properties!.kind === "check")!.properties!.note).toBe("×：電線あり");
  });

  it("地番の札（点）がかかる筆ごとに入り、字だけの様式になる", () => {
    const kml = fieldKml(input());
    expect(kml).toContain("<name>地番の札（1）</name>");
    expect(kml).toContain('<Style id="chiban"><IconStyle><scale>0</scale>');
    expect(kml).toMatch(/<Placemark><name>2303-1<\/name><styleUrl>#chiban<\/styleUrl>.*<Point><coordinates>137\.9\d+,36\.6\d+,0/);
    const gj = fieldGeoJSON(input());
    expect(gj.features.filter((f) => f.properties!.kind === "label")).toHaveLength(1);
  });

  it("面にならない欠片（点が 3 つ未満）は書き出さない。Google Earth が「閉じた多角形にならない」と警告して 0,0 に置くため", () => {
    const inp = input();
    const ring = inp.hits[0].shape.coordinates[0][0];
    // 線のような欠片（2 点を往復）と、1cm 未満の違いしかない点ばかりの欠片を足す
    const sliver: typeof ring = [ring[0], ring[1], ring[0]];
    const dust: typeof ring = [ring[0], [ring[0][0] + 1e-9, ring[0][1]], [ring[0][0], ring[0][1] + 1e-9], ring[0]];
    inp.hits[0].shape = { type: "MultiPolygon", coordinates: [[ring], [sliver], [dust]] };
    const kml = fieldKml(inp);
    expect(kml).not.toContain("<MultiGeometry>"); // 欠片が落ちて 1 つの面だけ
    expect(cleanRings([sliver])).toBeNull();
    expect(cleanRings([ring, dust])).toEqual([ring]);
    // 全部落ちたら、形のない Placemark になる（名前と吹き出しは残る）
    inp.hits[0].shape = { type: "MultiPolygon", coordinates: [[sliver]] };
    expect(fieldKml(inp)).toMatch(/<name>大字稲丘 2303-1<\/name><styleUrl>#hit<\/styleUrl><description>.*?<\/description><\/Placemark>/);
  });

  it("木の割合の色は aabbggrr で、多いほど赤く不透明", () => {
    expect(treeKmlColor(undefined)).toBe("59c8c8c8");
    expect(treeKmlColor(0)).toBe("40ffffff");
    expect(treeKmlColor(100)).toBe("a61c1cb7");
  });
});
