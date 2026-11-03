/**
 * 「現地で確かめる所」（spec §8.1・§8.4）。2 つの出どころを 1 つの並びにする。
 * - 低：Claude の確信が「低」の区切り（理由は Claude の言葉）
 * - 森林：森林の区域と判定が食い違う区切り（forest.ts の forestMismatch）
 * - 変化：別の年の写真と比べて変化があった区切り（F11。もう切られている、造成された、など）
 * 画面の一覧・一覧表の列・持って歩く地図の表が同じ並びになるよう、ここで作る
 */
import type { Segment } from "./geom";
import type { Judgment } from "./types";

export interface Check {
  segmentId: string;
  kind: "低" | "森林" | "変化";
  why: string;
  tree: number;
}

export function listChecks(segments: Segment[], judgments: Map<string, Judgment>, forestFlags: Map<string, string> | null): Check[] {
  const out: Check[] = [];
  for (const s of segments) {
    const j = judgments.get(s.id);
    if (!j) continue;
    if (j.conf === "低") out.push({ segmentId: s.id, kind: "低", why: j.why, tree: j.tree });
    const f = forestFlags?.get(s.id);
    if (f) out.push({ segmentId: s.id, kind: "森林", why: f, tree: j.tree });
    if (j.change && j.change !== "変化なし") out.push({ segmentId: s.id, kind: "変化", why: `${j.oldYear ?? "前"} 年度の写真と比べて「${j.change}」（当時 ${j.treeOld ?? "?"}% → 今 ${j.tree}%）`, tree: j.tree });
  }
  return out;
}

/** 1 区切りに 2 つの理由があるとき、1 行にまとめた言葉 */
export function checkText(checks: Check[]): string {
  return checks.map((c) => (c.kind === "低" ? `${c.segmentId}：${c.why}` : `${c.segmentId}（${c.kind}）：${c.why}`)).join(" ／ ");
}

/** 種類の説明（KML の吹き出し・画面の札） */
export function checkKindText(kind: Check["kind"]): string {
  return kind === "森林" ? "森林の区域と判定が食い違う" : kind === "変化" ? "別の年の写真と比べて変化があった" : "Claude の確信が低い";
}
