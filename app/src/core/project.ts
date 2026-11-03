/**
 * 案件（spec §9.5・§17.1）。この端末に残すものと、案件ファイル（JSON）で別の端末へ持ち出すものは同じ形。
 * 事務所の PC で判定し、iPad に持っていって現地で記録し、帰ってまた PC に戻す、という流れのため。
 * サーバーを持たない道具なので、端末どうしの受け渡しはファイルでやる（AirDrop・メール・USB など、利用者の好きな手段）。
 *
 * 中身：案件名・道路名・中心線（緯度経度の折れ線。点の順が向き）・計算の系・伐採範囲の決め方（軌跡図の座標を含む）・
 * 読み込んだ公図の筆・判定・距離標・現地の記録・未判定の区切り。
 * 軌跡図の座標と案件名が入るので、このファイルは利用者の手元に置くもの。道具が外へ送ることはない。
 *
 * 版 2（2026-11-03）：中心線と系と出典を足した（F12。それまでは見本の区間に固定だった）。版 1 は見本の中心線として読む。
 * 読むときは選択肢（樹種・確信・種類…）を検める。案件ファイルは他人から受け取ることもあり、樹種の欄に HTML を入れた
 * ファイルを読んで区切りを開くと、スクリプトが鍵を読める経路になる（Codex の指摘 2026-11-03）。おかしい値が 1 つでもあれば
 * ファイル全体を断り、いまの案件は触らない。
 */
import type { KpMark } from "./kp";
import type { MapReport } from "./mojxml.worker";
import type { FieldNote } from "./notes";
import type { ParcelFeature } from "./parcels";
import { toLonLatZone, type EN, type LonLat } from "./proj";
import type { TrackSetting } from "./trackstate";
import { PRESETS } from "./vehicle";
import { PHOTO_CHANGES, type Confidence, type Judgment, type ParcelKind, type TreeKind } from "./types";

export const PROJECT_VERSION = 2;

/** 中心線の出どころ（spec §17.2）。どれでも同じ形（緯度経度の折れ線）になる */
export type CenterlineSource =
  | { kind: "demo" }
  | { kind: "kml"; file: string; line: string }
  | { kind: "drawn" }
  | { kind: "osm"; wayIds: number[]; fetchedAt: string };

export interface Centerline {
  /** 緯度経度の折れ線。最初の点が起点（0m）。点の順が向き */
  coords: LonLat[];
  source: CenterlineSource;
}

/** 自動で取得した公図の出どころ（出典の表記と、取り直しのため） */
export interface MojSource {
  city: string;
  code: string;
  zip: string;
  datasetUrl: string;
  fetchedAt: string;
}

/** 読み込んだ公図（地図XML）の筆と、地図ごとの報告。見本の公図のときは null */
export interface ProjectParcels {
  fileName: string;
  maps: MapReport[];
  skipped: string[];
  features: ParcelFeature[];
  sources?: MojSource[];
}

export interface ProjectFile {
  app: "arukumae";
  version: number;
  savedAt: string;
  /** 案件名（人が付ける。見本は「小川村 県道401号（見本）」） */
  name: string;
  /** 道路名（KML の名前・OSM の name/ref から。人が直せる。「参考」として出す） */
  roadName: string;
  centerline: Centerline;
  /** 計算に使う平面直角座標系の系（1〜19）。中心線の場所から決める（proj.ts の zoneOf） */
  zone: number;
  track: TrackSetting;
  parcels: ProjectParcels | null;
  judgments: Judgment[];
  kps: KpMark[];
  notes: FieldNote[];
  /** Claude の答えに番号がなかった区切り（未判定のまま「確かめる所」に出す） */
  unjudged: string[];
}

export function buildProject(p: Omit<ProjectFile, "app" | "version" | "savedAt">, now = new Date()): ProjectFile {
  return { app: "arukumae", version: PROJECT_VERSION, savedAt: now.toISOString(), ...p };
}

export function projectFileName(name: string, day: string): string {
  // ファイル名に使えない文字は置き換える。案件名は人が自由に付けるため
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "案件";
  return `arukumae_${safe}_${day}.json`;
}

const TREE_VALUES = [0, 25, 50, 75, 100];
const TREE_KINDS: TreeKind[] = ["針葉樹", "広葉樹", "混じる", "分からない", "なし"];
const CONFS: Confidence[] = ["高", "中", "低"];
const OTHERS = ["道路", "草地", "畑", "建物", "設備", "水", "裸地"];
const PARCEL_KINDS: ParcelKind[] = ["ふつう", "道", "水", "無地番", "地区外", "別図", "筆界未定地"];
const NOTE_RESULTS = ["○", "△", "×", ""];
/** 区切りの番号。geom.ts は 3 桁に揃えて振るが、起点から 10km を超えると 4 桁になる（L1000）。3 桁だけに絞ると長い道の案件を読めなくなる（Claude の独立レビュー 2026-11-03） */
const SEG_ID = /^[LR]\d{3,}$/;

