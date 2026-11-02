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
import type { FeatureCollection, LineString, Polygon } from "geojson";
import type { Judgment, ParcelKind } from "../core/types";

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
  photo: "photo",
  forest: ["forest-fill", "forest-line"],
  parcels: ["parcels-fill", "parcels-line", "parcels-hit", "parcels-label"],
  segments: ["segments-fill", "segments-line", "segments-label"],
  section: ["section-line", "section-ends"],
} as const;

export type LayerGroup = keyof typeof LAYER_IDS;

const ATTRIBUTION =
  '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院（地理院タイル）</a>を加工 ｜ ' +
  '<a href="https://www.geospatial.jp/ckan/dataset/houmusyouchizu-2026-1-995" target="_blank">登記所備付地図データ 上水内郡小川村（法務省）</a>を加工 ｜ ' +
  '<a href="https://www.geospatial.jp/ckan/dataset/layer" target="_blank">森林計画対象森林レイヤ（林野庁）</a> ｜ ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>';

export function createMap(container: HTMLElement, center: [number, number]): MlMap {
  return new maplibregl.Map({
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
          tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
          tileSize: 256,
          minzoom: 2,
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
    .addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIBUTION }), "bottom-right");
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

export function addSection(map: MlMap, section: FeatureCollection<LineString>) {
  map.addSource("section", { type: "geojson", data: section });
  map.addLayer({ id: "section-line", type: "line", source: "section", paint: { "line-color": "#ff3b30", "line-width": 2.5 } });
  const coords = section.features[0].geometry.coordinates;
  map.addSource("section-ends", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { label: "起点 0m" }, geometry: { type: "Point", coordinates: coords[0] } },
        { type: "Feature", properties: { label: "終点" }, geometry: { type: "Point", coordinates: coords[coords.length - 1] } },
      ],
    },
  });
  map.addLayer({
    id: "section-ends",
    type: "symbol",
    source: "section-ends",
    layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, -1.2], "text-font": ["NotoSansCJKjp-Bold"] },
    paint: { "text-color": "#fff", "text-halo-color": "#c62828", "text-halo-width": 2 },
  });
}

export function addParcels(map: MlMap, parcels: FeatureCollection<Polygon>) {
  map.addSource("parcels", { type: "geojson", data: parcels, promoteId: "id" });
  // match の引数は「値, 色, 値, 色, …, 既定の色」。型が厳しいので組み立ててから付ける
  const kindColor = ["match", ["get", "kind"], ...Object.entries(KIND_COLORS).flat(), "#f2e7c9"] as unknown as ExpressionSpecification;
  // かからない筆は控えめに。暗い森の写真の上で線が目立ちすぎ、かかる筆（黄色）と見分けにくくなるため
  map.addLayer({ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": kindColor, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0.03, 18, 0.12] } });
  map.addLayer({
    id: "parcels-hit",
    type: "fill",
    source: "parcels",
    paint: { "fill-color": "#ffeb3b", "fill-opacity": ["case", ["boolean", ["feature-state", "hit"], false], 0.35, 0] },
  });
  map.addLayer({
    id: "parcels-line",
    type: "line",
    source: "parcels",
    paint: {
      // かからない筆の線は白く細く、引いて見るほど薄くする。小さな筆が並ぶ所で線が面のように見え、かかる筆の黄色が埋もれるため
      "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#ff3b30", ["boolean", ["feature-state", "hit"], false], "#ffd600", "#ffffff"],
      "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, ["boolean", ["feature-state", "hit"], false], 1.8, 0.6],
      "line-opacity": [
        "case",
        ["boolean", ["feature-state", "selected"], false], 1,
        ["boolean", ["feature-state", "hit"], false], 1,
        ["interpolate", ["linear"], ["zoom"], 15, 0.08, 17, 0.35, 19, 0.6],
      ],
    },
  });
  map.addLayer({
    id: "parcels-label",
    type: "symbol",
    source: "parcels",
    minzoom: 17,
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
      "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#ff3b30", ["==", ["get", "side"], "L"], "#ffe600", "#00dcff"],
      "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, 1],
      "line-dasharray": ["case", ["==", ["get", "conf"], "低"], ["literal", [2, 2]], ["literal", [1, 0]]],
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

/** 判定を区切りの属性に書き込む（色と点線に使う） */
export function applyJudgments(segments: FeatureCollection<Polygon>, judgments: Map<string, Judgment>): FeatureCollection<Polygon> {
  return {
    ...segments,
    features: segments.features.map((f) => {
      const j = judgments.get(f.properties!.id as string);
      return j ? { ...f, properties: { ...f.properties, tree: j.tree, conf: j.conf, by: j.by } } : f;
    }),
  };
}

export function setGroupVisible(map: MlMap, group: LayerGroup, visible: boolean) {
  const ids = typeof LAYER_IDS[group] === "string" ? [LAYER_IDS[group] as string] : (LAYER_IDS[group] as readonly string[]);
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}
