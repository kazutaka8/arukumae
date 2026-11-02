/**
 * 一覧の絞り込み（spec §6.3）。「かかる筆」と「確かめる所」の一覧を、見たいものだけにする。
 * 現場で「次に見る所」を探すとき、340 行から目で探すのはつらい（iPad では特に）。
 * 選ぶのは 1 つだけ（組み合わせない）。地番の文字での検索だけは、筆の一覧でそれと重ねられる。
 * 地図は絞らない。一覧で絞って行を押せば地図が飛ぶので、地図まで消すと周りが分からなくなる
 */
import type { Check } from "./checks";
import type { ForestInfo } from "./forest";
import type { FieldNote } from "./notes";
import type { Judgment, ParcelHit, ParcelProps } from "./types";

export type HitFilter = "all" | "tree" | "check" | "forest" | "unjudged" | "ng";
export type CheckFilter = "all" | "low" | "forest" | "todo" | "ng" | "done";

/** 木ありと見る割合（最大がこれ以上）。判定の刻みは 0・25・50・75・100 なので、半分以上 */
export const TREE_MIN = 50;

export const HIT_FILTERS: { id: HitFilter; label: string; tip: string }[] = [
  { id: "all", label: "全部", tip: "かかる筆を全部" },
  { id: "tree", label: "木あり", tip: `重なる区切りの木の割合の最大が ${TREE_MIN}% 以上の筆` },
  { id: "check", label: "確かめる所", tip: "現地で確かめる所（確信が低い・森林の区域と食い違う）を含む筆" },
  { id: "forest", label: "森林の区域", tip: "かかる部分が森林計画の対象森林（林野庁）に入る筆" },
  { id: "unjudged", label: "未判定", tip: "重なる区切りのどれにも判定がない筆" },
  { id: "ng", label: "現地 ×", tip: "現地の記録が ×（違う）の区切りを含む筆" },
];

export const CHECK_FILTERS: { id: CheckFilter; label: string; tip: string }[] = [
  { id: "all", label: "全部", tip: "確かめる所を全部" },
  { id: "low", label: "確信 低", tip: "Claude の確信が低かった区切り" },
  { id: "forest", label: "森林", tip: "森林の区域と判定が食い違う区切り" },
  { id: "todo", label: "まだ", tip: "現地の記録がまだない所" },
  { id: "ng", label: "×", tip: "現地の記録が ×（違う）の所" },
  { id: "done", label: "済", tip: "現地の記録（○△×）がある所" },
];

export interface HitFilterContext {
  parcelById: Map<string, { properties: ParcelProps }>;
  judgments: Map<string, Judgment>;
  /** 確かめる所の区切り id */
  checkSegs: Set<string>;
  forest: Map<string, ForestInfo> | null;
  notes: Map<string, FieldNote>;
}

export function filterHits(hits: ParcelHit[], f: HitFilter, query: string, ctx: HitFilterContext): ParcelHit[] {
  const q = query.trim();
  return hits.filter((h) => {
    if (q) {
      const p = ctx.parcelById.get(h.parcelId)?.properties;
      if (!p || !(p.chiban.includes(q) || (p.oaza ?? "").includes(q))) return false;
    }
    switch (f) {
      case "all":
        return true;
      case "tree": {
        const js = h.segmentIds.map((id) => ctx.judgments.get(id)).filter((j): j is Judgment => !!j);
        return js.length > 0 && Math.max(...js.map((j) => j.tree)) >= TREE_MIN;
      }
      case "check":
        return h.segmentIds.some((id) => ctx.checkSegs.has(id));
      case "forest": {
        const fi = ctx.forest?.get(h.parcelId);
        // forest.ts の一覧の表示と同じ線引き（2% 未満は「外」と見せている）
        return !!fi && fi.ratio >= 0.02;
      }
      case "unjudged":
        return !h.segmentIds.some((id) => ctx.judgments.has(id));
      case "ng":
        return h.segmentIds.some((id) => ctx.notes.get(id)?.result === "×");
    }
  });
}

export function filterChecks(checks: Check[], f: CheckFilter, notes: Map<string, FieldNote>): Check[] {
  return checks.filter((c) => {
    const n = notes.get(c.segmentId);
    switch (f) {
      case "all":
        return true;
      case "low":
        return c.kind === "低";
      case "forest":
        return c.kind === "森林";
      case "todo":
        return !n?.result;
      case "ng":
        return n?.result === "×";
      case "done":
        return !!n?.result;
    }
  });
}
