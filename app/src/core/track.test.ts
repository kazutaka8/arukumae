import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { leftNormals, resample } from "./geom";
import type { EN } from "./proj";
import { linesToPlane, parseTrackBytes, parseTrackFile, sweepFromLines, trackGeoJSON, trackKml } from "./track";
import { PRESETS, sweepVehicle } from "./vehicle";

/** 平面直角座標 VIII 系で、見本の区間に近い所（長野県小川村のあたり）に置いた線。緯度経度への換算が正しく働く範囲で試すため */
function arcLine(): EN[] {
  const x0 = -45400;
  const y0 = 71600;
  const R = 60;
  const pts: EN[] = [[x0, y0], [x0 + 150, y0]];
  for (let k = 1; k <= 30; k++) {
    const a = (Math.PI / 2) * (k / 30);
    pts.push([x0 + 150 + R * Math.sin(a), y0 + R - R * Math.cos(a)]);
  }
  pts.push([x0 + 150 + R, y0 + R + 150]);
  return pts;
}

describe("軌跡図の書き出しと読み込み", () => {
  const dense = resample(arcLine(), 1);
  const normals = leftNormals(dense);
  const sweep = sweepVehicle(dense, normals, PRESETS.lifter.vehicle);

  it("GeoJSON に書いて読み直すと、掃く範囲がほぼ元どおり（往復）", () => {
    const fc = trackGeoJSON(dense, normals, sweep, null);
    const lines = parseTrackFile("x.geojson", JSON.stringify(fc));
    expect(lines.length).toBe(3); // 多角形の縁、左の縁、右の縁
    const back = sweepFromLines(dense, normals, linesToPlane(lines));
    for (let i = 20; i < dense.length - 20; i += 7) {
      expect(Math.abs(back.left[i] - sweep.left[i])).toBeLessThan(0.5);
      expect(Math.abs(back.right[i] - sweep.right[i])).toBeLessThan(0.5);
    }
  });

  it("KML に書いて読み直しても同じ", () => {
    const fc = trackGeoJSON(dense, normals, sweep, { left: sweep.left, right: sweep.right });
    const kml = trackKml(fc, "試し", "架空の軌跡図");
    expect(kml).toContain("<kml");
    expect(kml).toContain("架空の軌跡図");
    const lines = parseTrackFile("x.kml", kml);
    expect(lines.length).toBe(3); // 多角形 + 縁 2。伐採範囲の外側 2 本は読まない（余裕幅を二重に足さないため）
    const back = sweepFromLines(dense, normals, linesToPlane(lines));
    expect(Math.abs(back.left[100] - sweep.left[100])).toBeLessThan(0.5);
    // GeoJSON でも同じく伐採範囲の外側は読まない
    expect(parseTrackFile("x.geojson", JSON.stringify(fc)).length).toBe(3);
  });

  it("マイマップ風の KML（Placemark に LineString）も読める", () => {
    const kml = `<?xml version="1.0"?><kml><Document><Placemark><name>外側線</name><LineString><tessellate>1</tessellate>
      <coordinates>
        137.9,36.6,0 137.901,36.6,0
        137.902,36.601,0
      </coordinates></LineString></Placemark>
      <Placemark><Point><coordinates>137.9,36.6,0</coordinates></Point></Placemark></Document></kml>`;
    const lines = parseTrackFile("a.kml", kml);
    expect(lines).toEqual([[[137.9, 36.6], [137.901, 36.6], [137.902, 36.601]]]);
  });

  it("軌跡図が途中までしかなければ、先は NaN（切らない）。片側だけなら、もう片側は 0", () => {
    // 0〜100m の左の縁だけ、中心線から 6m の所に線を引く
    const line: EN[] = [];
    for (let i = 0; i <= 100; i += 10) line.push([dense[i][0] + normals[i][0] * 6, dense[i][1] + normals[i][1] * 6]);
    const sw = sweepFromLines(dense, normals, [line]);
    expect(sw.left[50]).toBeCloseTo(6, 1);
    expect(sw.right[50]).toBe(0);
    expect(Number.isNaN(sw.left[200])).toBe(true);
  });

  it("KMZ は解凍して中の KML を読む。KML が入っていなければ、知らない形式と同じく分かる言葉で断る", () => {
    const kml = `<kml><Document><Placemark><LineString><coordinates>137.9,36.6,0 137.901,36.6,0</coordinates></LineString></Placemark></Document></kml>`;
    const kmz = zipSync({ "doc.kml": strToU8(kml), "images/a.png": new Uint8Array([1, 2, 3]) });
    expect(parseTrackBytes("a.kmz", kmz)).toEqual([[[137.9, 36.6], [137.901, 36.6]]]);
    expect(parseTrackBytes("b.kml", strToU8(kml))).toEqual([[[137.9, 36.6], [137.901, 36.6]]]);
    expect(() => parseTrackBytes("c.kmz", zipSync({ "a.txt": strToU8("x") }))).toThrow(/KML がありません/);
    expect(() => parseTrackFile("a.txt", "hello")).toThrow(/KML でも GeoJSON でも/);
  });
});