export const MAX_ZONE = 19;

/** 版 1 のファイル用：見本の中心線。版 1 は見本の区間に固定だったので、それを補う */
export interface DemoCenterline {
  coords: LonLat[];
  roadName: string;
}

/**
 * 案件ファイルを読む。形が違えば日本語の理由を投げる（画面にそのまま出す）。
 * 筆の形は座標が数であることまで見る（全部の輪を検めても数千筆なら一瞬）。
 */
export function parseProject(text: string, demo: DemoCenterline): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("JSON として読めません。アルクマエで保存した案件ファイル（.json）を落としてください");
  }
  if (!isRecord(raw) || raw.app !== "arukumae") throw new Error("アルクマエの案件ファイルではないようです（app の印がありません）");
  if (typeof raw.version !== "number" || raw.version > PROJECT_VERSION) throw new Error(`この案件ファイルは新しい版（${String(raw.version)}）で、この道具（版 ${PROJECT_VERSION}）では読めません`);
  const v1 = raw.version < 2;

  // 中心線と系
  let centerline: Centerline;
  let zone: number;
  if (v1) {
    const roadName = typeof raw.roadName === "string" ? raw.roadName : "";
    if (roadName && roadName !== demo.roadName) throw new Error(`版 1 の案件ファイルは見本の区間（${demo.roadName}）のものだけ読めます（${roadName}）`);
    centerline = { coords: demo.coords, source: { kind: "demo" } };
    zone = 8;
  } else {
    const c = raw.centerline;
    if (!isRecord(c) || !Array.isArray(c.coords) || c.coords.length < 2 || !c.coords.every(isLonLat)) throw new Error("中心線（centerline.coords）が入っていないか、形が違います");
    const src = c.source;
    if (!isRecord(src) || !["demo", "kml", "drawn", "osm"].includes(String(src.kind))) throw new Error("中心線の出どころ（centerline.source.kind）が分かりません");
    const source: CenterlineSource =
      src.kind === "kml"
        ? { kind: "kml", file: str(src.file), line: str(src.line) }
        : src.kind === "osm"
          ? { kind: "osm", wayIds: Array.isArray(src.wayIds) ? src.wayIds.filter((x): x is number => typeof x === "number") : [], fetchedAt: str(src.fetchedAt) }
          : { kind: src.kind as "demo" | "drawn" };
    centerline = { coords: (c.coords as number[][]).map((p) => [p[0], p[1]] as LonLat), source };
    zone = Number(raw.zone);
    if (!Number.isInteger(zone) || zone < 1 || zone > MAX_ZONE) throw new Error(`計算の系（zone）が 1〜${MAX_ZONE} ではありません：${String(raw.zone)}`);
  }

  // 伐採範囲の決め方
  const track = raw.track;
  if (!isRecord(track) || !isRecord(track.source) || !isRecord(track.band)) throw new Error("伐採範囲の決め方（track）が入っていません");
  const src = track.source as { kind?: unknown; preset?: unknown; tiltZones?: unknown; lines?: unknown; name?: unknown; halfWidth?: unknown };
  if (src.kind === "vehicle") {
    if (typeof src.preset !== "string" || !(src.preset in PRESETS)) throw new Error(`知らない車両の型です：${String(src.preset)}`);
    if (!Array.isArray(src.tiltZones)) src.tiltZones = [];
  } else if (src.kind === "file") {
    if (!Array.isArray(src.lines)) throw new Error("軌跡図の線（track.source.lines）が入っていません");
    if (typeof src.name !== "string") src.name = "";
    // 版 1 は平面直角座標（第VIII系）で持っていた。版 2 からは緯度経度（系が案件ごとに変わるため）
    if (v1) src.lines = (src.lines as EN[][]).map((l) => l.map((en) => toLonLatZone(8, en)));
    if (!(src.lines as unknown[]).every((l) => Array.isArray(l) && l.every(isLonLat))) throw new Error("軌跡図の線（track.source.lines）の座標が数ではありません");
  } else if (src.kind !== "band") {
    throw new Error(`知らない伐採範囲の決め方です：${String(src.kind)}`);
  }
  for (const k of ["marginStraight", "marginCurve", "cut", "roadHalf"]) {
    const v = (track.band as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`余裕幅などの値（track.band.${k}）が数ではありません`);
  }

  // 判定・距離標・記録・未判定。選択肢にない値は、その行だけでなくファイル全体を断る（細工されたファイルをいまの案件に混ぜないため）
  const judgments = arrayOf<unknown>(raw.judgments, "judgments").map(checkJudgment);
  const kps = arrayOf<unknown>(raw.kps, "kps").map((k, i) => {
    if (!isRecord(k) || typeof k.atM !== "number" || typeof k.kp !== "number" || !Number.isFinite(k.atM) || !Number.isFinite(k.kp)) throw new Error(`距離標（kps[${i}]）の値が数ではありません`);
    return { atM: k.atM, kp: k.kp } as KpMark;
  });
  const notes = arrayOf<unknown>(raw.notes, "notes").map((n, i) => {
    if (!isRecord(n) || typeof n.segmentId !== "string" || !SEG_ID.test(n.segmentId)) throw new Error(`現地の記録（notes[${i}]）の区切りの番号が形に合いません`);
    if (!NOTE_RESULTS.includes(String(n.result ?? ""))) throw new Error(`現地の記録（${n.segmentId}）の結果が ○△× ではありません：${String(n.result)}`);
    return { segmentId: n.segmentId, result: (n.result ?? "") as FieldNote["result"], memo: str(n.memo), at: str(n.at) } as FieldNote;
  });
  const unjudged = arrayOf<unknown>(raw.unjudged, "unjudged").map((id) => {
    if (typeof id !== "string" || !SEG_ID.test(id)) throw new Error(`未判定の区切り（unjudged）の番号が形に合いません：${String(id)}`);
    return id;
  });

  // 公図の筆
  let parcels: ProjectParcels | null = null;
  if (raw.parcels != null) {
    const p = raw.parcels;
    if (!isRecord(p) || !Array.isArray(p.features)) throw new Error("公図の筆（parcels.features）の形が違います");
    const features = (p.features as unknown[]).map(checkParcel);
    const maps = Array.isArray(p.maps) ? (p.maps as unknown[]).map(checkMapReport) : [];
    const sources = Array.isArray(p.sources)
      ? (p.sources as unknown[]).filter(isRecord).map((s) => ({ city: str(s.city), code: str(s.code), zip: str(s.zip), datasetUrl: str(s.datasetUrl), fetchedAt: str(s.fetchedAt) }) as MojSource)
      : undefined;
    parcels = { fileName: typeof p.fileName === "string" ? p.fileName : "案件ファイル", maps, skipped: Array.isArray(p.skipped) ? (p.skipped as unknown[]).map(str) : [], features, ...(sources ? { sources } : {}) };
    if (!parcels.features.length) parcels = null;
  }
  return {
    app: "arukumae",
    version: PROJECT_VERSION,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
    name: typeof raw.name === "string" ? raw.name : "",
    roadName: typeof raw.roadName === "string" ? raw.roadName : v1 ? demo.roadName : "",
    centerline,
    zone,
    track: track as unknown as TrackSetting,
    parcels,
    judgments,
    kps,
    notes,
    unjudged,
  };
}

