/**
 * 森林の区域（林野庁「森林計画対象森林レイヤ」）を読んで、かかる筆ごとに「民有林・国有林・区域外」と林班を付ける（spec §9.1）。
 *
 * - ベクトルタイル（pbf、z16）を区間の周りの分だけ直接読む。地図（MapLibre）が読むのと同じタイルで、CORS は開いている
 * - 筆の「かかる部分」（hit.shape）と区域の多角形の重なりを平面直角座標で測り、割合で決める
 * - 届出の目印：民有林の区域にかかる筆に「要るかもしれない（市町村に確かめる）」。
 *   届出が要るかどうかは地目ではなく、地域森林計画の対象の民有林かどうかで決まるとされている（自分の理解。森林法第10条の8）。
 *   道具は目印まで。要否は所管に確かめる、と表と画面に書く
 * - 区域の線は 1/5,000 相当で、境界の証明にはならない（利用規約）。筆の境界とずれるのがふつうなので、割合で「一部」も出す
 */
import { VectorTile } from "@mapbox/vector-tile";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { PbfReader } from "pbf";
import type { Segment } from "./geom";
import { planeArea } from "./parcels";
import { toPlane, type EN } from "./proj";
import type { Judgment, ParcelHit } from "./types";

const TILE_URL = (z: number, x: number, y: number) => `https://rinya-tiles.geospatial.jp/fr_layer_pbf_2025/${z}/${x}/${y}.pbf`;
const LAYER = "森林計画対象森林レイヤ";
export const FOREST_Z = 16;

export type ForestKind = "民有林" | "国有林";

export interface ForestPolygon {
  kind: ForestKind;
  /** 林班（例 "0058"）。無いこともある */
  rinpan: string;
  /** データ時点（例 "2024/9/1"） */
  asOf: string;
  geometry: Polygon | MultiPolygon;
}

/** 筆ごとの結果 */
export interface ForestInfo {
  /** かかる部分のうち、区域に入っている割合（0〜1）。民有林と国有林を合わせた値 */
  ratio: number;
  kinds: ForestKind[];
  rinpan: string[];
}

/** タイルの番号。経度・緯度の箱を z で覆う範囲 */
export function tileRange(bbox: [number, number, number, number], z = FOREST_Z): { x0: number; y0: number; x1: number; y1: number } {
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { x0: tx(bbox[0]), x1: tx(bbox[2]), y0: ty(bbox[3]), y1: ty(bbox[1]) };
}

/** 1 枚のタイル（pbf のバイト列）から区域の多角形を取り出す。テストは保存したタイルで行う */
export function decodeForestTile(buf: ArrayBuffer | Uint8Array, x: number, y: number, z: number): ForestPolygon[] {
  const tile = new VectorTile(new PbfReader(buf));
  const layer = tile.layers[LAYER];
  if (!layer) return [];
  const out: ForestPolygon[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const g = f.toGeoJSON(x, y, z).geometry;
    if (g.type !== "Polygon" && g.type !== "MultiPolygon") continue;
    const p = f.properties as Record<string, unknown>;
    out.push({
      kind: p["民国別"] === "国有林" ? "国有林" : "民有林",
      rinpan: String(p["林班"] ?? ""),
      asOf: String(p["データ時点"] ?? ""),
      geometry: g,
    });
  }
  return out;
}

/** 区間の周り（経度・緯度の箱）の区域を全部読む。タイルの境で切れた多角形は切れたまま（重なりの計算には差し支えない） */
export async function fetchForest(bbox: [number, number, number, number], z = FOREST_Z): Promise<{ polygons: ForestPolygon[]; tiles: number; failed: number }> {
  const r = tileRange(bbox, z);
  const jobs: Promise<ForestPolygon[] | null>[] = [];
  for (let x = r.x0; x <= r.x1; x++) {
    for (let y = r.y0; y <= r.y1; y++) {
      jobs.push(
        fetch(TILE_URL(z, x, y))
          .then(async (res) => (res.ok ? decodeForestTile(await res.arrayBuffer(), x, y, z) : res.status === 404 ? [] : null))
          .catch(() => null),
      );
    }
  }
  const results = await Promise.all(jobs);
  return { polygons: results.flatMap((p) => p ?? []), tiles: results.length, failed: results.filter((p) => p === null).length };
}

/**
 * 区域の多角形を平面直角座標に直して持ち、形との重なりを測る。
 * 面積は平面で測る（turf.area は球面で、ここでは平面のほうが筆の面積と同じ物差しになる）
 */
export class ForestIndex {
  private planePolys: { p: ForestPolygon; f: Feature<Polygon | MultiPolygon>; bbox: number[] }[];
  constructor(polygons: ForestPolygon[]) {
    this.planePolys = polygons.map((p) => {
      const f = toPlaneFeature(p.geometry);
      return { p, f, bbox: turf.bbox(f) };
    });
  }
  /** 平面座標の形（筆のかかる部分、区切りなど）が区域にどれだけ入るか */
  ratio(shape: Feature<Polygon | MultiPolygon>): ForestInfo {
    const [minX, minY, maxX, maxY] = turf.bbox(shape);
    const total = planeArea(shape);
    const kinds = new Set<ForestKind>();
    const rinpan = new Set<string>();
    if (total <= 0) return { ratio: 0, kinds: [], rinpan: [] };
    let inside = 0;
    for (const { p, f, bbox } of this.planePolys) {
      if (bbox[2] < minX || bbox[0] > maxX || bbox[3] < minY || bbox[1] > maxY) continue;
      let inter: Feature<Polygon | MultiPolygon> | null = null;
      try {
        inter = turf.intersect(turf.featureCollection([shape, f]));
      } catch {
        inter = turf.booleanIntersects(shape, f) ? f : null; // 自分で交わる形はまれ。重なるとみなす
      }
      if (!inter) continue;
      const a = Math.min(planeArea(inter), total);
      if (a < 0.5) continue;
      inside += a;
      kinds.add(p.kind);
      if (p.rinpan) rinpan.add(p.rinpan);
    }
    return { ratio: Math.min(1, inside / total), kinds: [...kinds].sort(), rinpan: [...rinpan].sort() };
  }
}

