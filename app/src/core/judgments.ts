/**
 * 判定の入れ方の決まり（F10・spec §8.4）：**人が直した値が、いつも Claude の判定より優先される。**
 * 判定の走り（main.ts の runJudging）と「直す」の欄から呼ぶ。
 * 前は main.ts の中に直に書いてあり、API と画面を通さないと確かめられなかった。壊れたら人の修正が黙って消える所なので、
 * 画面から離して回帰テストで固定する（spec §10「人が直す」。Codex の指摘 2026-11-06）。動きは切り出す前と同じ
 */
import type { Confidence, Judgment, TreeKind } from "./types";

/** Claude に判定を頼む番号。人が直した区切りは頼まない（「全部を判定し直す」でも上書きしないため） */
export function idsToJudge(ids: string[], judgments: ReadonlyMap<string, Judgment>): string[] {
  return ids.filter((id) => judgments.get(id)?.by !== "人");
}

/**
 * 主のモデルの答えを入れる。答えを待っている数十秒の間に人が直した区切りは、頼んだ番号に入っていても上書きしない。
 * 答えに無かった番号は、判定が 1 つも無ければ未判定に入れる（前の判定が残っていれば、それを消さない）
 */
export function applyMain(judgments: Map<string, Judgment>, unjudged: Set<string>, answer: { judgments: Judgment[]; missing: string[] }): void {
  for (const j of answer.judgments) {
    if (judgments.get(j.segmentId)?.by === "人") continue;
    judgments.set(j.segmentId, j);
    unjudged.delete(j.segmentId);
  }
  for (const id of answer.missing) if (!judgments.has(id)) unjudged.add(id);
}

/**
 * 見直しのモデルの答えを入れ、最初の判定を before に残す（2 つのモデルが割れた所を見せるため）。
 * 主の判定が無い区切り（答えに無かった）と、待っている間に人が直した区切りには入れない。戻り値は木の割合が変わった数
 */
export function applyReview(judgments: Map<string, Judgment>, answers: Judgment[]): number {
  let changed = 0;
  for (const j of answers) {
    const first = judgments.get(j.segmentId);
    if (!first || first.by === "人") continue;
    if (j.tree !== first.tree) changed++;
    judgments.set(j.segmentId, { ...j, before: { tree: first.tree, conf: first.conf, model: first.model } });
  }
  return changed;
}

function stripPrev(j: Judgment): Omit<Judgment, "prev"> {
  const { prev: _prev, ...rest } = j;
  return rest;
}

/**
 * 人が直した判定を作る。直す前の判定は 1 つだけ覚える（人が何度直しても、「元に戻す」の戻り先は Claude の判定）。
 * 木以外（other）は欄が無いので、前の値を引き継ぐ
 */
export function fixByHuman(old: Judgment | undefined, v: { segmentId: string; tree: number; kind: TreeKind; conf: Confidence; why: string }): Judgment {
  return {
    segmentId: v.segmentId,
    tree: v.tree,
    kind: v.kind,
    other: old?.other ?? [],
    conf: v.conf,
    why: v.why.trim() || "人が直した",
    by: "人",
    prev: old ? (old.by === "人" && old.prev ? old.prev : stripPrev(old)) : undefined,
  };
}

/** 「元に戻す」の戻り先。直す前の判定が無ければ null（未判定の区切りを人が決めたときは、戻す先が無い） */
export function undoFix(cur: Judgment | undefined): Judgment | null {
  return cur?.prev ? { ...cur.prev } : null;
}
