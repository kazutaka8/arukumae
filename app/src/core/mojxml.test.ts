import { existsSync, readFileSync } from "node:fs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { resample } from "./geom";
import { cutParcels, kindOf, MojxmlParser, parseMojxml, stemOf } from "./mojxml";
import { readMojBytes } from "./mojzip";
import type { EN } from "./proj";

/**
 * 実データと同じ形の小さな地図XML を組み立てる。X が北・Y が東。
 * 筆 1：点の参照だけ。筆 2：座標を直接書いた線と、向きが逆の線が混じる。筆 3：穴あり。筆 4：道。筆 5：形のない筆
 */
function sampleXml(crs = "公共座標8系"): string {
  const pt = (id: string, n: number, e: number) =>
    `<zmn:GM_Point id="${id}"><zmn:GM_Point.position><zmn:DirectPosition><zmn:X>${n}</zmn:X><zmn:Y>${e}</zmn:Y></zmn:DirectPosition></zmn:GM_Point.position></zmn:GM_Point>`;
  const ref = (p: string) => `<zmn:GM_PointArray.column><zmn:GM_Position.indirect><zmn:GM_PointRef.point idref="${p}"/></zmn:GM_Position.indirect></zmn:GM_PointArray.column>`;
  const direct = (n: number, e: number) => `<zmn:GM_PointArray.column><zmn:GM_Position.direct><zmn:X>${n}</zmn:X><zmn:Y>${e}</zmn:Y></zmn:GM_Position.direct></zmn:GM_PointArray.column>`;
  const curve = (id: string, cols: string) =>
    `<zmn:GM_Curve id="${id}"><zmn:GM_OrientablePrimitive.orientation>+</zmn:GM_OrientablePrimitive.orientation><zmn:GM_OrientablePrimitive.primitive idref="${id}"/><zmn:GM_Curve.segment><zmn:GM_LineString><zmn:GM_LineString.controlPoint>${cols}</zmn:GM_LineString.controlPoint></zmn:GM_LineString></zmn:GM_Curve.segment></zmn:GM_Curve>`;
  const gens = (ids: string[]) => ids.map((c) => `<zmn:GM_CompositeCurve.generator idref="${c}"/>`).join("");
  const surf = (id: string, ext: string[], holes: string[][] = []) =>
    `<zmn:GM_Surface id="${id}"><zmn:GM_Surface.patch><zmn:GM_Polygon><zmn:GM_Polygon.boundary><zmn:GM_SurfaceBoundary><zmn:GM_SurfaceBoundary.exterior><zmn:GM_Ring>${gens(ext)}</zmn:GM_Ring></zmn:GM_SurfaceBoundary.exterior>${holes
      .map((h) => `<zmn:GM_SurfaceBoundary.interior><zmn:GM_Ring>${gens(h)}</zmn:GM_Ring></zmn:GM_SurfaceBoundary.interior>`)
      .join("")}</zmn:GM_SurfaceBoundary></zmn:GM_Polygon.boundary></zmn:GM_Polygon></zmn:GM_Surface.patch></zmn:GM_Surface>`;
  const fude = (id: string, chiban: string, shape: string | null, oaza = "大字稲丘") =>
    `<筆 id="${id}"><大字コード>001</大字コード><大字名>${oaza}</大字名><地番>${chiban}</地番>${shape ? `<形状 idref="${shape}"/>` : ""}<精度区分>乙一</精度区分><座標値種別>図上測量</座標値種別></筆>`;
  // 筆 1：原点の近くの 10m 四方（起点は N=71600, E=-45400 のあたり）
  const N = 71600;
  const E = -45400;
  return `<?xml version="1.0" encoding="UTF-8"?>
<地図 xmlns="http://www.moj.go.jp/MINJI/tizuxml" xmlns:zmn="http://www.moj.go.jp/MINJI/tizuzumen">
	<version>ver1.0</version>
	<地図名>試しの地図</地図名>
	<市区町村コード>20588</市区町村コード>
	<市区町村名>上水内郡小川村</市区町村名>
	<座標系>${crs}</座標系>
	<空間属性>
		${pt("P1", N + 10, E + 10)}${pt("P2", N + 10, E + 20)}${pt("P3", N + 20, E + 20)}${pt("P4", N + 20, E + 10)}
		${curve("C1", ref("P1") + ref("P2"))}${curve("C2", ref("P2") + ref("P3"))}${curve("C3", ref("P3") + ref("P4"))}${curve("C4", ref("P4") + ref("P1"))}
		${surf("F1", ["C1", "C2", "C3", "C4"])}
		${curve("C5", direct(N + 30, E) + direct(N + 30, E + 10))}${curve("C6", direct(N + 40, E + 10) + direct(N + 30, E + 10))}${curve("C7", direct(N + 40, E + 10) + direct(N + 40, E) + direct(N + 30, E))}
		${surf("F2", ["C5", "C6", "C7"])}
		${curve("C8", direct(N + 100, E + 100) + direct(N + 100, E + 200) + direct(N + 200, E + 200) + direct(N + 200, E + 100) + direct(N + 100, E + 100))}
		${curve("C9", direct(N + 140, E + 140) + direct(N + 140, E + 160) + direct(N + 160, E + 160) + direct(N + 160, E + 140) + direct(N + 140, E + 140))}
		${surf("F3", ["C8"], [["C9"]])}
		${curve("C10", direct(N + 5000, E + 5000) + direct(N + 5000, E + 5010) + direct(N + 5010, E + 5010) + direct(N + 5000, E + 5000))}
		${surf("F4", ["C10"])}
	</空間属性>
	<主題属性>
		${fude("H1", "4202", "F1")}
		${fude("H2", "4203-1", "F2")}
		${fude("H3", "道-1", "F3")}
		${fude("H4", "別図-2", "F4")}
		${fude("H5", "4204", null)}
	</主題属性>
</地図>
`;
}

