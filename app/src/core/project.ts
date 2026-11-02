/**
 * 案件ファイル（spec §9.5）。この端末に残しているものを 1 つの JSON にまとめ、別の端末へ持ち出す。
 * 事務所の PC で判定し、iPad に持っていって現地で記録し、帰ってまた PC に戻す、という流れのため。
 * サーバーを持たない道具なので、端末どうしの受け渡しはファイルでやる（AirDrop・メール・USB など、利用者の好きな手段）。
 *
 * 中身は localStorage に残しているものと同じ：伐採範囲の決め方（軌跡図の座標を含む）・読み込んだ公図の筆・判定・距離標・現地の記録。
 * 軌跡図の座標と案件名が入るので、このファイルは利用者の手元に置くもの。道具が外へ送ることはない。
 */
import type { KpMark } from "./kp";
import type { FieldNote } from "./notes";
import type { ParcelFeature } from "./parcels";
import type { TrackSetting } from "./trackstate";
import { PRESETS } from "./vehicle";
import type { Judgment } from "./types";

export const PROJECT_VERSION = 1;

/** 読み込んだ公図（地図XML）の筆と、地図ごとの報告。見本の公図のときは null */
export interface ProjectParcels {
  fileName: string;
  maps: unknown[];
  skipped: string[];
  features: ParcelFeature[];
}

export interface ProjectFile {
  app: "arukumae";
  version: number;
  savedAt: string;
  /** 案件名（人が付ける。見本は「小川村 県道401号（見本）」） */
  name: string;
  /** 道路名（中心線のデータから。いまは見本の区間だけなので確かめ用） */
  roadName: string;
  track: TrackSetting;
  parcels: ProjectParcels | null;
  judgments: Judgment[];
  kps: KpMark[];
  notes: FieldNote[];
}

export function buildProject(p: Omit<ProjectFile, "app" | "version" | "savedAt">, now = new Date()): ProjectFile {
  return { app: "arukumae", version: PROJECT_VERSION, savedAt: now.toISOString(), ...p };
}

export function projectFileName(name: string, day: string): string {
  // ファイル名に使えない文字は置き換える。案件名は人が自由に付けるため
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "案件";
  return `arukumae_${safe}_${day}.json`;
}

/**
 * 案件ファイルを読む。形が違えば日本語の理由を投げる（画面にそのまま出す）。
 * 中身を全部は検めない（筆の形まで見ると長くなる）。道具が自分で書いたものを読み戻すのが主なので、
 * 「別のファイルを間違って落とした」ことが分かる程度に見る
 */
export function parseProject(text: string): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("JSON として読めません。アルクマエで保存した案件ファイル（.json）を落としてください");
  }
  if (!isRecord(raw) || raw.app !== "arukumae") throw new Error("アルクマエの案件ファイルではないようです（app の印がありません）");
  if (typeof raw.version !== "number" || raw.version > PROJECT_VERSION) throw new Error(`この案件ファイルは新しい版（${String(raw.version)}）で、この道具（版 ${PROJECT_VERSION}）では読めません`);
  const track = raw.track;
  if (!isRecord(track) || !isRecord(track.source) || !isRecord(track.band)) throw new Error("伐採範囲の決め方（track）が入っていません");
  const src = track.source as { kind?: unknown; preset?: unknown; tiltZones?: unknown; lines?: unknown };
  if (src.kind === "vehicle") {
    if (typeof src.preset !== "string" || !(src.preset in PRESETS)) throw new Error(`知らない車両の型です：${String(src.preset)}`);
    if (!Array.isArray(src.tiltZones)) src.tiltZones = [];
  } else if (src.kind === "file") {
    if (!Array.isArray(src.lines)) throw new Error("軌跡図の線（track.source.lines）が入っていません");
  } else if (src.kind !== "band") {
    throw new Error(`知らない伐採範囲の決め方です：${String(src.kind)}`);
  }
  const judgments = arrayOf<Judgment>(raw.judgments, "judgments").filter((j) => isRecord(j) && typeof j.segmentId === "string" && typeof j.tree === "number");
  const kps = arrayOf<KpMark>(raw.kps, "kps").filter((k) => isRecord(k) && typeof k.atM === "number" && typeof k.kp === "number");
  const notes = arrayOf<FieldNote>(raw.notes, "notes").filter((n) => isRecord(n) && typeof n.segmentId === "string");
  let parcels: ProjectParcels | null = null;
  if (raw.parcels != null) {
    const p = raw.parcels;
    if (!isRecord(p) || !Array.isArray(p.features)) throw new Error("公図の筆（parcels.features）の形が違います");
    parcels = { fileName: typeof p.fileName === "string" ? p.fileName : "案件ファイル", maps: Array.isArray(p.maps) ? p.maps : [], skipped: Array.isArray(p.skipped) ? (p.skipped as string[]) : [], features: p.features as ParcelFeature[] };
    if (!parcels.features.length) parcels = null;
  }
  return {
    app: "arukumae",
    version: raw.version,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
    name: typeof raw.name === "string" ? raw.name : "",
    roadName: typeof raw.roadName === "string" ? raw.roadName : "",
    track: track as unknown as TrackSetting,
    parcels,
    judgments,
    kps,
    notes,
  };
}

/** 案件ファイルの中身を短く言う（読み込む前の確認と、読み込んだ後の報告に） */
export function describeProject(p: ProjectFile): string {
  const parts = [
    p.parcels ? `公図「${p.parcels.fileName}」の筆 ${p.parcels.features.length}` : "公図は見本",
    `判定 ${p.judgments.length}`,
    `距離標 ${p.kps.length}`,
    `現地の記録 ${p.notes.length}`,
  ];
  const when = p.savedAt ? p.savedAt.slice(0, 16).replace("T", " ") : "";
  return `${p.name || "（案件名なし）"}${when ? `（${when} 保存）` : ""}：${parts.join("・")}`;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function arrayOf<T>(x: unknown, name: string): T[] {
  if (x == null) return [];
  if (!Array.isArray(x)) throw new Error(`${name} が配列ではありません`);
  return x as T[];
}