/** かかる筆ごとに、かかる部分と区域の重なりを測る */
export function forestOfHits(hits: ParcelHit[], polygons: ForestPolygon[] | ForestIndex): Map<string, ForestInfo> {
  const index = polygons instanceof ForestIndex ? polygons : new ForestIndex(polygons);
  const out = new Map<string, ForestInfo>();
  for (const h of hits) out.set(h.parcelId, index.ratio(toPlaneFeature(h.shape)));
  return out;
}

/** 区切りごとの重なり。wide は区切りを道と反対の側と前後に 15m 広げた形で測ったもの（区域の縁の近くかどうかを見る） */
export interface SegmentForest {
  ratio: number;
  wide: number;
}

export function forestOfSegments(segments: Segment[], index: ForestIndex, dense: EN[], normals: EN[], roadHalf: number, margin = 15): Map<string, SegmentForest> {
  const out = new Map<string, SegmentForest>();
  for (const s of segments) {
    const ring = turf.polygon([s.ring.map((p) => [p[0], p[1]])]);
    const sgn = s.side === "L" ? 1 : -1;
    const i0 = Math.max(0, s.fromM - margin);
    const i1 = Math.min(dense.length - 1, s.toM + margin);
    const inner: EN[] = [];
    const outer: EN[] = [];
    for (let i = i0; i <= i1; i++) {
      const [nx, ny] = normals[i];
      inner.push([dense[i][0] + sgn * nx * roadHalf, dense[i][1] + sgn * ny * roadHalf]);
      outer.push([dense[i][0] + sgn * nx * (s.outerMaxM + margin), dense[i][1] + sgn * ny * (s.outerMaxM + margin)]);
    }
    const wideRing = [...inner, ...outer.reverse()];
    wideRing.push(wideRing[0]);
    let wide: number;
    try {
      wide = index.ratio(turf.polygon([wideRing.map((p) => [p[0], p[1]])])).ratio;
    } catch {
      wide = index.ratio(ring).ratio; // 広げた形が自分で交わるとき（急カーブ）は区切りそのもので代える
    }
    out.set(s.id, { ratio: index.ratio(ring).ratio, wide });
  }
  return out;
}

/**
 * 森林の区域と判定の食い違い（spec §8.4）。「確かめる所」に入れる理由の言葉を返す。
 * - 区域の中（区切りも、15m 広げた形も 9 割以上が区域）なのに木が 25% 以下 → もう切られた、別の使い方、の手がかり
 * - 区域の外（どちらも 1 割以下）なのに木が 75% 以上 → 植林か、区域の線とのずれ
 * 区域の縁の近く（広げた形が混じる所）は指摘しない。区域の線は 1/5,000 相当で、縁ではずれるのがふつうだから
 */
export function forestMismatch(segments: Segment[], judgments: Map<string, Judgment>, segForest: Map<string, SegmentForest>): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of segments) {
    const j = judgments.get(s.id);
    const f = segForest.get(s.id);
    if (!j || !f) continue;
    if (f.ratio >= 0.9 && f.wide >= 0.9 && j.tree <= 25) out.set(s.id, `森林計画の対象の区域なのに、写真では木が ${j.tree}%。もう切られたか、別の使い方になっているかもしれません`);
    else if (f.ratio <= 0.1 && f.wide <= 0.1 && j.tree >= 75) out.set(s.id, `区域外なのに、写真では木が ${j.tree}%。植林か、区域の線とのずれかもしれません`);
  }
  return out;
}

function toPlaneFeature(g: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  const ring = (r: Position[]) => r.map((c) => toPlane([c[0], c[1]]) as Position);
  if (g.type === "Polygon") return turf.polygon(g.coordinates.map(ring));
  return turf.multiPolygon(g.coordinates.map((poly) => poly.map(ring)));
}

/** 一覧表の「森林の区域」の列の言葉。「民有林（林班 0058）」「一部 民有林（林班 0058）」「区域外」 */
export function forestText(info: ForestInfo | undefined): string {
  if (!info || info.ratio < 0.02) return "区域外";
  const kinds = info.kinds.join("・");
  const rin = info.rinpan.length ? `（林班 ${info.rinpan.join("・")}）` : "";
  return `${info.ratio < 0.5 ? "一部 " : ""}${kinds}${rin}`;
}

/** 「伐採の届出の目印」の列。民有林にかかるときだけ */
export function noticeText(info: ForestInfo | undefined): string {
  if (!info || info.ratio < 0.02 || !info.kinds.includes("民有林")) return "";
  return "要るかもしれない（市町村に確かめる）";
}