describe("地図XML を読む", () => {
  it("点の参照・直接の座標・向きが逆の線・穴を読み、座標を [東, 北] にする", () => {
    const m = parseMojxml(sampleXml(), "20588-1000-99.xml");
    expect(m.stem).toBe("20588-1000-99");
    expect(m.name).toBe("試しの地図");
    expect(m.crs).toBe("公共座標8系");
    expect(m.isPublic).toBe(true);
    expect(m.parcels.length).toBe(4);
    expect(m.noShape).toBe(1);
    const [h1, h2, h3, h4] = m.parcels;
    expect(h1.chiban).toBe("4202");
    expect(h1.kind).toBe("ふつう");
    expect(h1.rings[0]).toEqual([[-45390, 71610], [-45380, 71610], [-45380, 71620], [-45390, 71620], [-45390, 71610]]);
    // C6 は向きが逆（終点が前の線の終点）。裏返してつなぐ
    expect(h2.rings[0]).toEqual([[-45400, 71630], [-45390, 71630], [-45390, 71640], [-45400, 71640], [-45400, 71630]]);
    expect(h3.kind).toBe("道");
    expect(h3.rings.length).toBe(2);
    expect(h3.rings[1].length).toBe(5);
    expect(h4.kind).toBe("別図");
    expect(h1.accuracy).toBe("乙一");
    expect(h1.survey).toBe("図上測量");
  });

  it("文字列を細切れに渡しても同じ結果", () => {
    const text = sampleXml();
    const whole = parseMojxml(text, "a.xml");
    for (const size of [1, 7, 64, 1000]) {
      const p = new MojxmlParser("a.xml");
      for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
      const m = p.end();
      expect(m.parcels).toEqual(whole.parcels);
      expect(m.crs).toBe(whole.crs);
    }
  });

  it("所在は 大字名＋丁目名＋小字名（あるものだけ続ける。Codex の指摘 2026-11-07）", () => {
    const text = sampleXml("公共座標8系").replace("<大字名>大字稲丘</大字名><地番>4202</地番>", "<大字名>大字稲丘</大字名><丁目名>一丁目</丁目名><小字名>字富吉</小字名><地番>4202</地番>");
    const m = parseMojxml(text, "20588-1000-6.xml");
    expect(m.parcels.find((p) => p.id === "H1")!.oaza).toBe("大字稲丘一丁目字富吉");
    expect(m.parcels.find((p) => p.id === "H2")!.oaza).toBe("大字稲丘"); // 丁目名・小字名の無い筆は大字名だけ
  });

  it("任意座標系の地図は読めるが isPublic が false で、切り出しは空", () => {
    const m = parseMojxml(sampleXml("任意座標系"), "20588-1000-1.xml");
    expect(m.isPublic).toBe(false);
    expect(m.parcels.length).toBe(4);
    const dense = resample([[-45400, 71600], [-45400, 71700]] as EN[], 1);
    expect(cutParcels(m, dense).length).toBe(0);
  });

  it("区間の周りの筆だけを切り出し、id は「ファイル名:筆の id」。別図も切り出すが遠い筆は落とす", () => {
    const m = parseMojxml(sampleXml(), "20588-1000-99.xml");
    const dense = resample([[-45400, 71600], [-45400, 71700]] as EN[], 1);
    const feats = cutParcels(m, dense, 200);
    expect(feats.map((f) => f.properties.id)).toEqual(["20588-1000-99:H1", "20588-1000-99:H2", "20588-1000-99:H3"]);
    expect(feats[0].properties.map).toBe("20588-1000-99");
    expect(feats[2].properties.kind).toBe("道");
    expect(feats[2].geometry.coordinates.length).toBe(2);
    // 緯度経度になっている（小川村のあたり）
    const [lon, lat] = feats[0].geometry.coordinates[0][0];
    expect(lon).toBeGreaterThan(137.9);
    expect(lon).toBeLessThan(138.1);
    expect(lat).toBeGreaterThan(36.6);
    expect(lat).toBeLessThan(36.7);
    // 幅を狭めると、100m 先の道の筆は落ちる
    expect(cutParcels(m, dense, 50).map((f) => f.properties.chiban)).toEqual(["4202", "4203-1"]);
  });

  it("中心線を包む大きな筆は、外周が 200m より遠くても残す（Codex の指摘 2026-11-03）", () => {
    const N = 71600;
    const E = -45400;
    // 区間（N 71600〜71700）を丸ごと包む 1km 四方の筆。外周はどこも中心線から 400m 以上
    const big = sampleXml().replace(
      "</主題属性>",
      `<筆 id="H9"><大字名>大字稲丘</大字名><地番>9999</地番><形状 idref="F9"/></筆></主題属性>`,
    ).replace(
      "</空間属性>",
      `<zmn:GM_Curve id="C90"><zmn:GM_Curve.segment><zmn:GM_LineString><zmn:GM_LineString.controlPoint>` +
        [[N - 450, E - 500], [N - 450, E + 500], [N + 550, E + 500], [N + 550, E - 500], [N - 450, E - 500]]
          .map(([n, e]) => `<zmn:GM_PointArray.column><zmn:GM_Position.direct><zmn:X>${n}</zmn:X><zmn:Y>${e}</zmn:Y></zmn:GM_Position.direct></zmn:GM_PointArray.column>`)
          .join("") +
        `</zmn:GM_LineString.controlPoint></zmn:GM_LineString></zmn:GM_Curve.segment></zmn:GM_Curve>` +
        `<zmn:GM_Surface id="F9"><zmn:GM_Surface.patch><zmn:GM_Polygon><zmn:GM_Polygon.boundary><zmn:GM_SurfaceBoundary><zmn:GM_SurfaceBoundary.exterior><zmn:GM_Ring><zmn:GM_CompositeCurve.generator idref="C90"/></zmn:GM_Ring></zmn:GM_SurfaceBoundary.exterior></zmn:GM_SurfaceBoundary></zmn:GM_Polygon.boundary></zmn:GM_Polygon></zmn:GM_Surface.patch></zmn:GM_Surface></空間属性>`,
    );
    const m = parseMojxml(big, "20588-1000-99.xml");
    const dense = resample([[-45400, 71600], [-45400, 71700]] as EN[], 1);
    expect(cutParcels(m, dense, 200).map((f) => f.properties.chiban)).toEqual(["4202", "4203-1", "道-1", "9999"]);
    // 包んでいない大きな筆（区間の東 1km）は落ちる
    const far = big.replace(/<zmn:Y>(-?\d+)<\/zmn:Y>/g, (_, y) => `<zmn:Y>${Number(y) + 2000}</zmn:Y>`);
    expect(cutParcels(parseMojxml(far, "20588-1000-99.xml"), dense, 200)).toEqual([]);
  });

  it("地図の系が案件の系と違えば、換算して比べる。緯度経度は地図の系で出す", async () => {
    const { toPlaneZone, toLonLatZone } = await import("./proj");
    // 第VIII系の試しの地図を、第X系の座標で書き直す（同じ場所）
    const toX = (n: number, e: number) => {
      const [e2, n2] = toPlaneZone(10, toLonLatZone(8, [e, n]));
      return [n2, e2];
    };
    const src = sampleXml("公共座標10系").replace(/<zmn:X>(-?[\d.]+)<\/zmn:X><zmn:Y>(-?[\d.]+)<\/zmn:Y>/g, (_, x, y) => {
      const [n2, e2] = toX(Number(x), Number(y));
      return `<zmn:X>${n2}</zmn:X><zmn:Y>${e2}</zmn:Y>`;
    });
    const m = parseMojxml(src, "20588-1000-99.xml");
    expect(m.zone).toBe(10);
    const dense = resample([[-45400, 71600], [-45400, 71700]] as EN[], 1); // 案件は第VIII系
    const feats = cutParcels(m, dense, 200, undefined, undefined, 8);
    expect(feats.map((f) => f.properties.chiban)).toEqual(["4202", "4203-1", "道-1"]);
    const same = cutParcels(parseMojxml(sampleXml(), "20588-1000-99.xml"), dense, 200);
    // 同じ場所なので緯度経度が 1mm 以内で合う
    const [lon, lat] = feats[0].geometry.coordinates[0][0];
    const [lon0, lat0] = same[0].geometry.coordinates[0][0];
    expect(Math.abs(lon - lon0)).toBeLessThan(2e-8);
    expect(Math.abs(lat - lat0)).toBeLessThan(2e-8);
  });

  it("地図XML でない XML（KML など）は recognized が false。zip の読み手では地図に数えない", () => {
    const m = parseMojxml("<kml><Document><Placemark/></Document></kml>", "route.kml");
    expect(m.recognized).toBe(false);
    expect(parseMojxml(sampleXml(), "a.xml").recognized).toBe(true);
    expect(readMojBytes("route.kml", strToU8("<kml><Document/></kml>"))).toEqual([]);
  });

  it("地番の頭で種類を分ける", () => {
    expect(kindOf("123-4")).toBe("ふつう");
    expect(kindOf("道-12")).toBe("道");
    expect(kindOf("無地番-3")).toBe("無地番");
    expect(kindOf("地区外-1")).toBe("地区外");
    expect(stemOf("dir/20588-1000-6.xml")).toBe("20588-1000-6");
  });
});