function checkJudgment(j: unknown, i: number): Judgment {
  if (!isRecord(j) || typeof j.segmentId !== "string" || !SEG_ID.test(j.segmentId)) throw new Error(`判定（judgments[${i}]）の区切りの番号が形に合いません`);
  const id = j.segmentId;
  if (!TREE_VALUES.includes(j.tree as number)) throw new Error(`判定（${id}）の木の割合が 0・25・50・75・100 ではありません：${String(j.tree)}`);
  if (!TREE_KINDS.includes(j.kind as TreeKind)) throw new Error(`判定（${id}）の樹種が選択肢にありません：${String(j.kind)}`);
  if (!CONFS.includes(j.conf as Confidence)) throw new Error(`判定（${id}）の確信が 高・中・低 ではありません：${String(j.conf)}`);
  if (!Array.isArray(j.other) || !j.other.every((o) => OTHERS.includes(String(o)))) throw new Error(`判定（${id}）の「木以外」が選択肢にありません`);
  if (j.by !== "Claude" && j.by !== "人") throw new Error(`判定（${id}）の「決めたのは」が Claude・人 ではありません：${String(j.by)}`);
  const out: Judgment = { segmentId: id, tree: j.tree as number, kind: j.kind as TreeKind, other: j.other as string[], conf: j.conf as Confidence, why: str(j.why), by: j.by };
  if (j.model != null) out.model = str(j.model);
  if (j.before != null) {
    const b = j.before;
    if (!isRecord(b) || !TREE_VALUES.includes(b.tree as number) || !CONFS.includes(b.conf as Confidence)) throw new Error(`判定（${id}）の最初の判定（before）の値が選択肢にありません`);
    out.before = { tree: b.tree as number, conf: b.conf as Confidence, ...(b.model != null ? { model: str(b.model) } : {}) };
  }
  if (j.oldYear != null) {
    if (!/^\d{4}$/.test(String(j.oldYear))) throw new Error(`判定（${id}）の別の年（oldYear）が 4 桁の年ではありません`);
    out.oldYear = String(j.oldYear);
  }
  if (j.treeOld != null) {
    if (!TREE_VALUES.includes(j.treeOld as number)) throw new Error(`判定（${id}）の別の年の割合（treeOld）が選択肢にありません`);
    out.treeOld = j.treeOld as number;
  }
  if (j.change != null) {
    if (!(PHOTO_CHANGES as readonly string[]).includes(String(j.change))) throw new Error(`判定（${id}）の変化（change）が選択肢にありません：${String(j.change)}`);
    out.change = j.change as Judgment["change"];
  }
  if (j.prev != null) {
    const prev = checkJudgment({ ...(j.prev as object), segmentId: id }, i);
    delete (prev as { prev?: unknown }).prev;
    out.prev = prev;
  }
  return out;
}

