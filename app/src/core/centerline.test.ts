import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { dedupe, lengthM, lineChoices, pickCenterline, reversed, roadNameFromLine, validateCenterline } from "./centerline";
import { parseNamedBytes, parseNamedLines } from "./track";

const KML = `<?xml version="1.0"?><kml><Document><name>軌跡図</name>
  <Placemark><name>外側線</name><LineString><coordinates>137.9,36.6,0 137.901,36.6,0 137.902,36.601,0</coordinates></LineString></Placemark>
  <Placemark><name><![CDATA[中心線 &amp; CL]]></name><LineString><coordinates>137.9,36.6005,0 137.901,36.6005,0</coordinates></LineString></Placemark>
  <Placemark><name>掃く範囲</name><Polygon><outerBoundaryIs><LinearRing><coordinates>137.9,36.6,0 137.91,36.6,0 137.91,36.61,0 137.9,36.6,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>伐採範囲の外側（左）</name><LineString><coordinates>137.9,36.7,0 137.901,36.7,0</coordinates></LineString></Placemark>
  <Placemark><name>目印</name><Point><coordinates>137.9,36.6,0</coordinates></Point></Placemark>
</Document></kml>`;

describe("軌跡図の線に名前を付けて読む", () => {
  it("KML の Placemark の名前が付き、多角形の縁は ring。「伐採範囲」の線は飛ばす", () => {
    const lines = parseNamedLines("a.kml", KML);
    expect(lines.map((l) => [l.name, l.coords.length, l.ring])).toEqual([
      ["外側線", 3, false],
      ["中心線 & CL", 2, false],
      ["掃く範囲", 4, true],
    ]);
    expect(parseNamedBytes("a.kml", strToU8(KML)).length).toBe(3);
  });
  it("GeoJSON は properties.name。Polygon の縁は ring", () => {
    const fc = { type: "FeatureCollection", features: [
      { type: "Feature", properties: { name: "center" }, geometry: { type: "LineString", coordinates: [[137.9, 36.6], [137.91, 36.6]] } },
      { type: "Feature", properties: null, geometry: { type: "Polygon", coordinates: [[[137.9, 36.6], [137.91, 36.6], [137.91, 36.61], [137.9, 36.6]]] } },
      { type: "Feature", properties: { kind: "cut" }, geometry: { type: "LineString", coordinates: [[137.9, 36.7], [137.91, 36.7]] } },
    ] };
    const lines = parseNamedLines("a.geojson", JSON.stringify(fc));
    expect(lines.map((l) => [l.name, l.ring])).toEqual([["center", false], ["", true]]);
  });
});

describe("中心線を選ぶ", () => {
  it("長い順に並び、名前に「中心線」「CL」「center」があれば最初から選ぶ。多角形の縁は選ばない", () => {
    const choices = lineChoices(parseNamedLines("a.kml", KML));
    expect(choices.map((c) => c.name)).toEqual(["掃く範囲", "外側線", "中心線 & CL"]);
    expect(pickCenterline(choices)).toBe(2);
    const noCenter = lineChoices(parseNamedLines("a.kml", KML.replace("中心線 &amp; CL", "内側線")));
    expect(pickCenterline(noCenter)).toBe(-1);
    const en = lineChoices([{ name: "Center Line A", coords: [[137.9, 36.6], [137.91, 36.6]], ring: false }, { name: "centerline B", coords: [[137.9, 36.6], [137.92, 36.6]], ring: false }]);
    expect(pickCenterline(en)).toBe(0); // 長いほう（centerline B）が先頭
  });
  it("長さ・反転・重なった点・使えるかの確認", () => {
    const line: [number, number][] = [[137.991895, 36.644648], [137.986980, 36.650153]];
    expect(lengthM(line)).toBeGreaterThan(740);
    expect(lengthM(line)).toBeLessThan(760);
    expect(reversed(line)[0]).toEqual([137.986980, 36.650153]);
    expect(dedupe([[1, 1], [1, 1], [2, 2], [2, 2], [3, 3]])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(validateCenterline(line)).toBeNull();
    expect(validateCenterline([[1, 1], [1, 1]])).toMatch(/2 つ以上/);
    expect(validateCenterline([[137.9, 36.6], [137.90001, 36.6]])).toMatch(/短すぎ/);
    expect(validateCenterline([[137.0, 36.6], [138.0, 36.6]])).toMatch(/長すぎ/);
  });
  it("線の名前から道路名の候補を拾う", () => {
    expect(roadNameFromLine("中心線")).toBe("");
    expect(roadNameFromLine("県道401号 中心線")).toBe("県道401号");
    expect(roadNameFromLine("小川長野線（CL）")).toBe("小川長野線");
  });
});
