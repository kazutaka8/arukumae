/**
 * かかる筆を拾う（F5）。計算だけで決め、AI は挟まない（spec §8.1）。
 * 迷う所は「拾う」に倒す：伐採範囲（区切りの合わせたもの）にわずかでも重なれば拾う。
 */
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import type { Segment } from "./geom";
import { toLonLat, toPlane, type EN } from "./proj";
import { NOT_LAND, type ParcelHit, type ParcelProps } from "./types";

export type ParcelFeature = Feature<Polygon, ParcelProps>;

/** 区切りを緯度経度の GeoJSON にする（地図に出す用） */
export function segmentsToGeoJSON(segs: Segment[]): FeatureCollection<Polygon, { id: string; side: string; fromM: number; toM: number; areaM2: number }> {
  return {
    type: "FeatureCollection",
    features: segs.map((s) => ({
      type: "Feature",
      properties: { id: s.id, side: s.side, fromM: s.fromM, toM: s.toM, areaM2: Math.round(s.areaM2 * 10) / 10 },
      geometry: { type: "Polygon", coordinates: [s.ring.map((p) => toLonLat(p))] },
    })),
  };
}

/** かかる部分の形を地図に出す用の GeoJSON（筆ごとに1つ） */
export function hitsToGeoJSON(hits: ParcelHit[]): FeatureCollection<MultiPolygon, { id: string }> {
  return {
    type: "FeatureCollection",
    features: hits.map((h) => ({ type: "Feature", properties: { id: h.parcelId }, geometry: h.shape })),
  };
}

/** 伐採範囲＝区切りを全部合わせた形（左右それぞれ）。面積の計算は平面の上で行うので、座標は平面のまま */
function planePolygon(ring: EN[]): Feature<Polygon> {
  return turf.polygon([ring.map(([e, n]) => [e, n])]);
}

function toPlaneFeature(f: ParcelFeature): Feature<Polygon> {
  return turf.polygon(f.geometry.coordinates.map((ring) => ring.map((c) => toPlane([c[0], c[1]]))));
}

/**
 * 筆ごとに、重なる区切りと重なる面積を出す。
 * 区切りは数百、筆は数千なので、先に外接の箱で絞ってから重なりを計算する。
 * 地区外・別図は土地ではないので最初から除く（types.ts の NOT_LAND）。
 */
export function findHits(parcels: ParcelFeature[], segs: Segment[]): ParcelHit[] {
  const segPolys = segs.map((s) => ({ s, poly: planePolygon(s.ring), bbox: turf.bbox(planePolygon(s.ring)) }));
  const hits: ParcelHit[] = [];
  for (const f of parcels) {
    if (NOT_LAND.has(f.properties.kind)) continue;
    const pf = toPlaneFeature(f);
    const [minX, minY, maxX, maxY] = turf.bbox(pf);
    let area = 0;
    let fromM = Infinity;
    let toM = -Infinity;
    const sides = new Set<"L" | "R">();
    const segmentIds: string[] = [];
    const segAreas: Record<string, number> = {};
    const pieces: Feature<Polygon | MultiPolygon>[] = [];
    for (const { s, poly, bbox } of segPolys) {
      if (bbox[2] < minX || bbox[0] > maxX || bbox[3] < minY || bbox[1] > maxY) continue;
      let inter: Feature<Polygon | MultiPolygon> | null = null;
      try {
        inter = turf.intersect(turf.featureCollection([pf, poly]));
      } catch {
        // 公図の筆には自分で交わる形がまれにある。そのときは重なるとみなして面積は区切りの半分にする（漏れより過剰）
        if (turf.booleanIntersects(pf, poly)) {
          area += s.areaM2 / 2;
          fromM = Math.min(fromM, s.fromM);
          toM = Math.max(toM, s.toM);
          sides.add(s.side);
          segmentIds.push(s.id);
          segAreas[s.id] = s.areaM2 / 2;
          pieces.push(poly);
        }
        continue;
      }
      if (!inter) continue;
      // 平面座標（m）なので、turf.area（球面）ではなく自分で測る
      const a = planeArea(inter);
      if (a < 0.01) continue;
      area += a;
      fromM = Math.min(fromM, s.fromM);
      toM = Math.max(toM, s.toM);
      sides.add(s.side);
      segmentIds.push(s.id);
      segAreas[s.id] = Math.round(a * 10) / 10;
      pieces.push(inter);
    }
    if (area > 0) {
      hits.push({
        parcelId: f.properties.id,
        areaM2: Math.round(area * 10) / 10,
        fromM,
        toM,
        sides: [...sides].sort() as ("L" | "R")[],
        segmentIds,
        segAreas,
        shape: toLonLatShape(pieces),
      });
    }
  }
  return hits.sort((a, b) => a.fromM - b.fromM);
}

/** 重なった欠片を1つの形（MultiPolygon、緯度経度）にする。隣の区切り同士の境目の線を消すため、合わせられるなら合わせる */
function toLonLatShape(pieces: Feature<Polygon | MultiPolygon>[]): MultiPolygon {
  let merged: Feature<Polygon | MultiPolygon> | null = null;
  if (pieces.length > 1) {
    try {
      merged = turf.union(turf.featureCollection(pieces));
    } catch {
      merged = null; // 合わせられない形なら欠片のまま出す。見た目に境目が残るだけで、面積や一覧には影響しない
    }
  } else {
    merged = pieces[0];
  }
  const polys: Position[][][] = [];
  const push = (f: Feature<Polygon | MultiPolygon>) => {
    if (f.geometry.type === "Polygon") polys.push(f.geometry.coordinates);
    else polys.push(...f.geometry.coordinates);
  };
  if (merged) push(merged);
  else pieces.forEach(push);
  return {
    type: "MultiPolygon",
    coordinates: polys.map((rings) => rings.map((ring) => ring.map((c) => toLonLat([c[0], c[1]])))),
  };
}

function planeArea(f: Feature<Polygon | MultiPolygon>): number {
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  let total = 0;
  for (const rings of polys) {
    rings.forEach((ring, i) => {
      let s = 0;
      for (let k = 0; k < ring.length - 1; k++) s += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
      total += (i === 0 ? 1 : -1) * Math.abs(s) / 2;
    });
  }
  return total;
}
