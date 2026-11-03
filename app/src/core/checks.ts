/**
 * 「現地で確かめる所」（spec §8.1・§8.4）。出どころを 1 つの並びにする。
 * - 低：Claude の確信が「低」の区切り（理由は Claude の言葉）
 * - 森林：森林の区域と判定が食い違う区切り（forest.ts の forestMismatch）
 * - 変化：別の年の写真と比べて変化があった区切り（F11。もう切られている、造成された、など）
 * - 未判定：Claude の答えに番号が無かった区切り（再送はしない。spec §8.4。tree は null）
 * 画面の一覧・一覧表の列・持って歩く地図の表が同じ並びになるよう、ここで作る
 */
import type { Segment } from "./geom";
import { isRealChange, type Judgment } from "./types";

export interface Check {
  segmentId: string;
  kind: "低" | "森林" | "変化" | "未判定";
  why: string;
  /** 木の割合。未判定なら null */
  tree: number | null;
}

/** 木の割合の表示。未判定は「—」 */
export function treeText(tree: number | null): string {
  return tree === null ? "—" : `${tree}%`;
}

export function listChecks(segments: Segment[], judgments: Map<string, Judgment>, forestFlags: Map<string, string> | null, unjudged: ReadonlySet<string> | null = null): Check[] {
  const out: Check[] = [];
  for (const s of segments) {
    const j = judgments.get(s.id);
    if (!j) {
      if (unjudged?.has(s.id)) out.push({ segmentId: s.id, kind: "未判定", why: "Claude の答えにこの番号がなかった（判定なし）", tree: null });
      continue;
    }
    if (j.conf === "低") out.push({ segmentId: s.id, kind: "低", why: j.why, tree: j.tree });
    const f = forestFlags?.get(s.id);
    if (f) out.push({ segmentId: s.id, kind: "森林", why: f, tree: j.tree });
    if (isRealChange(j.change)) out.push({ segmentId: s.id, kind: "変化", why: `${j.oldYear ?? "前"} 年度の写真と比べて「${j.change}」（当時 ${j.treeOld ?? "?"}% → 今 ${j.tree}%）`, tree: j.tree });
  }
  return out;
}

/** 1 区切りに 2 つの理由があるとき、1 行にまとめた言葉 */
export function checkText(checks: Check[]): string {
  return checks.map((c) => (c.kind === "低" ? `${c.segmentId}：${c.why}` : `${c.segmentId}（${c.kind}）：${c.why}`)).join(" ／ ");
}

/** 種類の説明（KML の吹き出し・画面の札） */
export function checkKindText(kind: Check["kind"]): string {
  return kind === "森林" ? "森林の区域と判定が食い違う" : kind === "変化" ? "別の年の写真と比べて変化があった" : kind === "未判定" ? "判定なし（答えに番号がなかった）" : "Claude の確信が低い";
}
