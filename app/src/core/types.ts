/** 道具の中で持ち回るデータの形。保存の形（将来 IndexedDB）もこれに合わせる */

import type { MultiPolygon } from "geojson";

export type ParcelKind = "ふつう" | "道" | "水" | "無地番" | "地区外" | "別図" | "筆界未定地";

/**
 * かかる筆として数えない種類。「地区外」「別図」は土地ではなく「この地図ではここから先は描いていない（隣の地図を見よ）」という印。
 * 見本のデータで、地区外の区画25個のうち20個が、隣の地図に地番のある筆を丸ごと含んでいた（2026-11-02 に確かめた）。
 * 数えると同じ土地が二重に出て、地図も二重に塗られる。
 */
export const NOT_LAND: ReadonlySet<ParcelKind> = new Set<ParcelKind>(["地区外", "別図"]);

export interface ParcelProps {
  id: string;
  map: string;
  oaza: string | null;
  chiban: string;
  kind: ParcelKind;
}

export type Confidence = "高" | "中" | "低";
export type TreeKind = "針葉樹" | "広葉樹" | "混じる" | "分からない" | "なし";

/** 区切り1つの判定。Claude が返した候補か、人が直した値 */
export interface Judgment {
  segmentId: string;
  /** 木の割合 0・25・50・75・100 */
  tree: number;
  kind: TreeKind;
  other: string[];
  conf: Confidence;
  why: string;
  /** 誰が決めたか */
  by: "Claude" | "人";
  model?: string;
  /** 見直しのモデルが見たとき、最初の判定が何だったか（違いを見せるため） */
  before?: { tree: number; conf: Confidence; model?: string };
}

/** 軌跡・伐採範囲にかかる筆（F5） */
export interface ParcelHit {
  parcelId: string;
  /** 伐採範囲と重なる面積（m²） */
  areaM2: number;
  /** 筆がかかる起点からの距離の範囲（m） */
  fromM: number;
  toM: number;
  sides: ("L" | "R")[];
  /** 重なる区切り。筆の「木（推定）」はこの区切りの判定から出す */
  segmentIds: string[];
  /** 重なる部分の形（緯度経度）。地図ではこの形だけを濃い黄色にする */
  shape: MultiPolygon;
}
