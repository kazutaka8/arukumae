/**
 * 一覧表（F7、spec §9.1）。1筆1行。筆が複数の区切りにまたがるときは集計する。
 * CSV は UTF-8 に BOM を付けて出す。Excel がそのまま日本語を読めるように（BOM がないと Shift_JIS と見なして化ける）。
 * 森林の区域と届出の目印は、林野庁のタイルから筆ごとに出したもの（forest.ts）。まだ読めていなければ空にする
 */
import { checkText, listChecks } from "./checks";
import { forestText, noticeText, type ForestInfo } from "./forest";
import type { Segment } from "./geom";
import { estimateKp, formatKp, type KpMark } from "./kp";
import { notesText, type FieldNote } from "./notes";
import { kindLabel, type Judgment, type ParcelHit, type ParcelProps } from "./types";

export interface ListRow {
  起点からの距離: string;
  左右: string;
  道路名とKP: string;
  KPの根拠: string;
  所在: string;
  地番: string;
  地番の種類: string;
  かかる面積m2: number;
  木のある面積m2: number | "";
  樹種の目安: string;
  木以外: string;
  確信: string;
  現地で確かめる所: string;
  現地の記録: string;
  決めたのは: string;
  森林の区域: string;
  伐採の届出の目印: string;
  備考: string;
}

export const COLUMNS: (keyof ListRow)[] = [
  "起点からの距離", "左右", "道路名とKP", "KPの根拠", "所在", "地番", "地番の種類", "かかる面積m2",
  "木のある面積m2", "樹種の目安", "木以外", "確信", "現地で確かめる所", "現地の記録", "決めたのは", "森林の区域", "伐採の届出の目印", "備考",
];

const CONF_ORDER = { 低: 0, 中: 1, 高: 2 } as const;

export function buildRows(
  hits: ParcelHit[],
  parcelById: Map<string, { properties: ParcelProps }>,
  judgments: Map<string, Judgment>,
  kps: KpMark[],
  roadName: string,
  forest: Map<string, ForestInfo> | null = null,
  forestFlags: Map<string, string> | null = null,
  segments: Segment[] = [],
  notes: Map<string, FieldNote> | null = null,
): ListRow[] {
  // 区切りごとの「確かめる所」。確信「低」と森林の食い違いの両方
  const checksBySeg = new Map<string, ReturnType<typeof listChecks>>();
  for (const c of listChecks(segments, judgments, forestFlags)) {
    const arr = checksBySeg.get(c.segmentId) ?? [];
    arr.push(c);
    checksBySeg.set(c.segmentId, arr);
  }
  return hits.map((h) => {
    const p = parcelById.get(h.parcelId)!.properties;
    const js = h.segmentIds.map((id) => judgments.get(id)).filter((j): j is Judgment => !!j);
    // 木のある面積：区切りごとの重なる面積 × 木の割合。判定のない区切りは数えない
    let treeArea = 0;
    for (const j of js) treeArea += (h.segAreas[j.segmentId] ?? 0) * (j.tree / 100);
    const kinds = count(js.map((j) => j.kind).filter((k) => k !== "なし"));
    const others = [...new Set(js.flatMap((j) => j.other))];
    const worst = js.length ? js.reduce((a, b) => (CONF_ORDER[a.conf] <= CONF_ORDER[b.conf] ? a : b)) : null;
    const checks = segments.length ? h.segmentIds.flatMap((id) => checksBySeg.get(id) ?? []) : js.filter((j) => j.conf === "低").map((j) => ({ segmentId: j.segmentId, kind: "低" as const, why: j.why, tree: j.tree }));
    const mid = (h.fromM + h.toM) / 2;
    const est = estimateKp(kps, mid);
    return {
      起点からの距離: `${h.fromM}〜${h.toM}m`,
      左右: h.sides.map((s) => (s === "L" ? "左" : "右")).join("・"),
      道路名とKP: formatKp(roadName, est),
      KPの根拠: est?.basis ?? (kps.length < 2 ? "距離標が 2 本未満" : ""),
      所在: p.oaza ?? "",
      地番: p.chiban,
      地番の種類: kindLabel(p.kind),
      かかる面積m2: h.areaM2,
      木のある面積m2: js.length ? Math.round(treeArea * 10) / 10 : "",
      樹種の目安: kinds,
      木以外: others.join("・"),
      確信: worst ? worst.conf : "",
      現地で確かめる所: checkText(checks),
      現地の記録: notes ? notesText(notes, h.segmentIds) : "",
      決めたのは: js.length ? (js.some((j) => j.by === "人") ? (js.every((j) => j.by === "人") ? "人" : "人・Claude") : "Claude") : "",
      森林の区域: forest ? forestText(forest.get(h.parcelId)) : "",
      伐採の届出の目印: forest ? noticeText(forest.get(h.parcelId)) : "",
      備考: remark(js),
    };
  });
}

/** 備考：別の年の写真と見比べて判定したこと（何年の写真かを出力に必ず残す。spec F11）と、変化のあった区切り */
function remark(js: Judgment[]): string {
  const years = [...new Set(js.map((j) => j.oldYear).filter((y): y is string => !!y))];
  if (!years.length) return "";
  const changes = js.filter((j) => j.change && j.change !== "変化なし").map((j) => `${j.segmentId} ${j.change}`);
  return `${years.join("・")} 年度の写真と見比べて判定${changes.length ? `（${changes.join("、")}）` : ""}`;
}

/** 「広葉樹 3・針葉樹 1」のように、多い順に数える */
function count(xs: string[]): string {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・");
}

export function toCsv(rows: ListRow[]): string {
  return csvOf(COLUMNS, rows);
}

/**
 * 公図を買うリスト。登記情報提供サービスで公図（と登記事項）を 1 件ずつ買うときの控え（1 件 360 円）。
 * 所在・地番が同じ行は 1 つにまとめる（同じ筆が複数の区切りにまたがっても、買うのは 1 件）。
 * 地区外・別図は hits に入っていないので、ここにも出ない
 */
export interface BuyRow {
  所在: string;
  地番: string;
  地番の種類: string;
  起点からの距離: string;
  左右: string;
  道路名とKP: string;
  かかる面積m2: number;
  森林の区域: string;
  購入: string;
  備考: string;
}

export const BUY_COLUMNS: (keyof BuyRow)[] = ["所在", "地番", "地番の種類", "起点からの距離", "左右", "道路名とKP", "かかる面積m2", "森林の区域", "購入", "備考"];

export function buildBuyList(rows: ListRow[]): BuyRow[] {
  const seen = new Map<string, BuyRow>();
  for (const r of rows) {
    const key = `${r.所在}\t${r.地番}`;
    const prev = seen.get(key);
    if (prev) {
      prev.かかる面積m2 = Math.round((prev.かかる面積m2 + r.かかる面積m2) * 10) / 10;
      continue;
    }
    seen.set(key, { 所在: r.所在, 地番: r.地番, 地番の種類: r.地番の種類, 起点からの距離: r.起点からの距離, 左右: r.左右, 道路名とKP: r.道路名とKP, かかる面積m2: r.かかる面積m2, 森林の区域: r.森林の区域, 購入: "", 備考: "" });
  }
  return [...seen.values()];
}

export function toBuyCsv(rows: BuyRow[]): string {
  return csvOf(BUY_COLUMNS, rows);
}

function csvOf<T extends object>(columns: (keyof T)[], rows: T[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** ブラウザでファイルとして保存させる */
export function download(filename: string, content: string, type = "text/csv;charset=utf-8") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
