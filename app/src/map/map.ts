/**
 * 地図（MapLibre GL JS）。層の順は下から：航空写真 → 森林の区域 → 筆 → 区切り → 中心線。
 * 出典は地図の右下に出す（地理院・法務省・林野庁・OpenStreetMap）。
 */
import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// MapLibre 6 は自分のファイルの隣から Worker を読もうとするが、Vite が束ねると隣にない。
// scripts/copy-worker.mjs が public/vendor/ に写したものを、手を入れない形で読む
maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}vendor/maplibre-gl-worker.mjs`);
import type { FeatureCollection, LineString, Point, Polygon, Position } from "geojson";
import type { FeatureCollection as FC, MultiPolygon } from "geojson";
import { LATEST, photoTileTemplate, type PhotoLayer } from "../core/photo";
import { NOT_LAND, type Judgment, type ParcelKind } from "../core/types";

export const KIND_COLORS: Record<ParcelKind, string> = {
  ふつう: "#f2e7c9",
  道: "#9aa5b1",
  水: "#7fb3e6",
  無地番: "#cfcfcf",
  地区外: "#e38bd6",
  別図: "#f4b56a",
  筆界未定地: "#e0908f",
};

export const LAYER_IDS = {
  photo: ["photo", "photo-year"],
  forest: ["forest-fill", "forest-line"],
  parcels: ["parcels-fill", "parcels-selected", "parcels-line", "parcels-label"],
  /** かかる部分の黄色の塗り。公図の線は見たいが塗りは要らない（写真を見たい）ときに、別に消せるようにする */
  hits: ["hit-areas"],
  segments: ["segments-fill", "segments-line", "segments-label"],
  track: ["track-fill", "track-line", "track-cut", "track-tilt", "track-tilt-label"],
  section: ["section-line", "section-ends"],
  kps: ["kps-point", "kps-label"],
} as const;

export type LayerGroup = keyof typeof LAYER_IDS;

/** 公図の出典は案件ごとに変わる（市町村・データセット）。見本は小川村 */
export const DEMO_MOJ = { text: "登記所備付地図データ 上水内郡小川村（法務省）", url: "https://www.geospatial.jp/ckan/dataset/houmusyouchizu-2026-1-995" };

function attributionHtml(moj: { text: string; url: string | null }): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const mojHtml = moj.url ? `<a href="${esc(moj.url)}" target="_blank">${esc(moj.text)}</a>` : esc(moj.text);
  return (
    '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院（地理院タイル 全国最新写真・年度別写真）</a>を加工（2023 年度の一部は Landsat-8 と GRUS画像（© Axelspace）） ｜ ' +
    `${mojHtml}を加工 ｜ ` +
    '<a href="https://www.geospatial.jp/ckan/dataset/layer" target="_blank">森林計画対象森林レイヤ（林野庁）</a> ｜ ' +
    '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>'
  );
}

let attribution: maplibregl.AttributionControl | null = null;

/** 出典の表記を付け替える（公図の市町村が変わったとき）。MapLibre の AttributionControl は作り直すしかない */
export function setAttribution(map: MlMap, moj: { text: string; url: string | null }) {
  if (attribution) map.removeControl(attribution);
  attribution = new maplibregl.AttributionControl({ compact: true, customAttribution: attributionHtml(moj) });
  map.addControl(attribution, "bottom-right");
}

export function createMap(container: HTMLElement, center: [number, number]): MlMap {
  const map = new maplibregl.Map({
    container,
    center,
    zoom: 16,
    maxZoom: 21,
    attributionControl: false,
    style: {
      version: 8,
      // 日本語の字（地番の「道-」や起点・終点）が要るので、国土地理院の Noto Sans CJK JP の字形を使う
      glyphs: "https://maps.gsi.go.jp/xyz/noto-jp/{fontstack}/{range}.pbf",
      sources: {
        photo: {
          type: "raster",
          tiles: [photoTileTemplate(LATEST)],
          tileSize: 256,
          minzoom: 2,
          maxzoom: 18,
        },
        // 年度別写真。全国最新写真の上に重ね、年を選んだときだけ見せる。無い所（タイルが 404）は下の最新写真が透けて見える。
        // 2023 年度の一部は Landsat-8（NASA/USGS）と GRUS の画像で、地理院が「GRUS画像（© Axelspace）」の表記を求めている（出典の文に入れてある）
        "photo-year": {
          type: "raster",
          tiles: [photoTileTemplate("2022")],
          tileSize: 256,
          minzoom: 14,
          maxzoom: 18,
        },
        forest: {
          type: "vector",
          tiles: ["https://rinya-tiles.geospatial.jp/fr_layer_pbf_2025/{z}/{x}/{y}.pbf"],
          minzoom: 12,
          maxzoom: 16,
        },
      },
      layers: [
        { id: "photo", type: "raster", source: "photo" },
        { id: "photo-year", type: "raster", source: "photo-year", layout: { visibility: "none" } },
        {
          id: "forest-fill",
          type: "fill",
          source: "forest",
          "source-layer": "森林計画対象森林レイヤ",
          paint: {
            "fill-color": ["case", ["==", ["get", "民国別"], "国有林"], "#1b5e20", "#43a047"],
            "fill-opacity": 0.18,
          },
        },
        {
          id: "forest-line",
          type: "line",
          source: "forest",
          "source-layer": "森林計画対象森林レイヤ",
          paint: { "line-color": "#2e7d32", "line-width": 1.2, "line-dasharray": [2, 2] },
        },
      ],
    },
  })
    .addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right")
    .addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right")
    // 現在地。現地で iPad を持って歩くとき、いまどの区切りの前にいるかを見るため（位置の情報は端末の中だけ）
    .addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true }), "top-right");
  setAttribution(map, DEMO_MOJ);
  return map;
}

/** 写真の年を切り替える。null なら全国最新写真だけ */
export function setPhotoYear(map: MlMap, year: PhotoLayer | null, photoVisible = true) {
  const src = map.getSource("photo-year") as maplibregl.RasterTileSource | undefined;
  if (!src) return;
  if (year && year !== LATEST) src.setTiles([photoTileTemplate(year)]);
  map.setLayoutProperty("photo-year", "visibility", year && year !== LATEST && photoVisible ? "visible" : "none");
}

/** 木の割合を色にする。未判定は灰色。確信「低」は模様で区別するのではなく、縁を点線にして詳細で示す */
export function treeColorExpression(): ExpressionSpecification {
  return [
    "case",
    ["!", ["has", "tree"]], "rgba(200,200,200,0.35)",
    ["==", ["get", "tree"], 0], "rgba(255,255,255,0.25)",
    ["==", ["get", "tree"], 25], "rgba(255,235,59,0.5)",
    ["==", ["get", "tree"], 50], "rgba(255,152,0,0.55)",
    ["==", ["get", "tree"], 75], "rgba(244,81,30,0.6)",
    "rgba(183,28,28,0.65)",
  ];
}

function sectionGeo(coords: Position[]): { line: FeatureCollection<LineString>; ends: FeatureCollection<Point> } {
  return {
    line: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] },
    ends: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { label: "起点 0m" }, geometry: { type: "Point", coordinates: coords[0] } },
        { type: "Feature", properties: { label: "終点" }, geometry: { type: "Point", coordinates: coords[coords.length - 1] } },
      ],
    },
  };
}

/** 中心線を差し替える（案件を切り替えた・中心線を決め直したとき） */
export function setSection(map: MlMap, coords: Position[]) {
  const g = sectionGeo(coords);
  setSourceData(map, "section", g.line);
  setSourceData(map, "section-ends", g.ends);
}

export function addSection(map: MlMap, coords: Position[]) {
  const g = sectionGeo(coords);
  map.addSource("section", { type: "geojson", data: g.line });
  map.addLayer({ id: "section-line", type: "line", source: "section", paint: { "line-color": "#ff3b30", "line-width": 2.5 } });
  map.addSource("section-ends", { type: "geojson", data: g.ends });
  map.addLayer({
    id: "section-ends",
    type: "symbol",
    source: "section-ends",
    layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, -1.2], "text-font": ["NotoSansCJKjp-Bold"] },
    paint: { "text-color": "#fff", "text-halo-color": "#c62828", "text-halo-width": 2 },
  });
}

export function addParcels(map: MlMap, parcels: FeatureCollection<Polygon>, hitAreas: FC<MultiPolygon>) {
  map.addSource("parcels", { type: "geojson", data: parcels, promoteId: "id" });
  map.addSource("hit-areas", { type: "geojson", data: hitAreas, promoteId: "id" });
  // match の引数は「値, 色, 値, 色, …, 既定の色」。型が厳しいので組み立ててから付ける
  const kindColor = ["match", ["get", "kind"], ...Object.entries(KIND_COLORS).flat(), "#f2e7c9"] as unknown as ExpressionSpecification;
  // 地区外・別図は土地ではなく「隣の地図を見よ」の印。塗らず、灰色の点線だけにする（types.ts の NOT_LAND）
  const notLand: ExpressionSpecification = ["in", ["get", "kind"], ["literal", [...NOT_LAND]]];
  const selected: ExpressionSpecification = ["boolean", ["feature-state", "selected"], false];
  const hit: ExpressionSpecification = ["boolean", ["feature-state", "hit"], false];
  // かからない筆は控えめに。暗い森の写真の上で線が目立ちすぎ、かかる筆（黄色）と見分けにくくなるため
  map.addLayer({
    id: "parcels-fill",
    type: "fill",
    source: "parcels",
    // zoom は最上位の interpolate でしか使えないので、段階ごとの値の中で case を使う
    paint: { "fill-color": kindColor, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 15, ["case", notLand, 0, 0.03], 18, ["case", notLand, 0, 0.12]] },
  });
  // かかる部分（区切りと重なる形）だけを濃い黄色に。筆を丸ごと塗ると、山林の大きな筆が端だけかかっても全体が黄色になり、
  // 「ここも切るのか」と読めてしまうため
  map.addLayer({ id: "hit-areas", type: "fill", source: "hit-areas", paint: { "fill-color": "#ffeb3b", "fill-opacity": 0.55 } });
  // 選んだ筆は塗りも変える。枠だけだと、黄色の筆が並ぶ所やパネルの陰で分からない
  map.addLayer({
    id: "parcels-selected",
    type: "fill",
    source: "parcels",
    paint: { "fill-color": "#ff3b30", "fill-opacity": ["case", selected, 0.28, 0] },
  });
  map.addLayer({
    id: "parcels-line",
    type: "line",
    source: "parcels",
    paint: {
      // かからない筆の線は白く細く、引いて見るほど薄くする。小さな筆が並ぶ所で線が面のように見え、かかる筆の黄色が埋もれるため
      "line-color": ["case", selected, "#ff3b30", hit, "#ffd600", notLand, "#9e9e9e", "#ffffff"],
      "line-width": ["case", selected, 3, hit, 1.8, 0.6],
      "line-dasharray": ["case", notLand, ["literal", [3, 3]], ["literal", [1, 0]]],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 15, ["case", selected, 1, hit, 1, 0.08], 17, ["case", selected, 1, hit, 1, 0.35], 19, ["case", selected, 1, hit, 1, 0.6]],
    },
  });
  map.addLayer({
    id: "parcels-label",
    type: "symbol",
    source: "parcels",
    minzoom: 17,
    filter: ["!", notLand],
    layout: { "text-field": ["get", "chiban"], "text-size": 11, "text-font": ["NotoSansCJKjp-Regular"], "text-allow-overlap": false },
    paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,0.7)", "text-halo-width": 1.2 },
  });
}

export function addSegments(map: MlMap, segments: FeatureCollection<Polygon>) {
  map.addSource("segments", { type: "geojson", data: segments, promoteId: "id" });
  map.addLayer({ id: "segments-fill", type: "fill", source: "segments", paint: { "fill-color": treeColorExpression() } });
  map.addLayer({
    id: "segments-line",
    type: "line",
    source: "segments",
    paint: {
      // 人が直した区切りは青い太枠。誰が決めたかを地図でも見分けるため（spec F10）
      "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#ff3b30", ["==", ["get", "by"], "人"], "#1565c0", ["==", ["get", "side"], "L"], "#ffe600", "#00dcff"],
      "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, ["==", ["get", "by"], "人"], 2.5, 1],
      "line-dasharray": ["case", ["==", ["get", "check"], true], ["literal", [2, 2]], ["literal", [1, 0]]],
    },
  });
  map.addLayer({
    id: "segments-label",
    type: "symbol",
    source: "segments",
    minzoom: 18,
    layout: { "text-field": ["get", "id"], "text-size": 10, "text-font": ["NotoSansCJKjp-Bold"] },
    paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,0.8)", "text-halo-width": 1.5 },
  });
}

/**
 * 軌跡（掃く範囲と伐採範囲の外側）。掃く範囲は薄い紫の面と紫の縁、伐採範囲の外側は橙の点線。
 * 中心線（赤）と見分けるため赤は使わない。区切りの上に重ねるが、面は薄くして区切りの色（木の割合）が読めるようにする
 */
export function addTrack(map: MlMap, track: FC<Polygon | LineString>) {
  map.addSource("track", { type: "geojson", data: track });
  map.addLayer({
    id: "track-fill",
    type: "fill",
    source: "track",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": "#7b1fa2", "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: "track-line",
    type: "line",
    source: "track",
    filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "kind"], "sweep"]],
    paint: { "line-color": "#7b1fa2", "line-width": 1.5, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "track-cut",
    type: "line",
    source: "track",
    filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "kind"], "cut"]],
    paint: { "line-color": "#ff9800", "line-width": 1.5, "line-dasharray": [3, 2] },
  });
  // 起立の区間：中心線に沿った青い太線と角度の札
  map.addLayer({
    id: "track-tilt",
    type: "line",
    source: "track",
    filter: ["==", ["get", "kind"], "tilt"],
    paint: { "line-color": "#1565c0", "line-width": 6, "line-opacity": 0.6 },
  });
  map.addLayer({
    id: "track-tilt-label",
    type: "symbol",
    source: "track",
    filter: ["==", ["get", "kind"], "tilt"],
    layout: { "symbol-placement": "line-center", "text-field": ["get", "label"], "text-size": 12, "text-font": ["NotoSansCJKjp-Bold"], "text-offset": [0, -1.2] },
    paint: { "text-color": "#1565c0", "text-halo-color": "#fff", "text-halo-width": 2 },
  });
}

/** GeoJSON の源の中身を差し替える。まだ地図ができていなければ何もしない（読み込みの前に呼ばれることがある） */
export function setSourceData(map: MlMap, id: string, data: FC) {
  (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data);
}

/** 判定を区切りの属性に書き込む（色と点線に使う） */
export function applyJudgments(segments: FeatureCollection<Polygon>, judgments: Map<string, Judgment>, flags: Map<string, string> | null = null): FeatureCollection<Polygon> {
  return {
    ...segments,
    features: segments.features.map((f) => {
      const id = f.properties!.id as string;
      const j = judgments.get(id);
      // check：確かめる所（確信が低い、または森林の区域と食い違う）。地図では点線
      return j ? { ...f, properties: { ...f.properties, tree: j.tree, conf: j.conf, by: j.by, check: j.conf === "低" || !!flags?.get(id) } } : f;
    }),
  };
}

/** 距離標（人が置いたもの）。白地に赤い縁の丸と「KP 12.0」の札 */
export function addKps(map: MlMap, kps: FeatureCollection<Point>) {
  map.addSource("kps", { type: "geojson", data: kps });
  map.addLayer({
    id: "kps-point",
    type: "circle",
    source: "kps",
    paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-color": "#c62828", "circle-stroke-width": 3 },
  });
  map.addLayer({
    id: "kps-label",
    type: "symbol",
    source: "kps",
    layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, -1.4], "text-font": ["NotoSansCJKjp-Bold"], "text-allow-overlap": true },
    paint: { "text-color": "#c62828", "text-halo-color": "#fff", "text-halo-width": 2 },
  });
}

/**
 * 下書き（手で描いている中心線、OSM でたどった道の候補、起点・終点の印）。中心線（赤）と見分けるため青緑にする。
 * 決めたら中心線（section）に移し、ここは空にする
 */
export function addDraft(map: MlMap) {
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
  map.addSource("draft", { type: "geojson", data: empty });
  map.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#00bfa5", "line-width": 4, "line-dasharray": [2, 1] } });
  map.addLayer({ id: "draft-point", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 6, "circle-color": "#00bfa5", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({
    id: "draft-label",
    type: "symbol",
    source: "draft",
    filter: ["==", ["geometry-type"], "Point"],
    layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, -1.3], "text-font": ["NotoSansCJKjp-Bold"], "text-allow-overlap": true },
    paint: { "text-color": "#00695c", "text-halo-color": "#fff", "text-halo-width": 2 },
  });
}

export function setDraft(map: MlMap, line: Position[] | null, points: { coords: Position; label: string }[]) {
  const features: FeatureCollection["features"] = points.map((p) => ({ type: "Feature", properties: { label: p.label }, geometry: { type: "Point", coordinates: p.coords } }));
  if (line && line.length >= 2) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
  setSourceData(map, "draft", { type: "FeatureCollection", features });
}

export function setGroupVisible(map: MlMap, group: LayerGroup, visible: boolean) {
  const ids = typeof LAYER_IDS[group] === "string" ? [LAYER_IDS[group] as string] : (LAYER_IDS[group] as readonly string[]);
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}
