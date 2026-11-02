/**
 * 現地の記録（持ち運びモード）。区切りごとに、現地で見た結果（○・△・×）とメモを残す。
 *
 * - ○：判定どおりだった（木がある／ない、が合っている）
 * - △：分からない・もう一度見る
 * - ×：判定と違う（帰ってから「この区切りを直す」で直す候補）
 * 記録はこの端末（localStorage）に残し、一覧表の列・現地マップの吹き出し・持って歩く地図の表に出す。
 * 判定そのもの（Judgment）とは分けて持つ：現地で見たことの記録と、判定を直すことは別の行為で、記録だけ残して後で直すことが多いため
 */

export type NoteResult = "○" | "△" | "×";

export interface FieldNote {
  segmentId: string;
  result: NoteResult | "";
  memo: string;
  /** 記録した日時（ISO） */
  at: string;
}

export const NOTE_RESULTS: { value: NoteResult; label: string }[] = [
  { value: "○", label: "判定どおり" },
  { value: "△", label: "分からない" },
  { value: "×", label: "違う" },
];

/** 区切りの記録を 1 つの言葉に。「×：電線あり」「○」。何もなければ空 */
export function noteText(n: FieldNote | undefined): string {
  if (!n || (!n.result && !n.memo)) return "";
  return n.memo ? `${n.result || "メモ"}：${n.memo}` : n.result;
}

/** 筆など、複数の区切りの記録をまとめる。「L003 ×：電線あり ／ L004 ○」 */
export function notesText(notes: Map<string, FieldNote>, segmentIds: string[]): string {
  return segmentIds
    .map((id) => {
      const t = noteText(notes.get(id));
      return t ? `${id} ${t}` : "";
    })
    .filter(Boolean)
    .join(" ／ ");
}

/** 記録のあるもの（結果かメモがある）だけを残す。空の記録は保存しない */
export function pruneNotes(notes: Map<string, FieldNote>): FieldNote[] {
  return [...notes.values()].filter((n) => n.result || n.memo.trim());
}

/** 記録の数：結果ごとと、確かめる所のうち記録済みの数 */
export function countNotes(notes: Map<string, FieldNote>, checkIds: string[]): { total: number; byResult: Record<NoteResult, number>; checksDone: number } {
  const byResult: Record<NoteResult, number> = { "○": 0, "△": 0, "×": 0 };
  let total = 0;
  for (const n of notes.values()) {
    if (!n.result && !n.memo.trim()) continue;
    total++;
    if (n.result) byResult[n.result]++;
  }
  const ids = new Set(checkIds);
  const checksDone = [...ids].filter((id) => noteText(notes.get(id))).length;
  return { total, byResult, checksDone };
}