function checkParcel(f: unknown, i: number): ParcelFeature {
  if (!isRecord(f) || !isRecord(f.properties) || !isRecord(f.geometry)) throw new Error(`公図の筆（parcels.features[${i}]）の形が違います`);
  const p = f.properties;
  if (typeof p.id !== "string" || typeof p.map !== "string" || typeof p.chiban !== "string") throw new Error(`公図の筆（parcels.features[${i}]）の id・map・chiban が文字ではありません`);
  if (!PARCEL_KINDS.includes(p.kind as ParcelKind)) throw new Error(`公図の筆（${p.id}）の種類が選択肢にありません：${String(p.kind)}`);
  const g = f.geometry;
  if (g.type !== "Polygon" || !Array.isArray(g.coordinates) || !g.coordinates.every((r) => Array.isArray(r) && r.length >= 4 && r.every(isLonLat))) throw new Error(`公図の筆（${p.id}）の形（geometry）が多角形ではありません`);
  return {
    type: "Feature",
    properties: { id: p.id, map: p.map, oaza: p.oaza == null ? null : str(p.oaza), chiban: p.chiban, kind: p.kind as ParcelKind, ...(p.accuracy != null ? { accuracy: str(p.accuracy) } : {}), ...(p.survey != null ? { survey: str(p.survey) } : {}) } as ParcelFeature["properties"],
    geometry: { type: "Polygon", coordinates: (g.coordinates as number[][][]).map((r) => r.map((c) => [c[0], c[1]])) },
  };
}

function checkMapReport(m: unknown): MapReport {
  if (!isRecord(m)) throw new Error("公図の地図ごとの報告（parcels.maps）の形が違います");
  return { stem: str(m.stem), name: str(m.name), city: str(m.city), crs: str(m.crs), isPublic: !!m.isPublic, total: num(m.total), kept: num(m.kept), noShape: num(m.noShape) };
}

/** 案件ファイルの中身を短く言う（読み込む前の確認と、読み込んだ後の報告に） */
export function describeProject(p: ProjectFile): string {
  const parts = [
    `中心線 ${describeCenterline(p.centerline)}`,
    p.parcels ? `公図「${p.parcels.fileName}」の筆 ${p.parcels.features.length}` : p.centerline.source.kind === "demo" ? "公図は見本" : "公図はまだ",
    `判定 ${p.judgments.length}`,
    `距離標 ${p.kps.length}`,
    `現地の記録 ${p.notes.length}`,
  ];
  const when = p.savedAt ? p.savedAt.slice(0, 16).replace("T", " ") : "";
  return `${p.name || "（案件名なし）"}${when ? `（${when} 保存）` : ""}：${parts.join("・")}`;
}

export function describeCenterline(c: Centerline): string {
  const s = c.source;
  switch (s.kind) {
    case "demo":
      return "見本（小川村 県道401号）";
    case "kml":
      return `軌跡図「${s.file}」の線「${s.line || "（名前なし）"}」`;
    case "drawn":
      return `地図に手で描いた（${c.coords.length} 点）`;
    case "osm":
      return `OpenStreetMap の道路をたどった（way ${s.wayIds.length} 本）`;
  }
}

/** 公図の出典の表記（地図の右下・書き出し・PDF に）。市町村名は読んだ地図の <市区町村名> から。見本は小川村 */
export function mojAttribution(parcels: ProjectParcels | null, demo: boolean): string {
  if (!parcels) return demo ? "登記所備付地図データ 上水内郡小川村（法務省）" : "登記所備付地図データ（法務省）";
  const cities = [...new Set(parcels.maps.filter((m) => m.isPublic && m.city).map((m) => m.city))];
  return `登記所備付地図データ${cities.length ? ` ${cities.join("・")}` : ""}（法務省）`;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isLonLat(p: unknown): p is LonLat {
  return Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number" && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function str(x: unknown): string {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function arrayOf<T>(x: unknown, name: string): T[] {
  if (x == null) return [];
  if (!Array.isArray(x)) throw new Error(`${name} が配列ではありません`);
  return x as T[];
}