describe("法務省の zip を読む", () => {
  it("市町村の zip → 地図の zip → XML の入れ子を、展開せずに読む。XML 1 つ、地図の zip 1 つでも読める", () => {
    const xmlA = strToU8(sampleXml());
    const xmlB = strToU8(sampleXml("任意座標系"));
    const innerA = zipSync({ "20588-1000-6.xml": xmlA });
    const innerB = zipSync({ "20588-1000-1.xml": xmlB });
    const outer = zipSync({ "20588-1000-6.zip": [innerA, { level: 0 }], "20588-1000-1.zip": [innerB, { level: 0 }], "20588-1000-search-list.csv": strToU8("a,b\n") });
    const maps = readMojBytes("20588-1000-2026.zip", outer);
    expect(maps.map((m) => [m.stem, m.isPublic, m.parcels.length])).toEqual([
      ["20588-1000-6", true, 4],
      ["20588-1000-1", false, 4],
    ]);
    expect(readMojBytes("20588-1000-6.zip", innerA).map((m) => m.stem)).toEqual(["20588-1000-6"]);
    expect(readMojBytes("20588-1000-6.xml", xmlA).map((m) => m.stem)).toEqual(["20588-1000-6"]);
  });
});

/**
 * 実データ（data/raw。リポジトリには入れない）があるときだけ、前処理の Python（tools/cut_parcels.py）の結果と突き合わせる。
 * 小さな地図（-20・-28）で、切り出す筆の id が同じになること
 */
