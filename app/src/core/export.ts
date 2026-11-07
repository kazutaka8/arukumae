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
  /** 筆が入っていた地図の名前（頭が市区町村コード）。CSV の列には出さない（COLUMNS に無い）。買うリストで市町村をまたいでまとめないために持つ */
  地図: string;
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
  unjudged: ReadonlySet<string> | null = null,
): ListRow[] {
  // 区切りごとの「確かめる所」。確信「低」・森林の食い違い・変化・未判定（画面・KML・PDF と同じ並びにする）
  const checksBySeg = new Map<string, ReturnType<typeof listChecks>>();
  for (const c of listChecks(segments, judgments, forestFlags, unjudged)) {
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
      // 判定のない区切りがある筆は、木のある面積が判定した区切りの分だけなので、必ず断る（Codex の指摘 2026-11-07。見本の 80 区切りの状態で起きる）
      備考: [remark(js), js.length && js.length < h.segmentIds.length ? partialNote(h.segmentIds.length - js.length) : "", js.length && segmentsOverlap(h) ? OVERLAP_NOTE : ""].filter(Boolean).join("。"),
      地図: p.map,
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

/**
 * つづら折りでは区切りどうしが重なる。かかる面積は重なりを除いて測るが、木のある面積は区切りごとの面積×割合の合計なので、
 * 重なる分を二重に数える（木のある面積がかかる面積を超えることもある）。按分はまだ作っていないので、そうなる筆の備考に断りを出す
 * （spec §8.3 に書いてあったが出ていなかった。Codex の提案 2026-11-06）
 */
export const OVERLAP_NOTE = "区切りが重なる所にかかるため、木のある面積（推定）は重なる分を二重に数えている";

/** 筆にかかる区切りの面積の合計が、かかる面積（重なりを除いた値）より大きいか。丸めの差（1%＋0.5m²）は重なりと見ない */
function segmentsOverlap(h: ParcelHit): boolean {
  let sum = 0;
  for (const id of h.segmentIds) sum += h.segAreas[id] ?? 0;
  return sum > h.areaM2 * 1.01 + 0.5;
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
    // 市町村が違えば、大字名と地番が同じでも別の土地。まとめると買うリストから 1 件抜ける（Codex の指摘 2026-11-06）。
    // 市町村は地図の名前の頭（市区町村コード 5 桁。法務省の地図は「20588-1000-6」の形）で分ける。その形でなければ地図ごとに分ける（まとめすぎない側）
    const city = /^\d{5}(?=-)/.exec(r.地図)?.[0] ?? r.地図;
    const key = `${city}\t${r.所在}\t${r.地番}`;
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

export function partialNote(n: number): string {
  return `判定のない区切り ${n}（木のある面積は、判定した区切りの分だけ）`;
}

/**
 * 表計算で数式として読まれる値（= + - @ やタブで始まる文字）の頭に ' を付ける。案件ファイルの所在などは人が書けるので、
 * 受け取った案件を書き出して Excel で開いたときに数式が動かないように（Codex の指摘 2026-11-07。CSV injection）。数は数のまま
 */
export function neutralizeCell(v: unknown): string {
  const s = String(v ?? "");
  return typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvOf<T extends object>(columns: (keyof T)[], rows: T[]): string {
  const esc = (v: unknown) => {
    const s = neutralizeCell(v);
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
