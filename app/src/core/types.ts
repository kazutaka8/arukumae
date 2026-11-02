/** 道具の中で持ち回るデータの形。保存の形（将来 IndexedDB）もこれに合わせる */

export type ParcelKind = "ふつう" | "道" | "水" | "無地番" | "地区外" | "別図" | "筆界未定地";

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
}