const RAW = new URL("../../../data/raw/", import.meta.url);
const hasRaw = existsSync(new URL("xml/20588-1000-20.xml", RAW)) && existsSync(new URL("20588-1000-2026.zip", RAW));
describe.skipIf(!hasRaw)("実データ（小川村）との突き合わせ", () => {
  const demo = JSON.parse(readFileSync(new URL("../../../data/ogawa/parcels.geojson", import.meta.url), "utf-8"));
  const section = JSON.parse(readFileSync(new URL("../../../data/ogawa/section.geojson", import.meta.url), "utf-8"));
  const idsOf = (stem: string) => demo.features.filter((f: { properties: { map: string } }) => f.properties.map === stem).map((f: { properties: { id: string } }) => f.properties.id).sort();

  it("XML を読んで切り出すと、前処理と同じ筆になる（-20・-28）", async () => {
    const { toPlane } = await import("./proj");
    const dense = resample(section.features[0].geometry.coordinates.map((c: number[]) => toPlane([c[0], c[1]])), 1);
    for (const stem of ["20588-1000-20", "20588-1000-28"]) {
      const m = parseMojxml(readFileSync(new URL(`xml/${stem}.xml`, RAW), "utf-8"), `${stem}.xml`);
      expect(m.isPublic).toBe(true);
      const ids = cutParcels(m, dense, 200).map((f) => f.properties.id).sort();
      expect(ids).toEqual(idsOf(stem));
    }
  });

  it("配られた zip の中の地図の zip を、そのまま読める", () => {
    const outer = new Uint8Array(readFileSync(new URL("20588-1000-2026.zip", RAW)));
    const inner = unzipSync(outer, { filter: (f) => f.name === "20588-1000-20.zip" })["20588-1000-20.zip"];
    const maps = readMojBytes("20588-1000-20.zip", inner);
    expect(maps.length).toBe(1);
    expect(maps[0].stem).toBe("20588-1000-20");
    expect(maps[0].city).toBe("上水内郡小川村");
    expect(maps[0].parcels.length).toBe(13);
  });
});
