/**
 * アルクマエの入口。案件（見本か、この端末に残したもの）を読み、地図とパネルを組む。
 * 手順 1〜7 を全部触れる。状態（AppState）はここに 1 つ置き、計算は core/、地図は map/、骨組みは ui/ に分ける。
 *
 * 2026-11-03（F12）から、案件は見本の区間に固定ではない。中心線を軌跡図の KML から選ぶ・OpenStreetMap をたどる・手で描く、
 * 公図を市町村から自動で取得する、ができる。案件は 1 つの保存単位（core/store.ts）で、端末に持つのは 1 つ。別の案件は案件ファイルで切り替える
 */
import "./style.css";
import type { FeatureCollection, Point, Polygon, Position } from "geojson";
import type { LngLatBoundsLike, MapGeoJSONFeature, Map as MlMap, GeoJSONSource } from "maplibre-gl";
import { buildBuyList, buildRows, download, toBuyCsv, toCsv } from "./core/export";
import { fieldGeoJSON, fieldKml, type FieldMapInput } from "./core/fieldkml";
import { leftNormals, nearestOnLine, resample, type Segment } from "./core/geom";
import { estimateKp, fmtKm, formatKp, type KpMark } from "./core/kp";
import { estimateCost, fmtUsd, judgeWindow, makeClient, MODELS, type ModelId } from "./core/judge";
import { findHits, hitsToGeoJSON, segmentsToGeoJSON, type ParcelFeature } from "./core/parcels";
import { PHOTO_YEARS, photoLayerLabel, renderSegmentCrop, renderWindow, windowsOf, type PhotoLayer } from "./core/photo";
import { setZone, toLonLat, toPlane, zoneLabel, zoneOf, type EN, type LonLat } from "./core/proj";
import { parseNamedBytes, parseTrackBytes, trackGeoJSON, trackKml } from "./core/track";
import { computeTrack, DEFAULT_TRACK, describeTrack, legacyTrack, type TrackResult, type TrackSetting } from "./core/trackstate";
import { bladeHorizontal, DEFAULT_BAND, PRESETS, sweepMax, type PresetId, type TiltZone, type Vehicle } from "./core/vehicle";
import { buildWalkMap, walkMapPageCount, type WalkMapInput } from "./core/walkmap";
import { fetchForest, ForestIndex, forestMismatch, forestOfHits, forestOfSegments, forestText, noticeText, type ForestInfo, type SegmentForest } from "./core/forest";
import { type Check, listChecks, REVIEW_GAP, treeText } from "./core/checks";
import { CHECK_FILTERS, filterChecks, filterHits, HIT_FILTERS, type CheckFilter, type HitFilter } from "./core/filter";
import { buildProject, describeCenterline, describeProject, mojAttribution, parseProject, projectFileName, type Centerline, type CenterlineSource, type MojSource, type ProjectFile } from "./core/project";
import { clearLegacy, loadLegacy, loadStored, saveStored } from "./core/store";
import { bboxOf as bboxOfLonLat, dedupe, lengthM, lineChoices, midpoint, pickCenterline, reversed, roadNameFromLine, validateCenterline, type LineChoice } from "./core/centerline";
import { findMunicipalities, fmtMb, samplePoints, searchDataset, type MojDataset, type Municipality } from "./core/mojfetch";
import { buildGraph, fetchRoads, roadNameOf, routeBbox, shortestPath, snapToRoad } from "./core/osmroute";
import { countNotes, NOTE_RESULTS, noteText, pruneNotes, type FieldNote, type NoteResult } from "./core/notes";
import { isRealChange, kindLabel, NOT_LAND, type Confidence, type Judgment, type ParcelHit, type ParcelKind, type TreeKind } from "./core/types";
import type { MapReport, WorkerIn, WorkerOut, WorkerSource } from "./core/mojxml.worker";
import { loadDemoJudgments, loadParcels, loadSection } from "./data/demo";
import { addDraft, addKps, addParcels, addSection, addSegments, addTrack, applyJudgments, createMap, DEMO_MOJ, KIND_COLORS, setAttribution, setDraft, setGroupVisible, setPhotoYear, setSection, setSourceData, type LayerGroup } from "./map/map";
import { buildLayout, escapeHtml, help, hideBusy, leftCover, openDetail, renderSteps, rightCover, showBusy, showListTab, STEPS } from "./ui/panels";

/** 見本（小川村 県道401号）。組み込みの案件。「見本に戻す」と、版 1 の案件ファイルの中心線に使う */
interface Demo {
  coords: LonLat[];
  roadName: string;
  parcels: ParcelFeature[];
  judgments: Judgment[];
}

interface AppState {
  map: MlMap;
  step: number;
  demo: Demo;
  /** 案件名（人が付ける）。案件ファイルの名前と画面の上に出す */
  name: string;
  roadName: string;
  centerline: Centerline;
  /** 計算の系（平面直角座標系の番号）。中心線の場所から決める */
  zone: number;
  /** 中心線を 1m ごとに打ち直した点。添字＝起点からの距離（m） */
  dense: EN[];
  normals: EN[];
  /** 伐採範囲の決め方（手順 2）と、その計算の結果 */
  track: TrackSetting;
  trackResult: TrackResult;
  /** 手順 2 で読み込みに失敗したときの言葉 */
  trackError: string | null;
  /** 手順 2 で「軌跡図のファイルを読む」を選んだがまだ読んでいない状態。読むまで track は前のまま（空の軌跡で置き換えない） */
  trackDraft: "file" | null;
  segments: Segment[];
  segmentsGeo: FeatureCollection<Polygon>;
  parcels: ParcelFeature[];
  parcelById: Map<string, ParcelFeature>;
  hits: ParcelHit[];
  hitById: Map<string, ParcelHit>;
  judgments: Map<string, Judgment>;
  /** Claude の答えに番号がなかった区切り。未判定のまま「確かめる所」に出す */
  unjudged: Set<string>;
  selectedParcel: string | null;
  selectedSegment: string | null;
  /** 「確かめる所」の何番目を見ているか（-1 はまだ）。手順 5 の前へ・次へと一覧の行で動く */
  lowCursor: number;
  /** 人が置いた距離標（F9） */
  kps: KpMark[];
  /** 「地図を押して距離標を置く」の最中か */
  placingKp: boolean;
  /** 「地図を押して起立の区間を指す」の最中。1 点目を押したら fromM が入る */
  placingTilt: { fromM: number | null } | null;
  /** 中心線を地図に手で描いている最中（手順 1） */
  drawing: { points: LonLat[] } | null;
  /** OpenStreetMap の道路をたどる最中（手順 1）。起点・終点を押し、道を引いた結果 */
  osmPick: { start: LonLat | null; end: LonLat | null; busy: boolean; error: string | null; result: { coords: LonLat[]; wayIds: number[]; roadName: string; lengthM: number } | null } | null;
  /** 軌跡図のファイルから中心線を選んでいる最中（手順 1） */
  lineChoices: { file: string; choices: LineChoice[]; picked: number } | null;
  /** 判定の進み具合。null なら動いていない */
  run: { done: number; total: number; usd: number; log: string[]; cancel: boolean } | null;
  /** PDF を描いている最中の進み具合 */
  pdfRun: { done: number; total: number } | null;
  pdfError: string | null;
  /** 森林の区域（林野庁）。読めるまで null。読めたら筆ごとの重なり、区切りごとの重なり、判定との食い違い */
  forestIndex: ForestIndex | null;
  forest: Map<string, ForestInfo> | null;
  segForest: Map<string, SegmentForest> | null;
  forestFlags: Map<string, string> | null;
  forestNote: string;
  /** 公図の出どころ（見本か、読み込んだ・取得したファイルか）と、地図ごとの報告 */
  parcelSource: ParcelSource;
  /** 公図を読んでいる最中の進み具合。null なら動いていない */
  parcelRun: { bytes: number; total: number; maps: number; kept: number; current: string | null; label: string } | null;
  parcelError: string | null;
  /** 公図の自動取得（手順 2）の進み具合 */
  fetchRun: FetchRun | null;
  /** 現地の記録（持ち運びモード）。区切りごとの○△×とメモ。この端末に残す */
  notes: Map<string, FieldNote>;
  /** 案件ファイルの保存・読み込みの結果。手順 1 に出す */
  projectMsg: { text: string; error: boolean } | null;
  /** この端末に残せなかったときの言葉（残せていれば null） */
  saveError: string | null;
  /** 一覧の絞り込み。地図は絞らない（filter.ts） */
  filter: { hits: HitFilter; q: string; checks: CheckFilter };
  /** 地図に重ねる写真の年（地理院の年度別写真）。null なら全国最新写真だけ */
  photoYear: PhotoLayer | null;
  /** 公図から残す幅（中心線の両側 m）。次に読むときに使う */
  parcelBuffer: number;
}

interface ParcelSource {
  fromFile: boolean;
  fileName: string | null;
  maps: MapReport[];
  skipped: string[];
  /** 自動で取得したときの出どころ（出典の表記と取り直しのため） */
  sources: MojSource[];
  /** 読んだときの残す幅（m）。表示用 */
  bufferM?: number;
}

/**
 * 公図の自動取得（spec §17.3）の進み具合。
 * cities：市町村を当てている → choose：データセットを見せて同意を待つ → download：順に取得して読んでいる
 */
interface FetchRun {
  phase: "cities" | "choose" | "download";
  items: { muni: Municipality; dataset: MojDataset | null; error: string | null; done: boolean; kept: number }[];
  agreed: boolean;
  error: string | null;
  /** 取得して読んだ筆（複数の市町村を順に足す） */
  features: ParcelFeature[];
  maps: MapReport[];
  skipped: string[];
  sources: MojSource[];
}

const DEFAULT_NAME = "小川村 県道401号（見本）";
/** 公図から残す幅：区間の両側（m）の既定。前処理（tools/cut_parcels.py）と同じ。手順 2 で 500・1000 に広げられる（元の公図を広く見たいとき） */
const PARCEL_BUFFER_M = 200;
const BUFFER_KEY = "arukumae.parcelBuffer";

async function main() {
  const root = document.getElementById("app")!;
  buildLayout(root);

  const [section, parcelsFc, demoJudgments] = await Promise.all([loadSection(), loadParcels(), loadDemoJudgments()]);
  const demo: Demo = {
    coords: section.features[0].geometry.coordinates.map((c) => [c[0], c[1]] as LonLat),
    roadName: section.features[0].properties.road_name,
    parcels: parcelsFc.features as ParcelFeature[],
    judgments: demoJudgments,
  };
  const project = await loadInitialProject(demo);
  setZone(project.zone);

  const center = midpoint(project.centerline.coords);
  const map = createMap(document.getElementById("map")!, center);
  const dense = resample(project.centerline.coords.map((c) => toPlane(c)), 1);
  const normals = leftNormals(dense);
  const trackResult = computeTrack(dense, normals, project.track);
  const parcels = project.parcels ? project.parcels.features : project.centerline.source.kind === "demo" ? demo.parcels : [];
  const t0 = performance.now();
  const hits = findHits(parcels, trackResult.segments);
  console.info(`かかる筆 ${hits.length} 筆（${Math.round(performance.now() - t0)}ms）`);
  const judgments = new Map(project.judgments.map((j) => [j.segmentId, j]));

  const state: AppState = {
    map,
    step: project.centerline.source.kind === "demo" ? 3 : 1,
    demo,
    name: project.name || DEFAULT_NAME,
    roadName: project.roadName,
    centerline: project.centerline,
    zone: project.zone,
    dense,
    normals,
    track: project.track,
    trackResult,
    trackError: null,
    trackDraft: null,
    segments: trackResult.segments,
    segmentsGeo: applyJudgments(segmentsToGeoJSON(trackResult.segments), judgments),
    parcels,
    parcelById: new Map(parcels.map((p) => [p.properties.id, p])),
    hits,
    hitById: new Map(hits.map((h) => [h.parcelId, h])),
    judgments,
    unjudged: new Set(project.unjudged),
    selectedParcel: null,
    selectedSegment: null,
    lowCursor: -1,
    kps: project.kps,
    placingKp: false,
    placingTilt: null,
    drawing: null,
    osmPick: null,
    lineChoices: null,
    run: null,
    pdfRun: null,
    pdfError: null,
    forestIndex: null,
    forest: null,
    segForest: null,
    forestFlags: null,
    forestNote: "森林の区域を読んでいます…",
    parcelSource: project.parcels
      ? { fromFile: true, fileName: project.parcels.fileName, maps: project.parcels.maps, skipped: project.parcels.skipped, sources: project.parcels.sources ?? [] }
      : { fromFile: false, fileName: null, maps: [], skipped: [], sources: [] },
    parcelRun: null,
    parcelError: null,
    fetchRun: null,
    notes: new Map(project.notes.map((n) => [n.segmentId, n])),
    projectMsg: null,
    saveError: null,
    filter: { hits: "all", q: "", checks: "all" },
    photoYear: loadPhotoYear(),
    parcelBuffer: [200, 500, 1000].includes(Number(localStorage.getItem(BUFFER_KEY))) ? Number(localStorage.getItem(BUFFER_KEY)) : PARCEL_BUFFER_M,
  };

  // 開発のときだけ、ブラウザの console から地図と状態をさわれるようにする（確かめ用）
  if (import.meta.env.DEV) (window as unknown as { __arukumae: unknown }).__arukumae = { map, state, t0: performance.now(), walkMapInput, fieldMapInput, selectSegment, applyCenterline, currentProject };

  map.on("load", () => {
    addParcels(map, parcelsToGeoJSON(state.parcels), hitsToGeoJSON(state.hits));
    addSegments(map, state.segmentsGeo);
    addTrack(map, trackGeo(state));
    addSection(map, state.centerline.coords);
    addKps(map, kpsGeo(state));
    addDraft(map);
    for (const h of state.hits) map.setFeatureState({ source: "parcels", id: h.parcelId }, { hit: true });
    wireMapClicks(state);
    renderLegend(state);
    setPhotoYear(map, state.photoYear);
    map.fitBounds(bboxOfLonLat(state.centerline.coords) as LngLatBoundsLike, { padding: 80, duration: 0 });
  });

  showName(state);
  updateAttribution(state);
  loadForest(state);
  renderStep(state);
  renderList(state);
  renderChecks(state);
  wireSettings(state);
  wireFilters(state);
  showSaveState(state);
}

/* ---------- 案件の読み書き（この端末。core/store.ts） ---------- */

function demoProject(demo: Demo): ProjectFile {
  return buildProject({
    name: DEFAULT_NAME,
    roadName: demo.roadName,
    centerline: { coords: demo.coords, source: { kind: "demo" } },
    zone: 8,
    track: DEFAULT_TRACK,
    parcels: null,
    judgments: demo.judgments,
    kps: [],
    notes: [],
    unjudged: [],
  });
}

/**
 * 起動のときの案件：この端末に残したもの → 2026-11-03 までの古い形（別々の鍵）→ 見本、の順。
 * 残したものが壊れていれば見本に戻す（壊れた案件で画面が開かないよりよい。console に理由を残す）
 */
async function loadInitialProject(demo: Demo): Promise<ProjectFile> {
  const demoLine = { coords: demo.coords, roadName: demo.roadName };
  try {
    const stored = await loadStored();
    if (stored) return parseProject(JSON.stringify(stored), demoLine);
  } catch (e) {
    console.warn("この端末に残した案件を読めなかったので、見本に戻します", e);
  }
  const legacy = loadLegacy();
  if (legacy) {
    try {
      const judgments = Array.isArray(legacy.judgments) ? (legacy.judgments as Judgment[]) : demo.judgments;
      const saved = legacy.parcels as { fileName?: string; maps?: MapReport[]; skipped?: string[]; features?: ParcelFeature[] } | null;
      const p = parseProject(
        JSON.stringify({
          ...demoProject(demo),
          name: legacy.name || DEFAULT_NAME,
          track: legacyTrack(legacy.track) ?? DEFAULT_TRACK,
          parcels: saved?.features?.length ? { fileName: saved.fileName ?? "公図", maps: saved.maps ?? [], skipped: saved.skipped ?? [], features: saved.features } : null,
          judgments,
          kps: Array.isArray(legacy.kps) ? legacy.kps : [],
          notes: Array.isArray(legacy.notes) ? legacy.notes : [],
        }),
        demoLine,
      );
      await saveStored(p);
      clearLegacy();
      console.info("古い形の保存を 1 つの案件にまとめました");
      return p;
    } catch (e) {
      console.warn("古い形の保存を読めなかったので、見本に戻します", e);
    }
  }
  return demoProject(demo);
}

/** いまの状態を案件（ファイルと保存の形）にする */
function currentProject(state: AppState): ProjectFile {
  const s = state.parcelSource;
  return buildProject({
    name: state.name,
    roadName: state.roadName,
    centerline: state.centerline,
    zone: state.zone,
    track: state.track,
    parcels: s.fromFile ? { fileName: s.fileName ?? "", maps: s.maps, skipped: s.skipped, features: state.parcels, ...(s.sources.length ? { sources: s.sources } : {}) } : null,
    judgments: [...state.judgments.values()],
    kps: state.kps,
    notes: pruneNotes(state.notes),
    unjudged: [...state.unjudged],
  });
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();
let persistPending: AppState | null = null;

/**
 * この端末に残す。続けて何度も呼ばれるので少し待ってまとめ、書き込みは順に並べる。
 * 失敗したら（容量など）その旨を画面の上に出す。前に残したものは消えない（丸ごと書き換えるので、失敗なら古いまま）。
 * 画面が隠れる・閉じるときは待たずに書く（現地で × を押してすぐ端末を伏せ、タブが落ちても残るように。Claude の独立レビュー 2026-11-03）
 */
function persist(state: AppState) {
  persistPending = state;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => flushPersist(), 250);
}

function flushPersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const state = persistPending;
  persistPending = null;
  if (!state) return;
  const p = currentProject(state);
  // 読めるものしか書かない：書く前に案件ファイルと同じ検めを通す。通らないものを書くと、次に開いたとき見本に戻って判定が消える
  try {
    parseProject(JSON.stringify(p), { coords: state.demo.coords, roadName: state.demo.roadName });
  } catch (e) {
    state.saveError = `この端末に残せませんでした（保存の形が壊れています：${(e as Error).message}）。案件ファイルに保存してください`;
    console.error(e);
    showSaveState(state);
    return;
  }
  persistChain = persistChain.then(async () => {
    try {
      await saveStored(p);
      state.saveError = null;
    } catch (e) {
      state.saveError = `この端末に残せませんでした（${(e as Error).message}）。案件ファイルに保存してください`;
      console.warn(e);
    }
    showSaveState(state);
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPersist();
});
window.addEventListener("pagehide", flushPersist);

function showSaveState(state: AppState) {
  const el = document.getElementById("save-state")!;
  el.textContent = state.saveError ?? (state.centerline.source.kind === "demo" ? "見本のデータ。判定はこの端末に残ります" : "この端末に残しています");
  el.classList.toggle("err", !!state.saveError);
}

/**
 * 案件を丸ごと入れ替える（案件ファイルを読んだ・見本に戻した・中心線を決め直した）。
 * 系・中心線・区切り・かかる筆・森林・判定・距離標・記録・地図を全部作り直す
 */
function loadProject(state: AppState, p: ProjectFile) {
  setZone(p.zone);
  state.zone = p.zone;
  state.name = p.name || DEFAULT_NAME;
  state.roadName = p.roadName;
  state.centerline = p.centerline;
  state.dense = resample(p.centerline.coords.map((c) => toPlane(c)), 1);
  state.normals = leftNormals(state.dense);
  state.track = p.track;
  state.trackError = null;
  state.trackDraft = null;
  cancelRun(state);
  state.judgments = new Map(p.judgments.map((j) => [j.segmentId, j]));
  state.unjudged = new Set(p.unjudged);
  state.kps = p.kps;
  state.notes = new Map(p.notes.map((n) => [n.segmentId, n]));
  state.lowCursor = -1;
  state.drawing = null;
  state.osmPick = null;
  state.lineChoices = null;
  state.placingKp = false;
  state.placingTilt = null;
  state.map.getCanvas().style.cursor = "";
  state.parcelError = null;
  state.fetchRun = null;
  state.forestIndex = null;
  state.forest = null;
  state.segForest = null;
  state.forestFlags = null;
  state.forestNote = "森林の区域を読んでいます…";
  showName(state);
  setSection(state.map, p.centerline.coords);
  setDraft(state.map, null, []);
  const demo = p.centerline.source.kind === "demo";
  if (p.parcels) {
    state.parcelSource = { fromFile: true, fileName: p.parcels.fileName, maps: p.parcels.maps, skipped: p.parcels.skipped, sources: p.parcels.sources ?? [] };
    applyParcels(state, p.parcels.features);
  } else {
    state.parcelSource = { fromFile: false, fileName: null, maps: [], skipped: [], sources: [] };
    applyParcels(state, demo ? state.demo.parcels : []);
  }
  updateAttribution(state);
  // applyParcels → rebuildTrack が区切り・かかる筆・一覧・手順を作り直す。距離標は別の源なのでここで
  refreshKps(state);
  loadForest(state);
  showSaveState(state);
  persist(state);
  if (state.map.getSource("section")) state.map.fitBounds(bboxOfLonLat(p.centerline.coords) as LngLatBoundsLike, { padding: { top: 60, bottom: 60, left: leftCover() + 40, right: rightCover() + 40 }, duration: 600 });
}

/** 起立の区間は「起点から何 m」で持つので、中心線が変われば（反転でも）合わなくなる。消す */
function stripZones(t: TrackSetting): TrackSetting {
  return t.source.kind === "vehicle" && t.source.tiltZones.length ? { ...t, source: { ...t.source, tiltZones: [] } } : t;
}

/** 出典の表記（地図の右下）。公図の市町村はいまの案件から */
function updateAttribution(state: AppState) {
  const demo = !state.parcelSource.fromFile && state.centerline.source.kind === "demo";
  const parcels = state.parcelSource.fromFile ? { fileName: "", maps: state.parcelSource.maps, skipped: [], features: [] } : null;
  const text = mojAttribution(parcels, demo);
  const url = demo ? DEMO_MOJ.url : (state.parcelSource.sources[0]?.datasetUrl ?? null);
  setAttribution(state.map, { text, url });
}

/**
 * 中心線を決め直す（spec §17.2）。区切り・かかる筆・判定・距離標・記録は作り直し。
 * 公図は、向きを反転しただけなら残す。それ以外は見本なら見本の筆、ほかは空（取得し直す）。
 * 判定や記録があれば、消える前に確かめる（案件ファイルに保存する手もある）
 */
function applyCenterline(state: AppState, coords: LonLat[], roadName: string, source: CenterlineSource, opt: { keepParcels?: boolean; track?: TrackSetting } = {}): boolean {
  const clean = dedupe(coords);
  const bad = validateCenterline(clean);
  if (bad) {
    alert(`この線は中心線にできません：${bad}`);
    return false;
  }
  const zones = state.track.source.kind === "vehicle" ? state.track.source.tiltZones.length : 0;
  const lost = [state.judgments.size ? `判定 ${state.judgments.size}` : "", state.kps.length ? `距離標 ${state.kps.length}` : "", state.notes.size ? `現地の記録 ${state.notes.size}` : "", zones ? `起立の区間 ${zones}` : ""].filter(Boolean);
  if (lost.length && !confirm(`中心線を変えると、${lost.join("・")}は消えます（起点からの距離と区切りの番号が変わるため）。続けますか？\n残したいなら、先に「案件を保存する（JSON）」で案件ファイルにしてください。`)) return false;
  cancelRun(state); // 区切りが変わるので、走っている判定の答えは捨てる
  const demo = source.kind === "demo";
  const zone = zoneOf(midpoint(clean));
  showBusy("中心線を決め直しています。区切りとかかる筆を作り直すのに数秒かかります…");
  const s = state.parcelSource;
  const parcels = opt.keepParcels && s.fromFile ? { fileName: s.fileName ?? "", maps: s.maps, skipped: s.skipped, features: state.parcels, ...(s.sources.length ? { sources: s.sources } : {}) } : null;
  const p = buildProject({
    name: demo ? DEFAULT_NAME : state.name === DEFAULT_NAME ? roadName || "新しい案件" : state.name,
    roadName,
    centerline: { coords: clean, source },
    zone,
    track: stripZones(opt.track ?? (state.track.source.kind === "file" && !opt.keepParcels ? { ...state.track, source: { kind: "vehicle", preset: "lifter", vehicle: { ...PRESETS.lifter.vehicle }, tiltZones: [] } } : state.track)),
    parcels,
    judgments: demo ? state.demo.judgments : [],
    kps: [],
    notes: [],
    unjudged: [],
  });
  loadProject(state, p);
  state.projectMsg = { text: `中心線を決めました：${describeCenterline(p.centerline)}（約 ${Math.round(lengthM(clean))}m、${zoneLabel(zone)}）`, error: false };
  state.step = 1;
  renderStep(state);
  return true;
}

const HELP = {
  band: "伐採範囲：掃く範囲（軌跡図、または車両の寸法から計算した架空の軌跡図）に余裕幅を足し、そのさらに外へ伐採の幅を足したもの。道路の端（中心線から道路の半幅）より外の部分だけを区切りにします。手順 2 で決め方を変えられます。",
  segment: "区切り：伐採範囲を道に沿って 10m ごと、左右別に分けたもの。番号 L032 は「起点から 320〜330m の左」。この1つずつについて、木の有無を航空写真から判定します。",
  judged: "判定が付いている区切りの数。見本として最初から入っている Claude の判定、この道具から Claude に判定させたもの、人が直したものを合わせた数です。",
  check: "確かめる所：(1) Claude の確信が「低」だった区切り（写真がぼやける・影で見えない・枠の位置が読みにくい、など）と、(2) 森林の区域（林野庁）と判定が食い違う区切り（区域の中なのに木が 25% 以下、区域の外なのに木が 75% 以上。区域の縁から 15m 以内は指摘しない）、(3) 別の年の写真と比べて変化があった区切り、(4) 上位のモデルの見直しで木の割合が 50 ポイント以上変わった区切り（2 つのモデルが割れた所）、(5) Claude の答えに番号がなく未判定のままの区切り。現地で見る候補として一覧に並べています。",
  review: "見直し：最初のモデル（Sonnet）の確信が低かった区切りだけ、上位のモデル（Fable）に同じ写真をもう一度見せます。最初の判定は見せません（引きずられないように）。",
  kp: "KP（キロポスト）：道路管理者が決めた、その道路の起点からの距離（km）。道ばたの距離標に書いてあります。位置も値も公開データに無いので、現地やストリートビューで人が読んだ距離標を 2 本以上置くと、その間を中心線に沿って直線で補間します。「起点からの距離（m）」はこの案件の区間の起点から測ったもので、KP とは別の物差しです。",
  forest: "森林の区域：林野庁の「森林計画対象森林レイヤ」（地域森林計画の対象の民有林と国有林の区域、林班）。筆のかかる部分がこの区域にどれだけ入るかを測り、半分未満なら「一部」と書きます。伐採の届出が要るかどうかは、登記の地目ではなく、この民有林の区域かどうかで決まるとされています（自分の理解。森林法第10条の8）。道具は目印を付けるまでで、要否は所管の市町村に確かめてください。区域の線は 1/5,000 相当で、筆の境界とはふつうずれます。",
  walkmap: "持って歩く地図：A4 の PDF。1 ページ目が区間全体の索引図、2 ページ目からは起点から約 200m ずつ（木の判定の窓と同じ分け方）。航空写真の上に掃く範囲・伐採範囲・筆と地番・区切り（判定の色と番号）・起点からの距離と KP を重ね、下に「現地で確かめる所」と現地の記録のある区切りの表と、○×・メモを手で書く欄を付けます。文字も絵として入れているので、PDF の中の文字は検索できません。",
  tiltZone: "起立の区間：ブレードを立てられる所と角度を、場所ごとに決めます。電線をくぐる所や橋の下では立てられないので、全部の曲がりで立てるとは限りません。区間はブレードの根元がいる位置で見ます。区間の外は基本の角度（既定は 0°＝寝かせる。広めに出るので安全側）。",
  vehicle: "追従の計算：前軸が中心線をたどり、キングピンと台車の軸がそれを追います（引かれる点はいつも引く点の真後ろ）。曲がりでは台車が内側に切れ込み、ブレードは内側を弦のように横切り、先は外へ振れます。多軸台車は後輪も操舵するので、実際の切れ込みはこれより小さいことが多く、ここでは広め（安全側）に出ます。高さは見ません。",
  notes:
    "現地の記録：持ち運びモード。現地で区切りを見て、○（判定どおり）・△（分からない）・×（違う）とメモを残します。判定そのものは変えず、記録として一覧表の列・現地マップの吹き出し・持って歩く地図の表に出ます。× の所は帰ってから「この区切りを直す」で直します。記録はこの端末に残ります。",
  buylist:
    "公図を買うリスト：かかる筆の所在・地番だけを並べた控え。登記情報提供サービスで公図や登記事項を 1 件ずつ取るとき（1 件 360 円ほど）の、取る順と抜けの確認用。同じ所在・地番は 1 行にまとめます。「購入」「備考」の列は空で、Excel で記入する欄です。",
  fieldmap:
    "現地マップ：この道具の結果を KML（Google Earth など）や GeoJSON（QGIS など）で持ち出すもの。かかる筆はかかる部分の形、区切りは判定の色（白 0% → 黄 25% → 橙 50% → 赤 75〜100%）、確かめる所は赤い印。押すと所在・地番・面積・KP・判定の理由が吹き出しで出ます。航空写真は入っていません（Google Earth の写真の上に重ねます）。座標は端末の中で作るだけで、外へは送りません。",
  mojxml:
    "地図XML：法務省が無料で公開している公図の電子データ（登記所備付地図データ）の形式。G空間情報センターから市町村ごとの zip で配られ、中に地図ごとの zip と XML が入っています。公共座標系の地図はそのまま重なります。任意座標系の地図（筆の半分以上がこれ）は図面の中だけの座標なので、位置を合わせないと重なりません。この道具はまだ位置合わせに対応していないので、読み飛ばして枚数だけ伝えます。",
  mojfetch:
    "公図の自動取得：中心線と、その両側 200m の点（100m ごと）がどの市町村にあるかを OpenStreetMap の行政境界で当て、G空間情報センターの検索（CKAN API）でその市町村の「登記所備付地図データ」のいちばん新しい年版を探します。zip の名前が市区町村コードで始まることを確かめてから（同名の町村を取り違えないため）、利用規約（法務省）への同意のあとで取得し、区間の両側 200m の筆だけを残します。取得先は G空間情報センター（法務省のデータ）で、ファイルはこの端末の外へ出しません。",
  project:
    "案件ファイル：この端末に残しているもの（案件名・道路名・中心線・伐採範囲の決め方・読み込んだ公図の筆・判定・距離標・現地の記録）を 1 つの JSON にまとめたもの。事務所の PC で判定して保存し、iPad に送って読み込めば続きができます。現地で記録したら、また保存して PC に戻します。軌跡図の座標が入るので、利用者の手元に置くファイルです。道具が外へ送ることはありません。",
  centerline:
    "中心線：輸送路の区間の線。起点（0m）から終点へ、点の順が運ぶ向きです。区切りの番号・起点からの距離・架空の軌跡図はこの線から作ります。出どころは 3 つ：運送会社の軌跡図（KML）の中の線を選ぶ、OpenStreetMap の道路を地図でたどる、航空写真の上に手で描く。中心線を変えると、区切りの番号が変わるので判定・距離標・記録は作り直しです。",
  osm:
    "OpenStreetMap の道路をたどる：地図で起点と終点を押すと、周りの道路（highway）を Overpass API から取り、つながりをたどって最短の道を引きます。軌跡図が届く前に、車両の寸法から架空の軌跡図で下調べするための中心線です。道路名は OSM の name・ref から（参考）。OSM にない私道や新設の道は「手で描く」で。出典：© OpenStreetMap contributors（ODbL）。",
  kind: "種類：公図の地番の頭で分けたもの。「道」「水」は地番のない道路・水路、「無地番」は地番のない土地、「筆界未定地」は境界の決まっていない所、「一般」は地番のついたふつうの土地です。地目（宅地・田・山林など）は公図に入っていないので、ここでは分かりません。",
  photoYear:
    "写真の年：国土地理院の年度別写真（2007 年以降）を最新写真の上に重ねます。ある年と場所は限られ、無い所は下の最新写真が透けて見えます。小川村の見本の範囲は 2022 年度だけで、最新写真と同じ写真です（2026-11-02 に確かめた）。木を判定するときに「別の年の写真も一緒に見せる」のは、右上の「設定」で選びます。",
  earth:
    "Google Earth で見る：別の窓で Google Earth（ウェブ）をこの場所で開きます。過去の写真は Google Earth の「履歴」で見られます。人が見るためのリンクで、道具は Google の画像を取り込みません。Google の地図の規約は、画像を解析したり機械に読ませたりすることを認めていないためです（自分の理解）。",
  change:
    "変化：別の年の写真と比べて Claude が「木が減った」「造成や建物の変化」などと見た区切り。もう切られている、太陽光になっている、といった手がかりになります。現地で確かめる所に入ります。",
  filter: "絞り込み：一覧だけを絞ります。地図はそのままです（行を押せば地図が飛びます）。地番・所在の文字での検索は、種類と重ねられます。",
  mapName:
    "地図の名前：法務省の地図XML のファイル名（市区町村コード-法務局の番号-通し番号）。この道具は中心線の周りの筆しか残していないので、周りを広く見たいときは、取得したデータセットの zip の中にあるこの名前の XML（または手順 2 で「残す幅」を 500〜1000m にして取り直す）を見ます。",
  fix: "直す：Claude の判定を人の目で直します。直した区切りは「人」と記録され、地図では青い枠、一覧表では「決めたのは：人」になります。元に戻すこともできます。「全部を判定し直す」でも人が直した区切りは上書きしません。",
};

/* ---------- 手順 ---------- */

let renderedStep = 0;

function renderStep(state: AppState) {
  renderSteps(state.step, (n) => {
    state.step = n;
    renderStep(state);
  });
  const s = STEPS[state.step - 1];
  const body = document.getElementById("step-body")!;
  // 手順が変わったときだけ上に戻す（同じ手順の描き直しでは、読んでいた所を保つ）。
  // 前の手順で下まで送っていると、次の手順が途中（余裕幅の欄など）から見えて「それが先頭」に見えた（2026-11-04）
  const changed = renderedStep !== state.step;
  renderedStep = state.step;
  const parts: string[] = [`<h3>${s.n}. ${s.title}</h3><p>${s.hint}</p>`];
  switch (state.step) {
    case 1:
      parts.push(renderProjectStep(state));
      break;
    case 2:
      parts.push(renderTrackStep(state));
      break;
    case 3: {
      const kinds = countKinds(state);
      if (!state.parcels.length) parts.push(`<p class="err">公図がまだありません。手順 2 で公図を取得するか、地図XML の zip を落としてください。</p>`);
      parts.push(tiles([{ label: "かかる筆", value: state.hits.length, unit: "筆" }, { label: "うち民有林の区域", value: state.forest ? forestCount(state).minyu : "…", unit: state.forest ? "筆" : "", tone: "ok" }, { label: "区切り", value: state.segments.length }]));
      parts.push(`<p>伐採範囲 ${help(HELP.band)} にかかる筆（${kinds}）。濃い黄色がかかる部分。一覧の行を押すと地図が飛びます。</p>`);
      parts.push(`<div class="actions"><button class="btn primary next" data-go="4">次へ：木を判定する</button></div>`);
      parts.push(about(
        `<p>${forestSummary(state)} ${help(HELP.forest)}</p>`,
        `<p>漏れを出さないため、ここは AI ではなく計算で決めています。筆を丸ごと塗らず、伐採範囲と重なる部分だけを塗ります。「地区外」「別図」は隣の地図を指す印なので数えていません。</p>`,
      ));
      showListTab("hits");
      break;
    }
    case 4:
      parts.push(renderJudgeStep(state));
      break;
    case 5: {
      const lows = checkList(state);
      const reviewed = [...state.judgments.values()].filter((j) => j.before);
      const forestN = lows.filter((c) => c.kind === "森林").length;
      const changeN = lows.filter((c) => c.kind === "変化").length;
      const gapN = lows.filter((c) => c.kind === "食い違い").length;
      const noneN = lows.filter((c) => c.kind === "未判定").length;
      const seen = countNotes(state.notes, lows.map((l) => l.segmentId));
      parts.push(tiles([{ label: "確かめる所", value: lows.length, tone: "warn" }, { label: "現地で見た", value: seen.checksDone, unit: `/ ${lows.length}` }, { label: "現地 ×", value: seen.byResult["×"], tone: seen.byResult["×"] ? "warn" : undefined }]));
      parts.push(`<p>確かめる所 ${help(HELP.check)}：確信が低い ${lows.length - forestN - changeN - noneN - gapN}・森林と食い違う ${forestN}${changeN ? `・変化 ${changeN}` : ""}${gapN ? `・見直しで割れた ${gapN}` : ""}${noneN ? `・未判定 ${noneN}` : ""}。一覧の行か「次 →」で順に見ます。</p>`);
      // 前へ・次へは、一覧で絞り込んだ中を回る。現地で「まだ見ていない所」だけを順に回れるように
      const vis = visibleChecks(state);
      const narrowed = vis.length !== lows.length ? `（絞り込み ${help(HELP.filter)}）` : "";
      const pos = state.lowCursor >= 0 && state.lowCursor < vis.length ? `${state.lowCursor + 1} / ${vis.length}${narrowed}` : `— / ${vis.length}${narrowed}`;
      parts.push(`<div class="nav"><button class="btn" data-prev-low ${vis.length ? "" : "disabled"}>← 前</button><span class="pos">${pos}</span><button class="btn" data-next-low ${vis.length ? "" : "disabled"}>次 →</button></div>`);
      {
        const c = countNotes(state.notes, lows.map((l) => l.segmentId));
        if (c.total) parts.push(`<div class="row btns"><button class="btn small ghost" data-clear-notes>現地の記録を全部消す（${c.total} 件）</button></div>`);
      }
      parts.push(`<div class="actions"><button class="btn primary next" data-go="6">次へ：KP</button></div>`);
      parts.push(about(
        `<p>確かめる所は 5 種類：Claude の確信が「低」、森林の区域（林野庁）と判定が食い違う、別の年の写真と比べて変化があった ${help(HELP.change)}、見直しで木の割合が ${REVIEW_GAP} ポイント以上変わった（最初と上位のモデルで割れた）、答えに番号がなく未判定。${reviewed.length ? `うち ${reviewed.length} 区切りは上位のモデルが見直し済み ${help(HELP.review)}。` : ""}</p>`,
        `<p>机で直すなら区切りの詳細の「この区切りを直す」。現地で見たことは「現地の記録」（○△×とメモ） ${help(HELP.notes)}。× の区切りは帰ってから直します。</p>`,
      ));
      showListTab("checks");
      break;
    }
    case 6: {
      const marks = [...state.kps].sort((a, b) => a.atM - b.atM);
      parts.push(`<p>距離標 ${help(HELP.kp)} を 2 本以上置くと、全部の区切りと筆に KP（推定）が付きます。</p>`);
      parts.push(
        `<div class="actions"><button class="btn ${state.placingKp ? "" : "primary"}" data-place-kp>${state.placingKp ? "やめる（地図を押すと距離標が入ります）" : "地図を押して距離標を置く"}</button></div>`,
      );
      if (marks.length) {
        parts.push(
          `<table class="list kps"><thead><tr><th>起点から m</th><th>KP（km）</th><th></th></tr></thead><tbody>` +
            marks.map((m, i) => `<tr><td class="num">${m.atM}</td><td class="num">${fmtKm(m.kp)}</td><td><button class="btn small" data-del-kp="${i}">消す</button></td></tr>`).join("") +
            `</tbody></table>`,
        );
      } else {
        parts.push(`<p class="muted small">まだ 1 本も置いていません。</p>`);
      }
      if (marks.length >= 2) {
        const a = estimateKp(marks, 0)!;
        const b = estimateKp(marks, state.dense.length - 1)!;
        parts.push(`<div class="next">起点 ${fmtKm(a.kp)}km → 終点 ${fmtKm(b.kp)}km（推定）。距離標の外側は外挿です。</div>`);
      } else if (marks.length === 1) {
        parts.push(`<div class="next">あと 1 本置くと、補間できます。</div>`);
      }
      parts.push(`<div class="actions"><button class="btn next" data-go="7">次へ：書き出し</button></div>`);
      parts.push(about(
        `<p>地図を押して置いた所を中心線に投影し、距離標の間を直線で補間します。外側は外挿と書きます。「${escapeHtml(state.roadName || "道路名")} ○.○○km 付近（推定）」の形で一覧と書き出しに出ます。</p>`,
        `<p>ストリートビューは人が見て読むだけにしています（画像を取り込んだり Claude に読ませたりはしません）。距離標と実際の距離は改築などでずれていることがあります。</p>`,
      ));
      break;
    }
    case 7: {
      const noKp = state.kps.length < 2;
      const judged = state.judgments.size;
      parts.push(tiles([{ label: "一覧表の行（筆）", value: state.hits.length }, { label: "判定のない区切り", value: state.segments.length - judged, tone: judged < state.segments.length ? "warn" : "ok" }, { label: "距離標", value: state.kps.length, unit: "本", tone: noKp ? "warn" : "ok" }]));
      parts.push(`<p>${noKp ? "距離標が 2 本未満なので KP の列は空になります。" : ""}${judged < state.segments.length ? `判定のない区切りの分の木の面積は数えません。` : ""}</p>`);
      parts.push(`<h4>一覧表（Excel）</h4>`);
      parts.push(`<div class="actions"><button class="btn primary" data-csv>一覧表を書き出す（CSV）</button><button class="btn" data-buy-csv>公図を買うリスト（CSV） ${help(HELP.buylist)}</button></div>`);
      parts.push(`<h4>現地マップ（Google Earth など） ${help(HELP.fieldmap)}</h4>`);
      parts.push(`<div class="row btns"><button class="btn" data-field="kml">KML</button><button class="btn" data-field="geojson">GeoJSON</button></div>`);
      parts.push(`<h4>持って歩く地図（PDF） ${help(HELP.walkmap)}</h4>`);
      if (state.pdfRun) {
        parts.push(`<div class="progress"><i style="width:${(100 * state.pdfRun.done) / state.pdfRun.total}%"></i></div><p class="small">${state.pdfRun.done} / ${state.pdfRun.total} ページを描いています…</p>`);
      } else {
        parts.push(`<div class="actions"><button class="btn" data-pdf>PDF（A4 ${walkMapPageCount(walkMapInput(state, false))} ページ）</button></div>`);
        parts.push(`<label class="row" style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" data-pdf-photo checked> 背景に航空写真を入れる</label>`);
        if (state.pdfError) parts.push(`<p class="small err">${escapeHtml(state.pdfError)}</p>`);
      }
      parts.push(about(
        `<p>一覧表の列：起点からの距離・左右・道路名と KP（推定）・根拠・所在・地番・種類・かかる面積・木のある面積（推定）・樹種の目安・木以外・確信・現地で確かめる所・現地の記録・決めたのは・森林の区域・伐採の届出の目印・備考。UTF-8（BOM）なので Excel がそのまま開けます。${state.forest ? "" : "森林の区域はまだ読めていないので空になります。"}</p>`,
        `<p>現地マップ：かかる筆（かかる部分の形と吹き出し）・区切り（判定の色）・確かめる所の印・中心線と 100m ごとの点・距離標・伐採範囲の外側。iPad の Google Earth に入れると、現地を歩くときの地図になります。</p>`,
        `<p>持って歩く地図：索引図＋約 200m ずつのページ。航空写真を外すと線と色だけになります。</p>`,
      ));
      showListTab("hits");
      break;
    }
  }
  body.innerHTML = parts.join("");
  if (changed) body.scrollTop = 0;
  if (state.step === 1) wireProjectStep(state, body);
  if (state.step === 2) wireTrackStep(state, body);
  body.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) =>
    b.addEventListener("click", () => {
      state.step = Number(b.dataset.go);
      renderStep(state);
    }),
  );
  body.querySelector("[data-next-low]")?.addEventListener("click", () => stepLow(state, 1));
  body.querySelector("[data-place-kp]")?.addEventListener("click", () => {
    state.placingKp = !state.placingKp;
    state.map.getCanvas().style.cursor = state.placingKp ? "crosshair" : "";
    renderStep(state);
  });
  body.querySelectorAll<HTMLButtonElement>("[data-del-kp]").forEach((b) =>
    b.addEventListener("click", () => {
      const marks = [...state.kps].sort((a, b) => a.atM - b.atM);
      marks.splice(Number(b.dataset.delKp), 1);
      state.kps = marks;
      refreshKps(state);
      renderStep(state);
    }),
  );
  const fileStem = () => (state.roadName || state.name).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 30) || "案件";
  body.querySelector("[data-csv]")?.addEventListener("click", () => {
    const rows = buildRows(state.hits, state.parcelById, state.judgments, state.kps, state.roadName, state.forest, state.forestFlags, state.segments, state.notes, state.unjudged);
    const day = new Date().toISOString().slice(0, 10);
    download(`arukumae_${fileStem()}_一覧表_${day}.csv`, toCsv(rows));
  });
  body.querySelector("[data-buy-csv]")?.addEventListener("click", () => {
    const rows = buildRows(state.hits, state.parcelById, state.judgments, state.kps, state.roadName, state.forest, state.forestFlags, state.segments, state.notes, state.unjudged);
    const day = new Date().toISOString().slice(0, 10);
    download(`arukumae_${fileStem()}_公図を買うリスト_${day}.csv`, toBuyCsv(buildBuyList(rows)));
  });
  body.querySelectorAll<HTMLButtonElement>("[data-field]").forEach((b) =>
    b.addEventListener("click", () => {
      const day = new Date().toISOString().slice(0, 10);
      const input = fieldMapInput(state, day);
      if (b.dataset.field === "kml") download(`arukumae_${fileStem()}_現地マップ_${day}.kml`, fieldKml(input), "application/vnd.google-earth.kml+xml");
      else download(`arukumae_${fileStem()}_現地マップ_${day}.geojson`, JSON.stringify(fieldGeoJSON(input)), "application/geo+json");
    }),
  );
  body.querySelector("[data-pdf]")?.addEventListener("click", () => {
    const withPhoto = (body.querySelector("[data-pdf-photo]") as HTMLInputElement | null)?.checked ?? true;
    exportWalkMap(state, withPhoto);
  });
  body.querySelector("[data-prev-low]")?.addEventListener("click", () => stepLow(state, -1));
  body.querySelector("[data-clear-notes]")?.addEventListener("click", () => {
    if (!confirm("現地の記録（○△×とメモ）を全部消します。よいですか？")) return;
    state.notes.clear();
    saveNotes(state);
    renderChecks(state);
    renderStep(state);
    if (state.selectedSegment) selectSegment(state, state.selectedSegment, false);
  });
  body.querySelector("[data-judge]")?.addEventListener("click", () => runJudging(state));
  body.querySelector("[data-cancel]")?.addEventListener("click", () => {
    if (state.run) state.run.cancel = true;
  });
  body.querySelector("[data-reset-demo]")?.addEventListener("click", () => {
    if (!confirm("判定を見本に戻します。この端末に残した判定は消えます。よいですか？")) return;
    state.judgments = new Map(state.demo.judgments.map((j) => [j.segmentId, j]));
    state.unjudged.clear();
    refreshJudgments(state);
    renderStep(state);
  });
}

/* ---------- 手順 1：案件（名前・中心線・案件ファイル） ---------- */

function renderProjectStep(state: AppState): string {
  const parts: string[] = [];
  const c = state.centerline;
  const demo = c.source.kind === "demo";
  parts.push(
    `<dl class="kv"><dt>案件名</dt><dd><input class="text" data-name value="${escapeHtml(state.name)}" maxlength="60" aria-label="案件名"></dd>` +
      `<dt>道路名</dt><dd><input class="text" data-road value="${escapeHtml(state.roadName)}" maxlength="40" placeholder="県道○○号 ○○線（参考）" aria-label="道路名"></dd>` +
      `<dt>中心線 ${help(HELP.centerline)}</dt><dd>${escapeHtml(describeCenterline(c))}<br><span class="muted small">約 ${state.dense.length - 1} m・${c.coords.length} 点・${zoneLabel(state.zone)}で計算</span></dd>` +
      `<dt>向き</dt><dd>地図の「起点 0m」→「終点」${demo ? "（南 → 北。見本の向きは固定。判定が向きに合わせて付いているため）" : ` <button class="btn small" type="button" data-reverse>反転する</button>`}</dd>` +
      `<dt>伐採範囲</dt><dd>${escapeHtml(describeTrack(state.track))} ${help(HELP.band)}</dd></dl>`,
  );
  if (state.projectMsg) parts.push(`<p class="small ${state.projectMsg.error ? "err" : ""}">${escapeHtml(state.projectMsg.text)}</p>`);

  // 中心線を決める：3 つの出どころ
  parts.push(`<details class="center" ${demo && !state.lineChoices && !state.drawing && !state.osmPick ? "" : "open"}><summary><b>自前の道で動かす：中心線を決める</b></summary>`);
  parts.push(`<p class="muted small">軌跡図の線を選ぶ／OpenStreetMap の道路をたどる／手で描く。中心線を変えると判定・距離標・記録は作り直し（先に案件ファイルへ保存できます）。</p>`);

  // (a) 軌跡図の KML から選ぶ
  parts.push(`<h4>(a) 軌跡図のファイルの線から選ぶ</h4>`);
  parts.push(`<div class="dropzone" data-center-drop>ここに軌跡図（KML・KMZ・GeoJSON）を落とす<br><input type="file" accept=".kml,.kmz,.geojson,.json" data-center-file></div>`);
  if (state.lineChoices) {
    const lc = state.lineChoices;
    parts.push(`<p class="small">「${escapeHtml(lc.file)}」の線 ${lc.choices.length} 本。中心線にする線を 1 つ選んでください（名前に「中心線」などがあれば選んであります）。残りの線は軌跡図として読みます。</p>`);
    parts.push(`<table class="list small"><thead><tr><th></th><th>名前</th><th class="num">長さ m</th><th class="num">点</th></tr></thead><tbody>`);
    lc.choices.forEach((ch, i) => {
      parts.push(`<tr><td><input type="radio" name="center-line" value="${i}" ${i === lc.picked ? "checked" : ""} ${ch.ring ? "disabled" : ""} aria-label="この線"></td><td>${escapeHtml(ch.name || "（名前なし）")}${ch.ring ? '<span class="muted small"> 多角形の縁</span>' : ""}</td><td class="num">${Math.round(ch.lengthM)}</td><td class="num">${ch.coords.length}</td></tr>`);
    });
    parts.push(`</tbody></table>`);
    parts.push(`<div class="row btns"><button class="btn primary" type="button" data-center-pick ${lc.picked < 0 ? "disabled" : ""}>この線を中心線にする</button><button class="btn" type="button" data-center-cancel>やめる</button></div>`);
  }

  // (b) OSM の道路をたどる
  parts.push(`<h4>(b) OpenStreetMap の道路をたどる ${help(HELP.osm)}</h4>`);
  const o = state.osmPick;
  if (!o) parts.push(`<div class="actions"><button class="btn" type="button" data-osm-start>地図を押して起点と終点を指す</button></div>`);
  else {
    const stage = o.busy ? "道路を取ってたどっています…" : !o.start ? "地図で<b>起点</b>を押してください" : !o.end ? `起点を置きました。次に<b>終点</b>を押してください` : o.result ? `道を引きました：約 ${Math.round(o.result.lengthM)}m${o.result.roadName ? `・${escapeHtml(o.result.roadName)}` : ""}` : "";
    parts.push(`<p class="small">${stage}</p>`);
    if (o.error) parts.push(`<p class="small err">${escapeHtml(o.error)}</p>`);
    parts.push(`<div class="row btns">${o.result ? `<button class="btn primary" type="button" data-osm-accept>この道を中心線にする</button>` : ""}<button class="btn" type="button" data-osm-cancel>${o.result || o.error ? "やり直す" : "やめる"}</button></div>`);
  }

  // (c) 手で描く
  parts.push(`<h4>(c) 航空写真の上に手で描く</h4>`);
  const d = state.drawing;
  if (!d) parts.push(`<div class="actions"><button class="btn" type="button" data-draw-start>地図を押して描く</button></div>`);
  else {
    parts.push(`<p class="small">地図を押すと点が増えます。${d.points.length} 点${d.points.length >= 2 ? `・約 ${Math.round(lengthM(d.points))}m` : ""}。起点から順に、終点まで押してください。</p>`);
    parts.push(`<div class="row btns"><button class="btn primary" type="button" data-draw-finish ${d.points.length >= 2 ? "" : "disabled"}>描き終える（中心線にする）</button><button class="btn" type="button" data-draw-undo ${d.points.length ? "" : "disabled"}>1 点戻す</button><button class="btn" type="button" data-draw-cancel>やめる</button></div>`);
  }
  parts.push(`</details>`);

  parts.push(`<h4>案件ファイル ${help(HELP.project)}</h4>`);
  parts.push(`<div class="row btns"><button class="btn" data-project-save>保存する（JSON）</button>${demo ? "" : `<button class="btn ghost" data-demo-reset>見本に戻す</button>`}</div>`);
  parts.push(`<div class="dropzone" data-project-drop>案件ファイル（.json）を落とすと、別の端末の続きができます<br><input type="file" accept=".json,application/json" data-project-file></div>`);
  parts.push(`<div class="actions"><button class="btn primary next" data-go="2">次へ：取り込み</button></div>`);
  parts.push(about(
    `<p>案件 = 名前・道路名・中心線・伐採範囲の決め方・公図の筆・判定・距離標・現地の記録。この端末に 1 つだけ残ります（置き換えは丸ごと書いてから古いものを消すので、途中で失敗しても前の案件が残ります）。</p>`,
    `<p>案件ファイルは、この端末に残しているものと同じ中身の JSON です。事務所の PC で判定して保存し、iPad に送って読み込めば続きができます。軌跡図の座標が入るので手元に置くファイルで、道具が外へ送ることはありません。</p>`,
    `<p>次の手順では、公図と軌跡図を取り込みます。公図は市町村から自動で取得できます（法務省の地図XML の zip を落としても構いません）。軌跡図は KML・KMZ・GeoJSON を落とすか、車両の寸法から架空のものを作ります。</p>`,
  ));
  return parts.join("");
}

function showName(state: AppState) {
  document.getElementById("project-name")!.textContent = state.name;
  document.title = `${state.name} — アルクマエ`;
}

function wireDrop(el: HTMLElement | null, onFile: (f: File) => void) {
  if (!el) return;
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}

function wireProjectStep(state: AppState, body: HTMLElement) {
  const name = body.querySelector<HTMLInputElement>("[data-name]");
  name?.addEventListener("change", () => {
    state.name = name.value.trim() || DEFAULT_NAME;
    name.value = state.name;
    showName(state);
    persist(state);
  });
  const road = body.querySelector<HTMLInputElement>("[data-road]");
  road?.addEventListener("change", () => {
    state.roadName = road.value.trim();
    persist(state);
    renderList(state);
  });
  body.querySelector("[data-reverse]")?.addEventListener("click", () => {
    applyCenterline(state, reversed(state.centerline.coords), state.roadName, state.centerline.source, { keepParcels: true, track: state.track });
  });
  body.querySelector("[data-project-save]")?.addEventListener("click", () => saveProjectFile(state));
  const input = body.querySelector<HTMLInputElement>("[data-project-file]");
  input?.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) readProjectFile(state, f);
  });
  wireDrop(body.querySelector<HTMLElement>("[data-project-drop]"), (f) => readProjectFile(state, f));
  body.querySelector("[data-demo-reset]")?.addEventListener("click", () => resetToDemo(state));

  // (a) 軌跡図の線から選ぶ
  const cf = body.querySelector<HTMLInputElement>("[data-center-file]");
  cf?.addEventListener("change", () => {
    const f = cf.files?.[0];
    if (f) readCenterFile(state, f);
  });
  wireDrop(body.querySelector<HTMLElement>("[data-center-drop]"), (f) => readCenterFile(state, f));
  body.querySelectorAll<HTMLInputElement>('input[name="center-line"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (state.lineChoices) state.lineChoices.picked = Number(r.value);
      renderStep(state);
    }),
  );
  body.querySelector("[data-center-pick]")?.addEventListener("click", () => {
    const lc = state.lineChoices;
    if (!lc || lc.picked < 0) return;
    const chosen = lc.choices[lc.picked];
    const rest = lc.choices.filter((_, i) => i !== lc.picked).map((ch) => ch.coords);
    const roadName = roadNameFromLine(chosen.name) || state.roadName;
    // 残りの線（外側線・内側線・多角形）は軌跡図として読む（spec §17.2 の (a)）。無ければ架空の軌跡図（既定の車両）
    const track: TrackSetting = rest.length ? { ...state.track, source: { kind: "file", name: lc.file, lines: rest } } : { ...state.track, source: { kind: "vehicle", preset: "lifter", vehicle: { ...PRESETS.lifter.vehicle }, tiltZones: [] } };
    applyCenterline(state, chosen.coords, roadName, { kind: "kml", file: lc.file, line: chosen.name }, { track });
  });
  body.querySelector("[data-center-cancel]")?.addEventListener("click", () => {
    state.lineChoices = null;
    renderStep(state);
  });

  // (b) OSM
  body.querySelector("[data-osm-start]")?.addEventListener("click", () => {
    stopMapModes(state);
    state.osmPick = { start: null, end: null, busy: false, error: null, result: null };
    state.map.getCanvas().style.cursor = "crosshair";
    renderStep(state);
  });
  body.querySelector("[data-osm-cancel]")?.addEventListener("click", () => {
    stopMapModes(state);
    renderStep(state);
  });
  body.querySelector("[data-osm-accept]")?.addEventListener("click", () => {
    const r = state.osmPick?.result;
    if (!r) return;
    const ok = applyCenterline(state, r.coords, r.roadName, { kind: "osm", wayIds: r.wayIds, fetchedAt: new Date().toISOString().slice(0, 10) });
    if (!ok) return;
  });

  // (c) 手で描く
  body.querySelector("[data-draw-start]")?.addEventListener("click", () => {
    stopMapModes(state);
    state.drawing = { points: [] };
    state.map.getCanvas().style.cursor = "crosshair";
    renderStep(state);
  });
  body.querySelector("[data-draw-undo]")?.addEventListener("click", () => {
    state.drawing?.points.pop();
    showDraft(state);
    renderStep(state);
  });
  body.querySelector("[data-draw-cancel]")?.addEventListener("click", () => {
    stopMapModes(state);
    renderStep(state);
  });
  body.querySelector("[data-draw-finish]")?.addEventListener("click", () => {
    const pts = state.drawing?.points ?? [];
    if (pts.length < 2) return;
    applyCenterline(state, pts, state.roadName, { kind: "drawn" });
  });
}

/** 地図を押して何かをする最中のものを全部やめる（描く・OSM・距離標・起立の区間） */
function stopMapModes(state: AppState) {
  state.drawing = null;
  state.osmPick = null;
  state.placingKp = false;
  state.placingTilt = null;
  state.map.getCanvas().style.cursor = "";
  setDraft(state.map, null, []);
}

/** 下書き（描いている線・OSM の起点終点と結果）を地図に出す */
function showDraft(state: AppState) {
  if (state.drawing) {
    const pts = state.drawing.points;
    setDraft(state.map, pts, pts.map((p, i) => ({ coords: p, label: i === 0 ? "起点" : i === pts.length - 1 ? "終点" : "" })));
  } else if (state.osmPick) {
    const o = state.osmPick;
    const points = [o.start ? { coords: o.start, label: "起点" } : null, o.end ? { coords: o.end, label: "終点" } : null].filter((x): x is { coords: LonLat; label: string } => !!x);
    setDraft(state.map, o.result?.coords ?? null, points);
  } else setDraft(state.map, null, []);
}

async function readCenterFile(state: AppState, f: File) {
  try {
    const lines = parseNamedBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    if (!lines.length) throw new Error(`${f.name} に線や多角形がありません`);
    const choices = lineChoices(lines);
    state.lineChoices = { file: f.name, choices, picked: pickCenterline(choices) };
    state.projectMsg = null;
  } catch (e) {
    state.projectMsg = { text: `${f.name} を読めませんでした：${(e as Error).message}`, error: true };
  }
  renderStep(state);
}

/** 地図を押して OSM の起点・終点を指す。2 点そろったら道路を取ってたどる */
async function pickOsm(state: AppState, lonLat: LonLat) {
  const o = state.osmPick;
  if (!o || o.busy || o.result) return;
  if (!o.start) o.start = lonLat;
  else if (!o.end) o.end = lonLat;
  showDraft(state);
  renderStep(state);
  if (!o.start || !o.end) return;
  o.busy = true;
  o.error = null;
  state.map.getCanvas().style.cursor = "";
  renderStep(state);
  showBusy("OpenStreetMap から道路を取っています（混んでいると 1 分ほど）…");
  try {
    const ways = await fetchRoads(routeBbox(o.start, o.end));
    if (!ways.length) throw new Error("この辺りに OpenStreetMap の道路がありません。「手で描く」で引いてください");
    const g = buildGraph(ways);
    const a = snapToRoad(g, o.start);
    const b = snapToRoad(g, o.end);
    if (!a) throw new Error("起点の近く（100m 以内）に道路がありません。道路の上を押してください");
    if (!b) throw new Error("終点の近く（100m 以内）に道路がありません。道路の上を押してください");
    const path = shortestPath(g, a.node, b.node);
    if (!path) throw new Error("起点と終点が道路でつながっていません（取った範囲の外を通るのかもしれません）。「手で描く」で引いてください");
    o.result = { coords: path.coords, wayIds: path.wayIds, roadName: roadNameOf(g, path.wayIds), lengthM: path.lengthM };
  } catch (e) {
    o.error = (e as Error).message;
    o.start = null;
    o.end = null;
    state.map.getCanvas().style.cursor = "crosshair";
  } finally {
    o.busy = false;
    hideBusy();
    showDraft(state);
    renderStep(state);
  }
}

function drawPoint(state: AppState, lonLat: LonLat) {
  if (!state.drawing) return;
  state.drawing.points.push(lonLat);
  showDraft(state);
  renderStep(state);
}

function saveProjectFile(state: AppState) {
  const p = currentProject(state);
  const text = JSON.stringify(p);
  const day = new Date().toISOString().slice(0, 10);
  download(projectFileName(state.name, day), text, "application/json");
  state.projectMsg = { text: `保存しました（${(text.length / 1e6).toFixed(1)} MB）：${describeProject(p)}`, error: false };
  renderStep(state);
}

async function readProjectFile(state: AppState, f: File) {
  try {
    const p = parseProject(await f.text(), { coords: state.demo.coords, roadName: state.demo.roadName });
    loadProject(state, p);
    state.projectMsg = { text: `読み込みました：${describeProject(p)}`, error: false };
    state.step = 1;
    renderStep(state);
  } catch (e) {
    state.projectMsg = { text: `${f.name} を読めませんでした：${(e as Error).message}`, error: true };
    renderStep(state);
  }
}

/** 見本に戻す。いまの案件は消えるので、保存するか聞く（spec §17.1） */
function resetToDemo(state: AppState) {
  if (confirm("いまの案件を案件ファイル（JSON）に保存してから、見本に戻しますか？\n「OK」で保存してから戻す、「キャンセル」で保存せずに戻す")) saveProjectFile(state);
  else if (!confirm("保存せずに見本に戻します。いまの案件（中心線・公図・判定・記録）はこの端末から消えます。よいですか？")) return;
  loadProject(state, demoProject(state.demo));
  state.projectMsg = { text: "見本（小川村 県道401号）に戻しました", error: false };
  state.step = 1;
  renderStep(state);
}

/* ---------- 手順 2：伐採範囲の決め方（軌跡図・架空の軌跡図・仮の帯） ---------- */

/** 車両の寸法の入力欄。ふだん触るものを上に、細かい寸法は畳む */
const VEHICLE_FIELDS: { key: keyof Vehicle; label: string; unit: string; step: number; min: number; max: number; main?: boolean; lifterOnly?: boolean }[] = [
  { key: "bladeLength", label: "ブレードの長さ", unit: "m", step: 1, min: 10, max: 130, main: true },
  { key: "tilt", label: "立てる角度（基本）", unit: "°", step: 5, min: 0, max: 80, main: true, lifterOnly: true },
  { key: "bladeRootDia", label: "根元の直径", unit: "m", step: 0.5, min: 1, max: 8, main: true },
  { key: "kingpinToAxle", label: "キングピン→台車の軸", unit: "m", step: 1, min: 3, max: 60 },
  { key: "bladeRootAt", label: "根元の位置（キングピンから後ろ）", unit: "m", step: 1, min: -10, max: 40 },
  { key: "trailerWidth", label: "台車の幅", unit: "m", step: 0.1, min: 2, max: 5 },
  { key: "trailerTail", label: "台車の軸から後端", unit: "m", step: 0.5, min: 0, max: 20 },
  { key: "trailerFront", label: "台車の前のはみ出し", unit: "m", step: 0.5, min: 0, max: 6 },
  { key: "tractorWheelbase", label: "トラクタの軸距", unit: "m", step: 0.1, min: 2, max: 8 },
  { key: "tractorWidth", label: "トラクタの幅", unit: "m", step: 0.1, min: 2, max: 3.5 },
  { key: "tractorFront", label: "トラクタの前のはみ出し", unit: "m", step: 0.1, min: 0.5, max: 3 },
];

const BAND_FIELDS: { key: keyof typeof DEFAULT_BAND; label: string }[] = [
  { key: "marginStraight", label: "余裕幅（直線）" },
  { key: "marginCurve", label: "余裕幅（カーブ）" },
  { key: "cut", label: "伐採の幅（余裕幅の外へ）" },
  { key: "roadHalf", label: "道路の半幅" },
];

function numField(name: string, label: string, value: number, unit: string, step: number, min: number, max: number): string {
  return `<label class="field"><span>${label}（${unit}）</span><input type="number" name="${name}" value="${value}" step="${step}" min="${min}" max="${max}"></label>`;
}

function renderTrackStep(state: AppState): string {
  const t = state.track;
  const kind = state.trackDraft ?? t.source.kind; // 「ファイルを読む」を選んで、まだ読んでいない間は file の入口を出す
  const parts: string[] = [`<div class="track">`];
  parts.push(renderParcelStep(state));
  parts.push(`<h4>伐採範囲の決め方 ${help(HELP.band)}</h4>`);
  parts.push(
    `<select class="wide" data-track-kind>
      <option value="vehicle" ${kind === "vehicle" ? "selected" : ""}>架空の軌跡図を作る（車両の寸法から）</option>
      <option value="file" ${kind === "file" ? "selected" : ""}>軌跡図のファイルを読む（KML・GeoJSON）</option>
      <option value="band" ${kind === "band" ? "selected" : ""}>仮の帯（中心線から一定の幅）</option>
    </select>`,
  );
  parts.push(`<form data-track-form>`);
  if (t.source.kind === "vehicle" && kind === "vehicle") {
    const v = t.source.vehicle;
    const preset = t.source.preset;
    parts.push(
      `<label class="field"><span>車両の型</span></label><select class="wide" name="preset">${(Object.keys(PRESETS) as PresetId[])
        .map((k) => `<option value="${k}" ${k === preset ? "selected" : ""}>${PRESETS[k].name}</option>`)
        .join("")}</select>`,
    );
    parts.push(`<p class="muted small">${PRESETS[preset].note}</p>`);
    for (const f of VEHICLE_FIELDS.filter((f) => f.main && (!f.lifterOnly || preset === "lifter"))) parts.push(numField(f.key, f.label, v[f.key], f.unit, f.step, f.min, f.max));
    parts.push(
      `<p class="muted small">水平の投影 ${bladeHorizontal(v).toFixed(1)}m（長さ × cos 角度）。ブレードの先は台車の軸の ${(v.bladeRootAt + bladeHorizontal(v) - v.kingpinToAxle).toFixed(1)}m 後ろ。</p>`,
    );
    parts.push(`<details><summary>細かい寸法（台車・トラクタ）</summary>`);
    for (const f of VEHICLE_FIELDS.filter((f) => !f.main || (f.lifterOnly && preset !== "lifter"))) parts.push(numField(f.key, f.label, v[f.key], f.unit, f.step, f.min, f.max));
    parts.push(`</details>`);
    if (preset === "lifter") parts.push(renderTiltZones(state, t.source.tiltZones));
  } else if (kind === "file") {
    parts.push(`<div class="dropzone" data-drop>ここに軌跡図（KML・KMZ・GeoJSON）を落とす<br><input type="file" accept=".kml,.kmz,.geojson,.json" data-track-file></div>`);
    parts.push(`<p class="muted small">線と多角形の縁を全部読み、中心線に投影して左右の幅にします。座標はこの端末の外へ出しません。</p>`);
    if (t.source.kind === "file" && t.source.lines.length) parts.push(`<p>読んだ：<b>${escapeHtml(t.source.name)}</b>（線 ${t.source.lines.length} 本）</p>`);
    else if (state.trackDraft) parts.push(`<p class="muted small">まだ読んでいません。読むまでは前の範囲（${t.source.kind === "vehicle" ? "架空の軌跡図" : t.source.kind === "band" ? "仮の帯" : "前のファイル"}）のままです。</p>`);
  } else if (t.source.kind === "band") {
    parts.push(numField("halfWidth", "中心線から外側まで", t.source.halfWidth, "m", 1, 3, 60));
  }
  if (t.source.kind !== "band") {
    parts.push(`<details><summary>余裕幅と伐採の幅（直線 ${t.band.marginStraight}・カーブ ${t.band.marginCurve}・伐採 ${t.band.cut}m）</summary>`);
    for (const f of BAND_FIELDS) parts.push(numField(`band.${f.key}`, f.label, t.band[f.key], "m", 0.5, 0, 20));
    parts.push(`</details>`);
  } else {
    parts.push(numField("band.roadHalf", "道路の半幅", t.band.roadHalf, "m", 0.5, 0, 20));
  }
  parts.push(`<div class="actions"><button class="btn" type="submit">${kind === "vehicle" ? "架空の軌跡図を作る（数を変えたら）" : "この範囲で拾い直す"}</button></div>`);
  parts.push(`</form>`);

  // 結果
  const r = state.trackResult;
  const mx = sweepMax(r.sweep);
  const judged = state.judgments.size;
  parts.push(`<div class="result">`);
  if (state.trackError) parts.push(`<div class="err">${escapeHtml(state.trackError)}</div>`);
  parts.push(`いま：${escapeHtml(describeTrack(t))}<br>`);
  if (t.source.kind !== "band") parts.push(`掃く幅の最大：左 ${mx.left.toFixed(1)}m・右 ${mx.right.toFixed(1)}m<br>`);
  parts.push(`区切り ${r.segments.length}、かかる筆 <b>${state.hits.length}</b>`);
  if (judged) parts.push(`<br><span class="muted small">判定 ${judged} 区切りは残しています。範囲を変えたら手順 4 で判定し直すのが確実です。</span>`);
  parts.push(`</div>`);
  if (t.source.kind !== "band") parts.push(`<div class="row btns"><button class="btn small ghost" data-save-track="kml">軌跡を KML で保存</button><button class="btn small ghost" data-save-track="geojson">GeoJSON</button></div>`);
  parts.push(`<div class="actions"><button class="btn next" data-go="3">次へ：かかる筆を見る</button></div>`);
  parts.push(about(
    `<p>伐採範囲 = 掃く範囲（軌跡図、または車両の寸法から計算した架空の軌跡図）＋余裕幅（直線・カーブ）＋伐採の幅。道路の端（中心線から道路の半幅）より外の部分だけを区切りにします ${help(HELP.band)}。</p>`,
    `<p>架空の軌跡図は、前軸が中心線をたどり、キングピンと台車の軸がそれを追う計算です ${help(HELP.vehicle)}。多軸台車は後輪も操舵するので、実際の切れ込みはこれより小さいことが多く、ここでは広め（安全側）に出ます。本物の軌跡図は運送会社が専用のソフトで描きます。</p>`,
    `<p>起立の区間 ${help(HELP.tiltZone)}：ブレードを立てられる所と角度を場所ごとに決めます。電線をくぐる所では立てられません。</p>`,
  ));
  parts.push(`</div>`);
  return parts.join("");
}

function wireTrackStep(state: AppState, body: HTMLElement) {
  body.querySelector<HTMLSelectElement>("[data-track-kind]")?.addEventListener("change", (e) => {
    const kind = (e.target as HTMLSelectElement).value as TrackSetting["source"]["kind"];
    state.trackError = null;
    if (kind === "file") {
      // ファイルを読むまで state.track は置き換えない。空の lines で置き換えると、画面は前の計算結果のまま、
      // 案件ファイルには空の軌跡が入り、読み戻すと区切りが 0 になった（Codex の指摘 2026-11-04）
      state.trackDraft = "file";
      renderStep(state);
      return;
    }
    state.trackDraft = null;
    if (kind === "vehicle") state.track = { ...state.track, source: { kind, preset: "lifter", vehicle: { ...PRESETS.lifter.vehicle }, tiltZones: [] } };
    else state.track = { ...state.track, source: { kind, halfWidth: 13 } };
    rebuildTrack(state);
  });
  const form = body.querySelector<HTMLFormElement>("[data-track-form]");
  form?.querySelector<HTMLSelectElement>('select[name="preset"]')?.addEventListener("change", (e) => {
    const preset = (e.target as HTMLSelectElement).value as PresetId;
    const zones = state.track.source.kind === "vehicle" ? state.track.source.tiltZones : [];
    state.track = { ...state.track, source: { kind: "vehicle", preset, vehicle: { ...PRESETS[preset].vehicle }, tiltZones: zones } };
    rebuildTrack(state);
  });
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    // 筆の拾い直しに 1 秒ほどかかるので、押せたことが分かるようにボタンの字を変えてから計算する
    const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "計算中…";
    }
    const fd = new FormData(form);
    const num = (name: string, fallback: number) => {
      const v = Number(fd.get(name));
      return Number.isFinite(v) && fd.get(name) !== null && fd.get(name) !== "" ? v : fallback;
    };
    const band = { ...state.track.band };
    for (const f of BAND_FIELDS) band[f.key] = num(`band.${f.key}`, band[f.key]);
    let source = state.track.source;
    if (source.kind === "vehicle") {
      const vehicle = { ...source.vehicle };
      for (const f of VEHICLE_FIELDS) vehicle[f.key] = num(f.key, vehicle[f.key]);
      source = { ...source, vehicle };
    } else if (source.kind === "band") {
      source = { ...source, halfWidth: num("halfWidth", source.halfWidth) };
    }
    state.track = { source, band };
    state.trackError = null;
    rebuildTrack(state);
  });
  const fileInput = body.querySelector<HTMLInputElement>("[data-track-file]");
  fileInput?.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) readTrackFile(state, f);
  });
  wireDrop(body.querySelector<HTMLElement>("[data-drop]"), (f) => readTrackFile(state, f));
  wireTiltZones(state, body);
  wireParcelStep(state, body);
  body.querySelectorAll<HTMLButtonElement>("[data-save-track]").forEach((b) =>
    b.addEventListener("click", () => {
      const fc = trackGeoJSON(state.dense, state.normals, state.trackResult.sweep, state.trackResult.outer);
      const day = new Date().toISOString().slice(0, 10);
      const zones = state.track.source.kind === "vehicle" ? state.track.source.tiltZones : [];
      const zoneNote = zones.length ? `起立の区間：${zones.map((z) => `${z.fromM}〜${z.toM}m を ${z.tilt}°`).join("、")}。` : "";
      const road = state.roadName || state.name;
      const title = `${road} ${state.track.source.kind === "vehicle" ? "架空の軌跡図" : "軌跡"}（アルクマエ）`;
      const desc = `${describeTrack(state.track)}。${zoneNote}アルクマエで ${day} に作成。${state.track.source.kind === "vehicle" ? "車両の寸法と道路の中心線から計算した架空の軌跡図で、実在の輸送計画ではありません。" : ""}現地の確認なしに使わないでください。`;
      const stem = road.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 30) || "案件";
      if (b.dataset.saveTrack === "kml") download(`arukumae_${stem}_軌跡_${day}.kml`, trackKml(fc, title, desc), "application/vnd.google-earth.kml+xml");
      else download(`arukumae_${stem}_軌跡_${day}.geojson`, JSON.stringify({ ...fc, features: fc.features.filter((f) => f.properties.kind !== "tilt"), title, description: desc }), "application/geo+json");
    }),
  );
}

/** 起立の区間の表と、足す手段（数で入れる・地図を押す）。リフターのときだけ */
function renderTiltZones(state: AppState, zones: TiltZone[]): string {
  const sorted = [...zones].sort((a, b) => a.fromM - b.fromM);
  const placing = state.placingTilt;
  const parts: string[] = [`<h4>起立の区間 ${help(HELP.tiltZone)}</h4>`];
  if (sorted.length) {
    parts.push(
      `<table class="list kps"><thead><tr><th>起点から m</th><th>角度</th><th></th></tr></thead><tbody>` +
        sorted.map((z, i) => `<tr><td class="num">${z.fromM}〜${z.toM}</td><td class="num">${z.tilt}°</td><td><button type="button" class="btn small" data-del-tilt="${i}">消す</button></td></tr>`).join("") +
        `</tbody></table>`,
    );
  } else {
    parts.push(`<p class="muted small">まだありません。全区間を基本の角度（${state.track.source.kind === "vehicle" ? state.track.source.vehicle.tilt : 0}°）で運びます。</p>`);
  }
  parts.push(
    `<div class="zone-add"><input type="number" data-zone-from placeholder="から m" min="0" max="${state.dense.length - 1}" step="10"><span>〜</span><input type="number" data-zone-to placeholder="まで m" min="0" max="${state.dense.length - 1}" step="10"><input type="number" data-zone-tilt placeholder="角度 °" value="60" min="0" max="80" step="5"><button type="button" class="btn small" data-add-tilt>足す</button></div>`,
  );
  parts.push(
    `<div class="actions"><button type="button" class="btn small ${placing ? "" : "ghost"}" data-place-tilt>${placing ? (placing.fromM === null ? "やめる（地図で区間の始めを押してください）" : `やめる（始め ${placing.fromM}m。終わりを押してください）`) : "地図を押して区間を指す"}</button></div>`,
  );
  return parts.join("");
}

function wireTiltZones(state: AppState, body: HTMLElement) {
  if (state.track.source.kind !== "vehicle") return;
  const src = state.track.source;
  const setZones = (zones: TiltZone[]) => {
    state.track = { ...state.track, source: { ...src, tiltZones: zones } };
    rebuildTrack(state);
  };
  body.querySelectorAll<HTMLButtonElement>("[data-del-tilt]").forEach((b) =>
    b.addEventListener("click", () => {
      const sorted = [...src.tiltZones].sort((a, b) => a.fromM - b.fromM);
      sorted.splice(Number(b.dataset.delTilt), 1);
      setZones(sorted);
    }),
  );
  body.querySelector("[data-add-tilt]")?.addEventListener("click", () => {
    const from = Number(body.querySelector<HTMLInputElement>("[data-zone-from]")!.value);
    const to = Number(body.querySelector<HTMLInputElement>("[data-zone-to]")!.value);
    const tilt = Number(body.querySelector<HTMLInputElement>("[data-zone-tilt]")!.value);
    const z = normalizeZone(state, from, to, tilt);
    if (!z) return alert("「から」「まで」は起点からの距離（m）、角度は 0〜80 の数で入れてください");
    setZones(addZone(src.tiltZones, z));
  });
  body.querySelector("[data-place-tilt]")?.addEventListener("click", () => {
    const on = !state.placingTilt;
    stopMapModes(state);
    state.placingTilt = on ? { fromM: null } : null;
    state.map.getCanvas().style.cursor = on ? "crosshair" : "";
    renderStep(state);
  });
}

function normalizeZone(state: AppState, from: number, to: number, tilt: number): TiltZone | null {
  if (![from, to, tilt].every(Number.isFinite) || tilt < 0 || tilt > 80) return null;
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(state.dense.length - 1, Math.max(from, to));
  if (b - a < 1) return null;
  return { fromM: Math.round(a), toM: Math.round(b), tilt };
}

/** 重なる区間は新しいほうで上書きする（同じ所に 2 つの角度があると、どちらで計算したか分からなくなるため） */
function addZone(zones: TiltZone[], z: TiltZone): TiltZone[] {
  const out: TiltZone[] = [];
  for (const o of zones) {
    if (o.toM < z.fromM || o.fromM > z.toM) out.push(o);
    else {
      if (o.fromM < z.fromM) out.push({ ...o, toM: z.fromM - 1 });
      if (o.toM > z.toM) out.push({ ...o, fromM: z.toM + 1 });
    }
  }
  out.push(z);
  return out.sort((a, b) => a.fromM - b.fromM);
}

/** 地図を押して起立の区間を指す。1 点目が始め、2 点目が終わり。どちらも中心線に投影する */
function placeTilt(state: AppState, lonLat: [number, number]) {
  if (!state.placingTilt || state.track.source.kind !== "vehicle") return;
  const near = nearestOnLine(state.dense, toPlane(lonLat));
  if (near.dist > 60) return alert("中心線から離れすぎています（60m 以上）。道路の近くを押してください。");
  if (state.placingTilt.fromM === null) {
    state.placingTilt = { fromM: near.index };
    renderStep(state);
    return;
  }
  const raw = prompt(`起点から ${Math.min(state.placingTilt.fromM, near.index)}〜${Math.max(state.placingTilt.fromM, near.index)}m の間で、ブレードを何度に立てますか？（0〜80）`, "60");
  if (raw === null) return;
  const z = normalizeZone(state, state.placingTilt.fromM, near.index, Number(raw.replace(/[^\d.]/g, "")));
  if (!z) return alert("角度は 0〜80 の数で、区間は 1m 以上にしてください");
  state.placingTilt = null;
  state.map.getCanvas().style.cursor = "";
  state.track = { ...state.track, source: { ...state.track.source, tiltZones: addZone(state.track.source.tiltZones, z) } };
  rebuildTrack(state);
}

async function readTrackFile(state: AppState, f: File) {
  try {
    const lines = parseTrackBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    if (!lines.length) throw new Error(`${f.name} に線や多角形がありません`);
    state.track = { ...state.track, source: { kind: "file", name: f.name, lines } };
    state.trackError = null;
    state.trackDraft = null;
    rebuildTrack(state); // 覆いの確認（別の道の軌跡図かどうか）は rebuildTrackNow の中。計算が後回しなので、ここで結果は読めない
  } catch (e) {
    state.trackError = (e as Error).message;
    renderStep(state);
  }
}

/* ---------- 手順 2：公図（地図XML）の取り込み ---------- */

function parcelsToGeoJSON(parcels: ParcelFeature[]): FeatureCollection<Polygon> {
  return { type: "FeatureCollection", features: parcels };
}

function describeParcels(state: AppState): string {
  const s = state.parcelSource;
  const mapCount = new Set(state.parcels.map((p) => p.properties.map)).size;
  if (!s.fromFile) return state.centerline.source.kind === "demo" ? `小川村 2026年版（見本。地図 ${mapCount} 枚、区間の両側 ${PARCEL_BUFFER_M}m の筆 ${state.parcels.length}）` : "まだありません";
  const pub = s.maps.filter((m) => m.isPublic).length;
  const arb = s.maps.length - pub;
  const cities = [...new Set(s.maps.filter((m) => m.city).map((m) => m.city))];
  return `${s.fileName}${cities.length ? `（${cities.join("・")}）` : ""}：地図 ${s.maps.length} 枚（公共座標系 ${pub}${arb ? `・任意座標系 ${arb} は読み飛ばし` : ""}）、区間の両側 ${s.bufferM ?? PARCEL_BUFFER_M}m の筆 ${state.parcels.length}`;
}

function renderParcelStep(state: AppState): string {
  const s = state.parcelSource;
  const parts: string[] = [`<h4>公図（地図XML） ${help(HELP.mojxml)}</h4>`];
  parts.push(`<p>いま：${escapeHtml(describeParcels(state))}</p>`);
  const run = state.parcelRun;
  const fr = state.fetchRun;
  if (run) {
    const mb = (b: number) => (b / 1e6).toFixed(1);
    parts.push(`<div class="progress"><i style="width:${run.total ? (100 * run.bytes) / run.total : 0}%"></i></div>`);
    parts.push(`<p class="small">${escapeHtml(run.label)}… ${mb(run.bytes)} / ${run.total ? mb(run.total) : "?"} MB。地図 ${run.maps} 枚、区間の周りの筆 ${run.kept}${run.current ? `<br><span class="muted">${escapeHtml(run.current)}</span>` : ""}</p>`);
  } else if (fr) {
    parts.push(renderFetch(state, fr));
  } else {
    parts.push(`<div class="actions"><button class="btn primary" data-fetch-start>公図を自動で取得する</button></div>`);
    parts.push(`<label class="field"><span>残す幅（中心線の両側）</span><select name="parcelBuffer" data-parcel-buffer>${[200, 500, 1000].map((b) => `<option value="${b}" ${b === state.parcelBuffer ? "selected" : ""}>${b} m</option>`).join("")}</select></label>`);
    parts.push(`<div class="dropzone" data-parcel-drop>または、公図（地図XML の zip）を落とす<br><input type="file" accept=".zip,.xml" data-parcel-file></div>`);
    if (state.parcelError) parts.push(`<p class="small err">${escapeHtml(state.parcelError)}</p>`);
    if (s.fromFile && s.maps.length) {
      parts.push(`<details><summary>地図ごとの内訳（${s.maps.length} 枚）</summary><table class="list small"><thead><tr><th>地図</th><th>市区町村</th><th>座標系</th><th class="num">筆</th><th class="num">残した</th></tr></thead><tbody>`);
      for (const m of [...s.maps].sort((a, b) => b.kept - a.kept || a.stem.localeCompare(b.stem))) {
        parts.push(`<tr><td>${escapeHtml(m.stem)}</td><td>${escapeHtml(m.city)}</td><td>${escapeHtml(m.crs || "？")}</td><td class="num">${m.total}</td><td class="num">${m.isPublic ? m.kept : "—"}</td></tr>`);
      }
      parts.push(`</tbody></table></details>`);
      if (s.sources.length) parts.push(`<p class="muted small">出どころ：${s.sources.map((x) => `<a href="${escapeHtml(x.datasetUrl)}" target="_blank" rel="noopener">${escapeHtml(x.city)} ${escapeHtml(x.zip)}</a>（${escapeHtml(x.fetchedAt)} に取得）`).join("・")}</p>`);
      if (state.centerline.source.kind === "demo") parts.push(`<div class="row btns"><button class="btn small" data-parcel-demo>見本の公図に戻す</button></div>`);
    }
  }
  parts.push(about(
    `<p>「自動で取得」は、中心線が通る市町村を OpenStreetMap で当て、G空間情報センターで法務省の「登記所備付地図データ」のいちばん新しい年版を探し、利用規約への同意のあとで取得します ${help(HELP.mojfetch)}。</p>`,
    `<p>手で落とすなら、法務省の zip をそのまま（中の地図の zip 1 つや .xml 1 つでも）。地図を全部読み、区間の両側 ${state.parcelBuffer}m の筆と中心線を包む筆だけを残します（幅を広げると周りの筆も見られますが、筆の数と読み込み・保存はその分増えます）。ファイルはこの端末の外へ出しません。任意座標系の地図は位置を合わせられないので読み飛ばします。</p>`,
  ));
  return parts.join("");
}

/** 公図の自動取得の途中の画面：市町村 → データセット → 同意 → 取得 */
function renderFetch(state: AppState, fr: FetchRun): string {
  const parts: string[] = [];
  if (fr.phase === "cities") {
    parts.push(`<p class="small">中心線と両側 ${state.parcelBuffer}m の点（100m ごと）がどの市町村にあるかを OpenStreetMap で調べ、G空間情報センターでデータセットを探しています…</p>`);
    parts.push(`<div class="actions"><button class="btn" data-fetch-cancel>やめる</button></div>`);
    return parts.join("");
  }
  if (fr.error) parts.push(`<p class="small err">${escapeHtml(fr.error)}</p>`);
  const ready = fr.items.filter((it) => it.dataset);
  parts.push(`<p class="small">通る市町村 <b>${fr.items.length}</b>。それぞれの「登記所備付地図データ」（法務省）のいちばん新しい年版：</p>`);
  parts.push(`<table class="list small"><thead><tr><th>市町村</th><th>コード</th><th>年版・zip</th><th class="num">大きさ</th><th></th></tr></thead><tbody>`);
  for (const it of fr.items) {
    const d = it.dataset;
    parts.push(
      `<tr><td>${escapeHtml(it.muni.name)}</td><td>${escapeHtml(it.muni.code ?? "？")}</td>` +
        `<td>${d ? `<a href="${escapeHtml(d.datasetUrl)}" target="_blank" rel="noopener">${escapeHtml(d.year)}年版 ${escapeHtml(d.zipName)}</a>` : `<span class="err">${escapeHtml(it.error ?? "見つかりません")}</span>`}</td>` +
        `<td class="num">${d ? fmtMb(d.size) : ""}</td><td>${it.done ? `済（筆 ${it.kept}）` : fr.phase === "download" && d ? "…" : ""}</td></tr>`,
    );
  }
  parts.push(`</tbody></table>`);
  if (fr.phase === "choose") {
    parts.push(`<div class="row" style="display:flex;gap:6px;margin:6px 0"><input class="text" data-fetch-extra placeholder="市町村を足す（例：○○町）" aria-label="市町村を足す"><button class="btn small" data-fetch-add>探す</button></div>`);
    parts.push(`<p class="muted small">境に沿う道で隣の市町村が抜けていれば、名前で足せます。zip の名前が市区町村コードで始まるものだけを選びます（同名の町村を取り違えないため）。コードが分からない市町村は、タグの名前で探し、2 つ以上に当たれば見つからない扱いにします。</p>`);
    // 規約の PDF が無ければ、その市町村のデータセットのページ（規約はそこにある）
    const license = ready.find((it) => it.dataset?.licenseUrl)?.dataset?.licenseUrl ?? ready[0]?.dataset?.datasetUrl ?? "https://www.geospatial.jp/ckan/organization/moj";
    parts.push(
      `<label class="row" style="display:flex;gap:6px;align-items:flex-start;font-size:13px;margin:8px 0"><input type="checkbox" data-fetch-agree ${fr.agreed ? "checked" : ""}> <span>登記所備付地図データの<a href="${escapeHtml(license)}" target="_blank" rel="noopener">利用規約（法務省）</a>を読み、同意します。取得したデータの出典「登記所備付地図データ ○○（法務省）」と「加工して作成」は、地図・書き出し・PDF に道具が付けます。</span></label>`,
    );
    const total = ready.reduce((a, it) => a + (it.dataset!.size ?? 0), 0);
    parts.push(`<div class="row btns"><button class="btn primary" data-fetch-go ${fr.agreed && ready.length ? "" : "disabled"}>取得して読み込む（${ready.length} 件、約 ${fmtMb(total)}）</button><button class="btn" data-fetch-cancel>やめる</button></div>`);
    parts.push(`<p class="muted small">大きな市（数百 MB）は時間がかかります。取得は G空間情報センターから直接で、ファイルはこの端末の中で読み、外へ出しません。</p>`);
  } else {
    parts.push(`<p class="small">取得して読んでいます…（順に。読み終えた市町村から筆を合わせます）</p>`);
  }
  return parts.join("");
}

function wireParcelStep(state: AppState, body: HTMLElement) {
  const input = body.querySelector<HTMLInputElement>("[data-parcel-file]");
  input?.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) importParcels(state, f);
  });
  wireDrop(body.querySelector<HTMLElement>("[data-parcel-drop]"), (f) => importParcels(state, f));
  body.querySelector("[data-parcel-demo]")?.addEventListener("click", () => {
    state.parcelSource = { fromFile: false, fileName: null, maps: [], skipped: [], sources: [] };
    state.parcelError = null;
    applyParcels(state, state.demo.parcels);
    updateAttribution(state);
  });
  body.querySelector("[data-fetch-start]")?.addEventListener("click", () => startFetch(state));
  body.querySelector<HTMLSelectElement>("[data-parcel-buffer]")?.addEventListener("change", (e) => {
    state.parcelBuffer = Number((e.target as HTMLSelectElement).value) || 200;
    localStorage.setItem(BUFFER_KEY, String(state.parcelBuffer));
  });
  body.querySelector("[data-fetch-cancel]")?.addEventListener("click", () => {
    if (state.fetchRun?.phase === "download") return; // 取得の途中は止めない（ワーカーが終わるまで）
    state.fetchRun = null;
    renderStep(state);
  });
  body.querySelector<HTMLInputElement>("[data-fetch-agree]")?.addEventListener("change", (e) => {
    if (state.fetchRun) state.fetchRun.agreed = (e.target as HTMLInputElement).checked;
    renderStep(state);
  });
  body.querySelector("[data-fetch-add]")?.addEventListener("click", () => addFetchCity(state, body.querySelector<HTMLInputElement>("[data-fetch-extra]")?.value ?? ""));
  body.querySelector<HTMLInputElement>("[data-fetch-extra]")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFetchCity(state, (e.target as HTMLInputElement).value);
    }
  });
  body.querySelector("[data-fetch-go]")?.addEventListener("click", () => downloadAll(state));
}

/** 公図の自動取得：市町村を当て、データセットを探す（spec §17.3 の 1・2） */
async function startFetch(state: AppState) {
  if (state.fetchRun || state.parcelRun) return;
  const fr: FetchRun = { phase: "cities", items: [], agreed: false, error: null, features: [], maps: [], skipped: [], sources: [] };
  state.fetchRun = fr;
  state.parcelError = null;
  renderStep(state);
  showBusy("中心線が通る市町村を OpenStreetMap に聞いています（混んでいると 1 分ほど）…");
  try {
    const munis = await findMunicipalities(samplePoints(state.centerline.coords, 100, state.parcelBuffer));
    if (state.fetchRun !== fr) return;
    if (!munis.length) throw new Error("市町村を当てられませんでした（OpenStreetMap の行政境界が無い所か、通信の問題）。下で市町村の名前を足してください");
    for (const muni of munis) {
      showBusy(`${muni.name} の公図のデータセットを G空間情報センターで探しています…`);
      let dataset: MojDataset | null = null;
      let error: string | null = null;
      try {
        dataset = await searchDataset(muni.name, muni.code);
        if (!dataset) error = muni.code ? `コード ${muni.code} の zip が見つかりません（まだ公開されていない市町村かもしれません）` : "コードが分からず、名前では 1 つに決められません";
      } catch (e) {
        error = (e as Error).message;
      }
      fr.items.push({ muni, dataset, error, done: false, kept: 0 });
    }
  } catch (e) {
    fr.error = (e as Error).message;
  } finally {
    hideBusy();
  }
  if (state.fetchRun !== fr) return;
  fr.phase = "choose";
  renderStep(state);
}

async function addFetchCity(state: AppState, name: string) {
  const fr = state.fetchRun;
  const n = name.trim();
  if (!fr || fr.phase !== "choose" || !n) return;
  if (fr.items.some((it) => it.muni.name === n)) return;
  const muni: Municipality = { name: n, code: null, level: 7, osmId: 0 };
  let dataset: MojDataset | null = null;
  let error: string | null = null;
  try {
    dataset = await searchDataset(n, null);
    if (!dataset) error = "名前で 1 つに決められません（同名の市町村があるか、まだ公開されていません）";
  } catch (e) {
    error = (e as Error).message;
  }
  if (dataset) muni.code = dataset.code;
  fr.items.push({ muni, dataset, error, done: false, kept: 0 });
  renderStep(state);
}

/** 同意のあと、市町村ごとに順に取得して読み、筆を合わせる（spec §17.3 の 3・4） */
async function downloadAll(state: AppState) {
  const fr = state.fetchRun;
  if (!fr || fr.phase !== "choose" || !fr.agreed) return;
  fr.phase = "download";
  fr.error = null;
  renderStep(state);
  const today = new Date().toISOString().slice(0, 10);
  for (const it of fr.items) {
    if (!it.dataset || state.fetchRun !== fr) continue;
    const d = it.dataset;
    try {
      const r = await runParcelWorker(state, { kind: "url", url: d.zipUrl, name: d.zipName, total: d.size ?? 0 }, `${d.city} を取得して読んでいます`);
      if (!r.maps.length) throw new Error(`${d.zipName} は地図XML ではないようです`);
      fr.features.push(...r.features);
      fr.maps.push(...r.maps);
      fr.skipped.push(...r.skipped);
      fr.sources.push({ city: d.city, code: d.code, zip: d.zipName, datasetUrl: d.datasetUrl, fetchedAt: today });
      it.done = true;
      it.kept = r.features.length;
    } catch (e) {
      it.error = `${d.zipName}：${(e as Error).message}`;
      it.dataset = null;
    }
    renderStep(state);
  }
  if (state.fetchRun !== fr) return;
  state.fetchRun = null;
  const failed = fr.items.filter((it) => !it.done && it.error).map((it) => `${it.muni.name}（${it.error}）`);
  if (!fr.features.length) {
    state.parcelError = `公図を取得しましたが、この区間の両側 ${state.parcelBuffer}m に筆がありません${failed.length ? `。失敗：${failed.join("、")}` : "（公共座標系の地図が無いのかもしれません）"}`;
    renderStep(state);
    return;
  }
  // 見本の筆と足さない：取得した筆だけにする（同じ市町村なら同じ筆の id になり、重なるため）
  state.parcelSource = { fromFile: true, fileName: fr.sources.map((s) => s.zip).join("・"), maps: fr.maps, skipped: fr.skipped, sources: fr.sources, bufferM: state.parcelBuffer };
  state.parcelError = failed.length ? `取得できなかった市町村：${failed.join("、")}。手で zip を落とすか、あとでもう一度` : null;
  applyParcels(state, fr.features);
  updateAttribution(state);
}

/** 落とされた公図のファイルをワーカーで読み、区間の周りの筆に入れ替える */
async function importParcels(state: AppState, file: File) {
  if (state.parcelRun || state.fetchRun) return;
  state.parcelError = null;
  try {
    const m = await runParcelWorker(state, { kind: "file", file }, "読んでいます");
    const pub = m.maps.filter((x) => x.isPublic);
    if (!m.maps.length) throw new Error(`${file.name} は地図XML ではないようです。法務省の地図データの zip か、その中の XML を落としてください。`);
    if (!m.features.length) {
      throw new Error(
        pub.length
          ? `${file.name} を読みましたが（地図 ${m.maps.length} 枚）、この区間の両側 ${state.parcelBuffer}m に筆がありません。別の市町村の地図かもしれません。`
          : `${file.name} の地図 ${m.maps.length} 枚は全部任意座標系で、位置を合わせないと重なりません（まだ対応していません）。`,
      );
    }
    state.parcelSource = { fromFile: true, fileName: file.name, maps: m.maps, skipped: m.skipped, sources: [], bufferM: state.parcelBuffer };
    applyParcels(state, m.features);
    updateAttribution(state);
    console.info(`公図を読んだ：${file.name}、地図 ${m.maps.length} 枚、筆 ${m.features.length}（${m.ms}ms）`);
  } catch (e) {
    state.parcelError = (e as Error).message.startsWith(file.name) ? (e as Error).message : `${file.name} を読めませんでした：${(e as Error).message}`;
    renderStep(state);
  }
}

/** 公図をワーカーで読む（ファイルか URL）。進み具合は state.parcelRun に入れて手順 2 を描き直す */
function runParcelWorker(state: AppState, source: WorkerSource, label: string): Promise<Extract<WorkerOut, { type: "done" }>> {
  state.parcelRun = { bytes: 0, total: source.kind === "file" ? source.file.size : source.total, maps: 0, kept: 0, current: null, label };
  renderStep(state);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./core/mojxml.worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      worker.terminate();
      state.parcelRun = null;
    };
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "progress") {
        state.parcelRun = { bytes: m.bytes, total: m.total || state.parcelRun?.total || 0, maps: m.maps, kept: m.kept, current: m.current, label };
        if (state.step === 2) renderStep(state);
        return;
      }
      finish();
      if (m.type === "error") reject(new Error(m.message));
      else resolve(m);
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message));
    };
    worker.postMessage({ source, dense: state.dense, bufferM: state.parcelBuffer, zone: state.zone } satisfies WorkerIn);
  });
}

/** 現地マップ（KML・GeoJSON）の材料。伐採範囲の外側は、掃く範囲があるときだけ入れる */
function fieldMapInput(state: AppState, day: string): FieldMapInput {
  const cutLines = trackGeoJSON(state.dense, state.normals, state.trackResult.sweep, state.trackResult.outer)
    .features.filter((f) => f.properties.kind === "cut" && f.geometry.type === "LineString")
    .map((f) => (f.geometry as { coordinates: Position[] }).coordinates);
  return {
    title: `${state.roadName || state.name} 現地マップ（アルクマエ）`,
    roadName: state.roadName,
    dense: state.dense,
    hits: state.hits,
    parcelById: state.parcelById,
    segments: state.segmentsGeo,
    judgments: state.judgments,
    checks: checkList(state),
    kps: state.kps,
    forest: state.forest,
    notes: state.notes,
    cutLines: state.track.source.kind === "band" ? [] : cutLines,
    madeOn: day,
    mojAttribution: mojAttribution(state.parcelSource.fromFile ? { fileName: "", maps: state.parcelSource.maps, skipped: [], features: [] } : null, !state.parcelSource.fromFile && state.centerline.source.kind === "demo"),
  };
}

/** 筆を入れ替え、かかる筆・森林・一覧・地図を作り直す */
function applyParcels(state: AppState, parcels: ParcelFeature[]) {
  for (const h of state.hits) featureState(state, { source: "parcels", id: h.parcelId }, { hit: false });
  state.parcels = parcels;
  state.parcelById = new Map(parcels.map((p) => [p.properties.id, p]));
  // 拾い直し（rebuildTrack）は一拍あとに走る。その間に一覧を描くと古いかかる筆が新しい筆の表を引いて落ちるので、先に空にする
  state.hits = [];
  state.hitById = new Map();
  setSourceData(state.map, "parcels", parcelsToGeoJSON(parcels));
  rebuildTrack(state);
}

/**
 * 伐採範囲の作り直し。筆の拾い直し（turf の重なり計算、数千筆 × 数百区切り）に 1〜3 秒かかり、その間は画面が止まる
 * （起立の区間を足したら数秒固まった、と 2026-11-03 に言われた）。先に「計算中」を出し、描かれてから計算する
 */
function rebuildTrack(state: AppState) {
  showBusy("伐採範囲を作り直しています。筆を拾い直すのに数秒かかります…");
  setTimeout(() => {
    try {
      rebuildTrackNow(state);
    } finally {
      hideBusy();
    }
  }, 30);
}

function rebuildTrackNow(state: AppState) {
  const t0 = performance.now();
  state.trackResult = computeTrack(state.dense, state.normals, state.track);
  // 読んだ軌跡図が区間を覆っているか。計算の直後にここで見る（前は readTrackFile で見ていて、計算を後回しにしたら前の結果を読んでいた。2026-11-03 のレビュー）
  if (state.track.source.kind === "file") {
    const covered = state.trackResult.sweep.left.filter((x) => Number.isFinite(x)).length;
    if (covered === 0) state.trackError = "読めましたが、この区間の中心線の近く（120m 以内）に線がありません。別の道の軌跡図かもしれません。";
    else if (covered < state.dense.length * 0.5) state.trackError = `軌跡図が区間の一部（約 ${covered}m）しか覆っていません。覆っていない所は切らない扱いです。`;
  }
  state.segments = state.trackResult.segments;
  const hits = findHits(state.parcels, state.segments);
  for (const h of state.hits) featureState(state, { source: "parcels", id: h.parcelId }, { hit: false });
  state.hits = hits;
  state.hitById = new Map(hits.map((h) => [h.parcelId, h]));
  for (const h of hits) featureState(state, { source: "parcels", id: h.parcelId }, { hit: true });
  if (state.forestIndex) recomputeForest(state);
  state.segmentsGeo = applyJudgments(segmentsToGeoJSON(state.segments), state.judgments, state.forestFlags);
  setSourceData(state.map, "segments", state.segmentsGeo);
  setSourceData(state.map, "hit-areas", hitsToGeoJSON(hits));
  setSourceData(state.map, "track", trackGeo(state));
  clearSelection(state);
  persist(state);
  renderList(state);
  renderChecks(state);
  renderStep(state);
  console.info(`伐採範囲を作り直し：区切り ${state.segments.length}、かかる筆 ${hits.length}（${Math.round(performance.now() - t0)}ms）`);
}

function trackGeo(state: AppState) {
  // 仮の帯のときは掃く範囲の面を出さない（帯そのものが区切りとして見えている）
  if (state.track.source.kind === "band") return { type: "FeatureCollection", features: [] } as ReturnType<typeof trackGeoJSON>;
  const fc = trackGeoJSON(state.dense, state.normals, state.trackResult.sweep, state.trackResult.outer);
  // 起立の区間は中心線に沿った太い線と「60°」の札で出す（kind: tilt。ファイルに書くときは外す）
  if (state.track.source.kind === "vehicle") {
    for (const z of state.track.source.tiltZones) {
      const coords = state.dense.slice(z.fromM, z.toM + 1).map((p) => toLonLat(p));
      if (coords.length >= 2) fc.features.push({ type: "Feature", properties: { name: `起立 ${z.tilt}°（${z.fromM}〜${z.toM}m）`, kind: "tilt", label: `${z.tilt}°` }, geometry: { type: "LineString", coordinates: coords } } as (typeof fc.features)[number]);
    }
  }
  return fc;
}

function renderJudgeStep(state: AppState): string {
  const { model, review, photo2 } = getSettings();
  const windows = windowsOf(state.segments);
  const judged = state.judgments.size;
  const byClaude = [...state.judgments.values()].filter((j) => j.by === "Claude").length;
  const hasKey = !!getApiKey();
  const parts: string[] = [];
  const byHuman = judged - byClaude;
  parts.push(tiles([{ label: "区切り", value: state.segments.length }, { label: "判定あり", value: judged, unit: `/ ${state.segments.length}`, tone: judged === state.segments.length && judged ? "ok" : undefined }, { label: "人が直した", value: byHuman }]));
  parts.push(`<p>区切り ${help(HELP.segment)} ごとに、航空写真の切り抜きから木の割合を Claude が判定します。</p>`);
  if (state.run) {
    const r = state.run;
    parts.push(`<div class="progress"><i style="width:${(100 * r.done) / r.total}%"></i></div>`);
    parts.push(`<p class="small">${r.done} / ${r.total} 窓、ここまで ${fmtUsd(r.usd)}</p>`);
    parts.push(`<pre class="log">${r.log.map((l) => (l.startsWith("!") ? `<span class="err">${escapeHtml(l.slice(1))}</span>` : escapeHtml(l))).join("\n")}</pre>`);
    parts.push(`<div class="actions"><button class="btn" data-cancel ${r.cancel ? "disabled" : ""}>${r.cancel ? "止めています…" : "止める"}</button></div>`);
  } else {
    const usd = estimateCost(windows.length, model, review, !!photo2);
    parts.push(
      `<div class="actions"><button class="btn primary" data-judge ${hasKey && state.segments.length ? "" : "disabled"}>${judged ? "全部を判定し直す" : "木を判定する"} <span class="cost">約 ${fmtUsd(usd)}</span></button>` +
        (hasKey ? "" : `<p class="muted small">判定には API キーが要ります。右上の「設定」で入れると押せるようになります。</p>`) +
        `</div>`,
    );
    parts.push(`<div class="actions"><button class="btn next" data-go="5">次へ：確かめて直す</button></div>`);
    parts.push(about(
      `<p>区切り 40 ほどをまとめた写真 1 枚ずつ（${windows.length} 枚）を Claude に見せます。${MODELS[model]} が全区切りを見て、確信「低」の区切りだけ${review ? ` ${MODELS[review]} が見直します ${help(HELP.review)}` : "はそのまま残します"}。${photo2 ? `${photoLayerLabel(photo2)}も一緒に見せ、変化を拾います（設定で変えられます）。` : ""}</p>`,
      `<p>送るのは航空写真の切り抜きだけで、座標・地名・案件名は送りません。判定は候補で、人が直した区切りは「全部を判定し直す」でも上書きしません ${help(HELP.judged)}。</p>`,
      state.centerline.source.kind === "demo" && judged ? `<div class="row btns"><button class="btn small ghost" data-reset-demo>判定を見本に戻す</button></div>` : "",
    ));
  }
  return parts.join("");
}

/**
 * 判定を走らせる。窓ごとに 写真を作る → 主のモデル → 確信「低」だけ見直しのモデル。同時に 3 窓まで。
 * 人が直した区切りは飛ばす（人の修正を優先。spec §8.4。Codex の指摘 2026-11-03）。答えに無かった番号は未判定のまま「確かめる所」へ
 */
async function runJudging(state: AppState) {
  const key = getApiKey();
  if (!key || state.run) return;
  const { model, review, photo2 } = getSettings();
  const client = makeClient(key);
  const windows = windowsOf(state.segments);
  state.run = { done: 0, total: windows.length, usd: 0, log: [], cancel: false };
  // この走りの印。案件や中心線を変えると state.run は別物（null）になるので、戻ってきた答えを捨てられる（Codex の指摘 2026-11-04）
  const run = state.run;
  const stale = () => state.run !== run;
  renderStep(state);
  const log = (s: string) => {
    state.run?.log.unshift(s);
    if (state.step === 4) renderStep(state);
  };

  const one = async (segs: Segment[], k: number) => {
    if (run.cancel || stale()) return;
    const label = `${segs[0].fromM}〜${segs.at(-1)!.toM}m`;
    try {
      const ids = segs.map((s) => s.id).filter((id) => state.judgments.get(id)?.by !== "人");
      if (!ids.length) {
        log(`窓 ${k + 1}（${label}）：全部人が直した区切りなので飛ばします`);
        return;
      }
      const images = await renderWindow(segs);
      // 別の年の写真（F11）。その年の写真がこの窓に 1 枚もなければ、1 枚だけで判定する
      let second = photo2 ? await renderWindow(segs, photo2) : undefined;
      if (second && second.coverage === 0) {
        log(`　窓 ${k + 1}：${photoLayerLabel(photo2)}はこの範囲にないので、最新写真だけで判定します`);
        second = undefined;
      }
      const main = await judgeWindow(client, model, images, ids, second);
      if (stale()) return; // 待っている間に案件や中心線が変わった。古い答えは新しい区切りに書かない
      run.usd += main.usd;
      if (main.refused) {
        log(`!窓 ${k + 1}（${label}）：モデルが答えませんでした`);
      } else {
        for (const j of main.judgments) {
          if (state.judgments.get(j.segmentId)?.by === "人") continue; // 待っている間に人が直した区切りは上書きしない
          state.judgments.set(j.segmentId, j);
          state.unjudged.delete(j.segmentId);
        }
        for (const id of main.missing) if (!state.judgments.has(id)) state.unjudged.add(id);
        log(`窓 ${k + 1}（${label}）：${main.judgments.length} 区切り${ids.length < segs.length ? `（人が直した ${segs.length - ids.length} は飛ばし）` : ""}、${Math.round(main.seconds)}秒、${fmtUsd(main.usd)}`);
        if (main.missing.length) log(`!窓 ${k + 1}：答えに無かった番号 ${main.missing.join("・")}（未判定のまま「確かめる所」に入れます）`);
        // 見直すのは確信「低」と、別の年の写真で変化のあった区切り（spec §8.4）
        const lows = main.judgments.filter((j) => j.conf === "低" || isRealChange(j.change)).map((j) => j.segmentId);
        if (review && lows.length && !run.cancel) {
          const rev = await judgeWindow(client, review, images, lows, second);
          if (stale()) return;
          run.usd += rev.usd;
          let changed = 0;
          for (const j of rev.judgments) {
            const first = state.judgments.get(j.segmentId);
            if (!first || first.by === "人") continue; // 主の判定が無い（答えに無かった）か、待っている間に人が直した
            if (j.tree !== first.tree) changed++;
            state.judgments.set(j.segmentId, { ...j, before: { tree: first.tree, conf: first.conf, model: first.model } });
          }
          log(`　見直し ${lows.length} 区切り（${MODELS[review]}）：${changed} 区切りで木の割合が変わりました、${fmtUsd(rev.usd)}`);
        }
      }
    } catch (e) {
      log(`!窓 ${k + 1}（${label}）：${(e as Error).message}`);
    } finally {
      if (!stale()) {
        run.done++;
        refreshJudgments(state);
        if (state.step === 4) renderStep(state);
      }
    }
  };

  // 同時に 3 窓まで。API の同時の問い合わせの上限と、写真の取り込みの負荷の両方を抑える
  let next = 0;
  const workers = Array.from({ length: Math.min(3, windows.length) }, async () => {
    while (next < windows.length && !run.cancel && !stale()) {
      const k = next++;
      await one(windows[k], k);
    }
  });
  await Promise.all(workers);
  if (stale()) return; // 止めた側が片付けている
  const total = run.usd;
  state.run = null;
  persist(state);
  if (state.step === 4) renderStep(state);
  console.info(`判定おわり：${fmtUsd(total)}`);
}

/** 走っている判定を止めて捨てる。案件や中心線を変えるとき（古い答えを新しい案件の区切りに書かないため。Codex の指摘 2026-11-04） */
function cancelRun(state: AppState) {
  if (!state.run) return;
  state.run.cancel = true;
  state.run = null;
  console.info("案件が変わったので、走っていた判定を止めました");
}

/** 判定が変わったとき、地図の色・一覧・詳細を合わせる */
function refreshJudgments(state: AppState) {
  if (state.segForest) state.forestFlags = forestMismatch(state.segments, state.judgments, state.segForest);
  state.segmentsGeo = applyJudgments(segmentsToGeoJSON(state.segments), state.judgments, state.forestFlags);
  (state.map.getSource("segments") as GeoJSONSource | undefined)?.setData(state.segmentsGeo);
  renderList(state);
  renderChecks(state);
  persist(state);
  if (state.selectedSegment) selectSegment(state, state.selectedSegment, false);
}

/**
 * 「この手順について」：説明の段落をたたんで置く。本文は数字のタイル・1 行・ボタンに絞り、読みたい人だけ開く
 * （文字が多くて見づらい、と 2026-11-04 に言われた。情報は消さず、開けば読める所へ移す）
 */
function about(...html: string[]): string {
  return `<details class="about"><summary>この手順について</summary>${html.filter(Boolean).join("")}</details>`;
}

/** 数字のタイル。文より先に数を見せる（手順 3・4・5・7） */
function tiles(items: { label: string; value: string | number; unit?: string; tone?: "warn" | "ok" }[]): string {
  return `<div class="tiles">${items.map((t) => `<div class="tile ${t.tone ?? ""}"><div class="label">${escapeHtml(t.label)}</div><div class="value">${escapeHtml(String(t.value))}${t.unit ? `<small>${escapeHtml(t.unit)}</small>` : ""}</div></div>`).join("")}</div>`;
}

function countKinds(state: AppState): string {
  const c = new Map<ParcelKind, number>();
  for (const h of state.hits) {
    const k = state.parcelById.get(h.parcelId)!.properties.kind;
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return [...c.entries()].map(([k, n]) => `${kindLabel(k)} ${n}`).join("・") || "なし";
}

/** 確かめる所＝確信「低」・森林の食い違い・変化・未判定の区切り。起点から順、同じ所は左→右 */
function checkList(state: AppState): Check[] {
  return listChecks(state.segments, state.judgments, state.forestFlags, state.unjudged);
}

/** 一覧に出ている確かめる所（絞り込み後）。前へ・次へと一覧の番号はこちらで数える */
function visibleChecks(state: AppState): Check[] {
  return filterChecks(checkList(state), state.filter.checks, state.notes);
}

function stepLow(state: AppState, dir: 1 | -1) {
  const lows = visibleChecks(state);
  if (!lows.length) return;
  state.lowCursor = (state.lowCursor + dir + lows.length) % lows.length;
  selectSegment(state, lows[state.lowCursor].segmentId, true);
  if (state.step === 5) renderStep(state);
}

/** 「確かめる所」の一覧。行を押すとそこへ飛び、何番目かが手順 5 の表示と合う */
function renderChecks(state: AppState) {
  const all = checkList(state);
  const lows = visibleChecks(state);
  document.getElementById("check-count")!.textContent = `${all.length}`;
  document.getElementById("check-chips")!.innerHTML = chips(CHECK_FILTERS, state.filter.checks);
  document.getElementById("check-shown")!.textContent = lows.length !== all.length ? `${lows.length} / ${all.length} か所` : "";
  const body = document.getElementById("check-body")!;
  if (!all.length) {
    body.innerHTML = `<p class="empty">まだありません。手順 4 で判定すると、確信が「低」だった区切りと、森林の区域と食い違う区切りがここに並びます。</p>`;
    return;
  }
  if (!lows.length) {
    body.innerHTML = `<p class="empty">この絞り込みに合う所はありません。</p>`;
    return;
  }
  const rows = lows
    .map((c, i) => {
      const seg = state.segments.find((s) => s.id === c.segmentId);
      const j = state.judgments.get(c.segmentId);
      const side = c.segmentId.startsWith("L") ? "左" : "右";
      const tag =
        c.kind === "森林" ? `<span class="badge forest">森林</span>` : c.kind === "変化" ? `<span class="badge change">変化</span>` : c.kind === "食い違い" ? `<span class="badge gap">割れた</span>` : c.kind === "未判定" ? `<span class="badge">未判定</span>` : j?.before ? `<span class="badge">見直し済</span>` : `<span class="badge low">低</span>`;
      return `<tr data-seg="${c.segmentId}" class="${c.segmentId === state.selectedSegment ? "selected" : ""}">
        <td class="num">${i + 1}</td><td class="num">${seg ? `${seg.fromM}〜${seg.toM}` : ""}</td><td>${side}</td>
        <td class="num">${treeText(c.tree)}</td><td>${tag}</td>
        <td class="muted" title="${escapeHtml(c.why)}">${escapeHtml(c.why.length > 18 ? c.why.slice(0, 18) + "…" : c.why)}</td>
        <td class="note-cell ${state.notes.get(c.segmentId)?.result === "×" ? "ng" : state.notes.get(c.segmentId)?.result ? "ok" : ""}" title="${escapeHtml(noteText(state.notes.get(c.segmentId)))}">${escapeHtml(state.notes.get(c.segmentId)?.result ?? "")}</td></tr>`;
    })
    .join("");
  body.innerHTML = `<table class="list"><thead><tr><th>#</th><th>起点から m</th><th>左右</th><th>木</th><th>種類</th><th>理由</th><th title="現地の記録（○△×）">現地</th></tr></thead><tbody>${rows}</tbody></table>`;
  body.querySelectorAll<HTMLTableRowElement>("tr[data-seg]").forEach((tr, i) =>
    tr.addEventListener("click", () => {
      state.lowCursor = i;
      selectSegment(state, tr.dataset.seg!, true);
      if (state.step === 5) renderStep(state);
    }),
  );
}

/* ---------- 地図の操作 ---------- */

function wireMapClicks(state: AppState) {
  const { map } = state;
  map.on("click", (e) => {
    const ll: LonLat = [e.lngLat.lng, e.lngLat.lat];
    if (state.drawing) return drawPoint(state, ll);
    if (state.osmPick) return void pickOsm(state, ll);
    if (state.placingKp) return placeKp(state, ll);
    if (state.placingTilt) return placeTilt(state, ll);
    // 区切りの上では区切りを優先。筆は、地区外・別図でないものを優先する（地区外の区画は隣の地図の筆を丸ごと覆っているため）
    const seg = map.queryRenderedFeatures(e.point, { layers: ["segments-fill"] })[0];
    if (seg) return selectSegment(state, seg.properties.id as string, false);
    const fs = map.queryRenderedFeatures(e.point, { layers: ["parcels-fill"] }) as MapGeoJSONFeature[];
    const f = fs.find((f) => !NOT_LAND.has(f.properties.kind as ParcelKind)) ?? fs[0];
    if (f) selectParcel(state, f.properties.id as string, false);
  });
  for (const layer of ["segments-fill", "parcels-fill"]) {
    map.on("mouseenter", layer, () => {
      if (!state.drawing && !state.osmPick && !state.placingKp && !state.placingTilt) map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layer, () => {
      if (!state.drawing && !state.osmPick && !state.placingKp && !state.placingTilt) map.getCanvas().style.cursor = "";
    });
  }
}

/** 押した所を中心線に投影して距離標を置き、値を聞く（spec §8.6） */
function placeKp(state: AppState, lonLat: [number, number]) {
  const near = nearestOnLine(state.dense, toPlane(lonLat));
  if (near.dist > 60) {
    alert("中心線から離れすぎています（60m 以上）。道路の近くを押してください。");
    return;
  }
  const raw = prompt(`起点から ${near.index}m の所に距離標を置きます。距離標に書いてある値（km）を入れてください。例：12.3`);
  if (raw === null) return;
  const kp = Number(raw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(kp) || raw.trim() === "") {
    alert("数字で入れてください（例：12.3）");
    return;
  }
  state.kps = [...state.kps.filter((m) => m.atM !== near.index), { atM: near.index, kp }];
  state.placingKp = false;
  state.map.getCanvas().style.cursor = "";
  refreshKps(state);
  renderStep(state);
}

function kpsGeo(state: AppState): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: state.kps.map((m) => ({
      type: "Feature",
      properties: { label: `KP ${fmtKm(m.kp)}`, atM: m.atM },
      geometry: { type: "Point", coordinates: toLonLat(state.dense[Math.min(m.atM, state.dense.length - 1)]) },
    })),
  };
}

function refreshKps(state: AppState) {
  (state.map.getSource("kps") as GeoJSONSource | undefined)?.setData(kpsGeo(state));
  persist(state);
  renderList(state);
  if (state.selectedSegment) selectSegment(state, state.selectedSegment, false);
  else if (state.selectedParcel) selectParcel(state, state.selectedParcel, false);
}

/** 起点からの距離 m の KP の表示。距離標が足りなければ空 */
/** 筆の地図（XML）を含むデータセットのページへのリンク。元の公図を広く見たいとき、zip の中のその XML を探せる */
function mapLink(state: AppState, stem: string): string {
  const demo = !state.parcelSource.fromFile && state.centerline.source.kind === "demo";
  const url = demo ? DEMO_MOJ.url : state.parcelSource.sources.find((x) => stem.startsWith(x.code))?.datasetUrl ?? state.parcelSource.sources[0]?.datasetUrl;
  if (!url) return "";
  return `<br><a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="small">データセット（zip の中の ${escapeHtml(stem)}.xml）↗</a>`;
}

function kpText(state: AppState, m: number): string {
  const est = estimateKp(state.kps, m);
  return est ? `${escapeHtml(formatKp(state.roadName, est))}<br><span class="muted small">${escapeHtml(est.basis)}</span>` : `<span class="muted">距離標を 2 本以上置くと出ます（手順 6）</span>`;
}

/** 地図の読み込みが終わる前に一覧の行を押すと、源（source）がまだ無くて MapLibre が例外を投げる。そのときは色を付けないだけにする */
function featureState(state: AppState, target: { source: string; id: string }, value: Record<string, boolean>) {
  if (state.map.getSource(target.source)) state.map.setFeatureState(target, value);
}

function clearSelection(state: AppState) {
  if (state.selectedParcel) featureState(state, { source: "parcels", id: state.selectedParcel }, { selected: false });
  if (state.selectedSegment) featureState(state, { source: "segments", id: state.selectedSegment }, { selected: false });
  state.selectedParcel = state.selectedSegment = null;
  document.querySelectorAll("table.list tr.selected").forEach((tr) => tr.classList.remove("selected"));
}

/** パネルに隠れていない範囲の真ん中に来るよう、余白を付けて飛ぶ */
function flyTo(state: AppState, bounds: LngLatBoundsLike) {
  state.map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: leftCover() + 40, right: rightCover() + 40 }, maxZoom: 19, duration: 600 });
}

function treeOfParcel(state: AppState, h: ParcelHit): { tree: number; n: number } | null {
  const js = h.segmentIds.map((id) => state.judgments.get(id)).filter((j): j is Judgment => !!j);
  if (!js.length) return null;
  return { tree: Math.max(...js.map((j) => j.tree)), n: js.length };
}

function selectParcel(state: AppState, id: string, fly: boolean) {
  clearSelection(state);
  const p = state.parcelById.get(id);
  if (!p) return;
  state.selectedParcel = id;
  featureState(state, { source: "parcels", id }, { selected: true });
  const h = state.hitById.get(id);
  const row = document.querySelector(`table.list tr[data-id="${CSS.escape(id)}"]`);
  row?.classList.add("selected");
  row?.scrollIntoView({ block: "nearest" });
  const notLand = NOT_LAND.has(p.properties.kind);
  const tree = h ? treeOfParcel(state, h) : null;
  // 筆の属性（所在・地番・地図の名前）は案件ファイルから来ることもあるので、全部 escapeHtml する
  openDetail(
    `${p.properties.oaza ?? ""} ${p.properties.chiban}`,
    `<dl class="kv">
      <dt>種類</dt><dd><span class="badge" style="background:${KIND_COLORS[p.properties.kind] ?? "#eee"}">${escapeHtml(kindLabel(p.properties.kind))}</span> ${help(HELP.kind)}</dd>
      ${notLand ? `<dd style="grid-column:1/-1" class="muted small">土地ではなく「この地図ではここから先は描いていない」という印です。この中の筆は隣の地図に載っています。</dd>` : ""}
      <dt>かかる</dt><dd>${h ? `${h.areaM2} m²（起点から ${h.fromM}〜${h.toM} m・${h.sides.map((s) => (s === "L" ? "左" : "右")).join("・")}）` : "いいえ"}</dd>
      ${h ? `<dt>木（推定）</dt><dd>${tree ? `最大 ${tree.tree}%（${tree.n} 区切り）` : '<span class="muted">まだ判定していません</span>'}</dd>` : ""}
      ${h ? `<dt>森林の区域</dt><dd>${state.forest ? escapeHtml(forestText(state.forest.get(h.parcelId))) + (noticeText(state.forest.get(h.parcelId)) ? `<br><span class="badge low">届出が要るかもしれない（市町村に確かめる）</span>` : "") : `<span class="muted">${escapeHtml(state.forestNote)}</span>`} ${help(HELP.forest)}</dd>` : ""}
    </dl>
    <details class="more"><summary>ほか</summary><dl class="kv">
      ${h ? `<dt>KP（推定）</dt><dd>${kpText(state, (h.fromM + h.toM) / 2)}</dd>` : ""}
      <dt>外で見る</dt><dd>${earthLink(ringCenter(h ? h.shape.coordinates[0][0] : p.geometry.coordinates[0]))}</dd>
      <dt>地図</dt><dd>${escapeHtml(p.properties.map)} ${help(HELP.mapName)}${mapLink(state, p.properties.map)}</dd>
    </dl>
    <p class="muted small">公図は「おおよその位置と隣接関係」を示す図面です。境界は現地と違うことがあります。</p></details>`,
  );
  // かかる部分の形に合わせて飛ぶ。筆全体だと、山林の大きな筆では引きすぎて黄色が点になる
  if (fly) flyTo(state, boundsOf(h ? h.shape.coordinates.flat(2) : p.geometry.coordinates[0]));
}

function selectSegment(state: AppState, id: string, fly: boolean) {
  clearSelection(state);
  const f = state.segmentsGeo.features.find((f) => f.properties!.id === id);
  if (!f) return;
  state.selectedSegment = id;
  featureState(state, { source: "segments", id }, { selected: true });
  const row = document.querySelector(`#check-body tr[data-seg="${CSS.escape(id)}"]`);
  row?.classList.add("selected");
  row?.scrollIntoView({ block: "nearest" });
  const j = state.judgments.get(id);
  const side = f.properties!.side === "L" ? "左" : "右";
  const confClass = j?.conf === "低" ? "low" : j?.conf === "高" ? "high" : "";
  // 判定の値は選択肢で検めてあるが、案件ファイルから来る文字（理由・モデル名・年）は全部 escapeHtml する（Codex の指摘 2026-11-03）
  openDetail(
    `区切り ${escapeHtml(id)}`,
    `<dl class="kv">
      <dt>場所</dt><dd>起点から ${f.properties!.fromM}〜${f.properties!.toM} m の${side}・${f.properties!.areaM2} m²</dd>
      ${
        j
          ? `<dt>木</dt><dd><b>${j.tree}%</b>　${escapeHtml(j.kind)}${j.other.length ? `　＋${escapeHtml(j.other.join("・"))}` : ""}</dd>
             <dt>確信</dt><dd><span class="badge ${confClass}">${escapeHtml(j.conf)}</span>　<span class="badge ${j.by === "人" ? "human" : ""}">${escapeHtml(j.by)}${j.model ? `（${escapeHtml(shortModel(j.model))}）` : ""}</span></dd>
             <dt>理由</dt><dd>${escapeHtml(j.why)}</dd>
             ${j.before ? `<dt>最初の判定</dt><dd class="muted">${j.before.tree}%・確信 ${escapeHtml(j.before.conf)}（${escapeHtml(shortModel(j.before.model ?? ""))}）→ 見直しました</dd>` : ""}
             ${j.oldYear ? `<dt>別の年</dt><dd>${escapeHtml(j.oldYear)} 年度の写真では ${j.treeOld ?? "?"}%。変化：<b>${escapeHtml(j.change ?? "分からない")}</b> ${help(HELP.change)}</dd>` : ""}`
          : state.unjudged.has(id)
            ? `<dt>判定</dt><dd class="muted">Claude の答えにこの番号がありませんでした（未判定）。現地で確かめるか、手で直してください</dd>`
            : `<dt>判定</dt><dd class="muted">まだ判定していません</dd>`
      }
      ${state.forestFlags?.get(id) ? `<dt>森林の区域</dt><dd><span class="badge forest">食い違い</span> <span class="small">${escapeHtml(state.forestFlags.get(id)!)}</span></dd>` : ""}
    </dl>
    <details class="more"><summary>ほか</summary><dl class="kv">
      <dt>KP（推定）</dt><dd>${kpText(state, (f.properties!.fromM + f.properties!.toM) / 2)}</dd>
      <dt>外側</dt><dd>中心線から ${f.properties!.outerMaxM} m まで ${help(HELP.band)}</dd>
      ${state.segForest?.get(id) ? `<dt>森林の区域</dt><dd>${Math.round(state.segForest.get(id)!.ratio * 100)}% が区域の中</dd>` : ""}
      <dt>外で見る</dt><dd>${earthLink(ringCenter(f.geometry.coordinates[0]))}</dd>
    </dl></details>
    <div class="seg-photo" data-seg-photo><span class="muted small">Claude が見た写真を切り出しています…</span></div>
    <p class="muted small guide">机で判定を直すなら「この区切りを直す」。現地で見たことを残すなら「現地の記録」（判定は変えず、記録だけ残ります）。</p>
    ${fixForm(j, !touchFirst())}
    ${noteForm(state.notes.get(id), touchFirst())}`,
  );
  wireFixForm(state, id);
  wireNoteForm(state, id);
  showSegmentPhoto(state, id);
  if (fly) flyTo(state, boundsOf(f.geometry.coordinates[0]));
}

/**
 * 区切りの詳細に、判定に送ったのと同じ描き方の写真（札なし・札あり）の切り抜きを出す。
 * 「AI が何を見て決めたか」を人が確かめられるようにするため。タイルは photo.ts が写しを持つので 2 回目からは速い
 */
async function showSegmentPhoto(state: AppState, id: string) {
  const win = windowsOf(state.segments).find((w) => w.some((s) => s.id === id));
  const box = document.querySelector<HTMLElement>("[data-seg-photo]");
  if (!win || !box) return;
  try {
    const crop = await renderSegmentCrop(win, id);
    // 判定に別の年の写真を使っていれば、その年の切り抜きも並べる（何を見比べたかを人が確かめられるように）
    const oldYear = state.judgments.get(id)?.oldYear;
    const old = oldYear ? await renderSegmentCrop(win, id, 25, oldYear) : null;
    // 待っている間に別の区切りが選ばれていたら出さない
    if (!crop || state.selectedSegment !== id) return;
    const target = document.querySelector<HTMLElement>("[data-seg-photo]");
    if (!target) return;
    const fig = (data: string, cap: string) => `<figure><img src="data:image/jpeg;base64,${data}" alt="${escapeHtml(cap)}"><figcaption>${escapeHtml(cap)}</figcaption></figure>`;
    target.innerHTML = `<div class="seg-photo-pair">${fig(crop.plain, "札なし")}${fig(crop.labeled, "札あり（枠と番号）")}${old ? fig(old.plain, `${oldYear} 年度`) : ""}</div><p class="muted small">Claude に送ったのと同じ描き方（地理院の航空写真、z18 を 3 倍）。この区切りの周り 25m を切り出したもの。出典：国土地理院（地理院タイル）を加工</p>`;
  } catch {
    box.innerHTML = `<span class="muted small">写真を切り出せませんでした</span>`;
  }
}

const TREE_KINDS: TreeKind[] = ["針葉樹", "広葉樹", "混じる", "分からない", "なし"];
const CONFS: Confidence[] = ["高", "中", "低"];

/**
 * 指で触る画面（iPad・スマホ）なら現地の記録を、マウスの画面（PC）なら直す欄を開いておく。
 * 2 つの欄のどちらに入れるか最初に迷う、と言われた（2026-11-03）。使う場面（現地か机か）で開く欄を変え、文でも案内する
 */
function touchFirst(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

/** 現地の記録の欄（持ち運びモード）。○△× は押すだけで保存、メモは入力を離れたとき（blur）に保存。現地で片手で使えるように */
function noteForm(n: FieldNote | undefined, open: boolean): string {
  const has = !!(n && (n.result || n.memo));
  return `<details class="note" data-note ${open || has ? "open" : ""}>
    <summary class="note-head">現地の記録 ${help(HELP.notes)}${has ? `<span class="badge">${escapeHtml(n!.result || "メモ")}</span>` : ""}${n?.at ? `<span class="muted small"> ${new Date(n.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>` : ""}</summary>
    <div class="note-btns">${NOTE_RESULTS.map((r) => `<button type="button" class="btn ${n?.result === r.value ? "primary" : ""}" data-note-result="${r.value}" title="${r.label}">${r.value} ${r.label}</button>`).join("")}</div>
    <input data-note-memo value="${escapeHtml(n?.memo ?? "")}" placeholder="メモ（電線あり、もう切られている、など）">
    ${has ? `<div class="row end"><button type="button" class="btn small" data-note-clear>この記録を消す</button></div>` : ""}
  </details>`;
}

function wireNoteForm(state: AppState, id: string) {
  const box = document.querySelector<HTMLElement>("#detail-body [data-note]");
  if (!box) return;
  const save = (patch: Partial<FieldNote>) => {
    const cur = state.notes.get(id) ?? { segmentId: id, result: "" as const, memo: "", at: "" };
    const next: FieldNote = { ...cur, ...patch, at: new Date().toISOString() };
    if (!next.result && !next.memo.trim()) state.notes.delete(id);
    else state.notes.set(id, next);
    saveNotes(state);
    renderChecks(state);
    if (state.step === 5) renderStep(state);
  };
  box.querySelectorAll<HTMLButtonElement>("[data-note-result]").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.noteResult as NoteResult;
      // 同じものをもう一度押したら外す
      save({ result: state.notes.get(id)?.result === v ? "" : v });
      selectSegment(state, id, false);
    }),
  );
  const memo = box.querySelector<HTMLInputElement>("[data-note-memo]");
  memo?.addEventListener("change", () => save({ memo: memo.value.trim() }));
  memo?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") memo.blur();
  });
  box.querySelector("[data-note-clear]")?.addEventListener("click", () => {
    state.notes.delete(id);
    saveNotes(state);
    renderChecks(state);
    if (state.step === 5) renderStep(state);
    selectSegment(state, id, false);
  });
}

function saveNotes(state: AppState) {
  persist(state);
}

/** 区切りの判定を人が直すフォーム（F10）。開いたときは今の値が入っている。
 * 確信だけは「高」を初期値にする：人が目で確かめて記録するのだから、Claude の「低」を引き継ぐと「確かめる所」に残り続けるため */
function fixForm(j: Judgment | undefined, open: boolean): string {
  const tree = j?.tree ?? 0;
  return `<details class="fix" ${open || j?.by === "人" ? "open" : ""}>
    <summary>この区切りを直す ${help(HELP.fix)}</summary>
    <form data-fix>
      <div class="field"><span>木の割合</span><div class="radios">${[0, 25, 50, 75, 100].map((v) => `<label><input type="radio" name="tree" value="${v}" ${v === tree ? "checked" : ""}>${v}%</label>`).join("")}</div></div>
      <div class="field"><span>樹種</span><select name="kind">${TREE_KINDS.map((k) => `<option ${k === (j?.kind ?? "なし") ? "selected" : ""}>${k}</option>`).join("")}</select></div>
      <div class="field"><span>確信</span><select name="conf">${CONFS.map((c) => `<option ${c === (j?.by === "人" ? j.conf : "高") ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><span>メモ</span><input name="why" value="${escapeHtml(j?.by === "人" ? j.why : "")}" placeholder="現地で見た、など"></div>
      <div class="row end"><button class="btn primary" type="submit">人の判定として記録する</button>${j?.prev ? `<button class="btn" type="button" data-undo-fix>元に戻す</button>` : ""}</div>
    </form>
  </details>`;
}

function stripPrev(j: Judgment): Omit<Judgment, "prev"> {
  const { prev: _prev, ...rest } = j;
  return rest;
}

function wireFixForm(state: AppState, id: string) {
  const form = document.querySelector<HTMLFormElement>("#detail-body form[data-fix]");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const old = state.judgments.get(id);
    const kind = String(fd.get("kind"));
    const conf = String(fd.get("conf"));
    const fixed: Judgment = {
      segmentId: id,
      tree: Number(fd.get("tree")),
      kind: (TREE_KINDS as string[]).includes(kind) ? (kind as TreeKind) : "なし",
      other: old?.other ?? [],
      conf: (CONFS as string[]).includes(conf) ? (conf as Confidence) : "高",
      why: String(fd.get("why") ?? "").trim() || "人が直した",
      by: "人",
      // 直す前の判定は 1 つだけ覚える（人が何度直しても、戻る先は Claude の判定）
      prev: old ? (old.by === "人" && old.prev ? old.prev : stripPrev(old)) : undefined,
    };
    state.judgments.set(id, fixed);
    state.unjudged.delete(id);
    refreshJudgments(state);
    renderChecks(state);
    if (state.step === 5) renderStep(state);
    selectSegment(state, id, false);
  });
  form.querySelector("[data-undo-fix]")?.addEventListener("click", () => {
    const cur = state.judgments.get(id);
    if (!cur?.prev) return;
    state.judgments.set(id, { ...cur.prev });
    refreshJudgments(state);
    if (state.step === 5) renderStep(state);
    selectSegment(state, id, false);
  });
}

function shortModel(m: string): string {
  return m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2");
}

function boundsOf(ring: Position[]): [[number, number], [number, number]] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [[minX, minY], [maxX, maxY]];
}

/* ---------- 一覧 ---------- */

/** 絞り込みのチップ。押されているものに色を付ける */
function chips<T extends string>(defs: { id: T; label: string; tip: string }[], current: T): string {
  return defs.map((d) => `<button class="chip ${d.id === current ? "active" : ""}" data-filter="${d.id}" title="${escapeHtml(d.tip)}">${d.label}</button>`).join("");
}

/** 絞り込みの操作。チップと検索欄は panels.ts に置いたままなので、1 回だけつなぐ */
function wireFilters(state: AppState) {
  document.getElementById("hit-chips")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
    if (!b) return;
    state.filter.hits = b.dataset.filter as HitFilter;
    renderList(state);
  });
  const q = document.getElementById("hit-q") as HTMLInputElement;
  q.addEventListener("input", () => {
    state.filter.q = q.value;
    renderList(state);
  });
  document.getElementById("check-chips")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
    if (!b) return;
    state.filter.checks = b.dataset.filter as CheckFilter;
    state.lowCursor = -1; // 番号が絞り込みの中の順になるので、振り出しに戻す
    renderChecks(state);
    if (state.step === 5) renderStep(state);
  });
}

function renderList(state: AppState) {
  document.getElementById("list-count")!.textContent = `${state.hits.length} 筆`;
  document.getElementById("hit-chips")!.innerHTML = chips(HIT_FILTERS, state.filter.hits);
  const shown = filterHits(state.hits, state.filter.hits, state.filter.q, {
    parcelById: state.parcelById,
    judgments: state.judgments,
    checkSegs: new Set(checkList(state).map((c) => c.segmentId)),
    forest: state.forest,
    notes: state.notes,
  });
  document.getElementById("hit-shown")!.textContent = shown.length !== state.hits.length ? `${shown.length} / ${state.hits.length} 筆` : "";
  if (!shown.length) {
    document.getElementById("list-body")!.innerHTML = `<p class="empty">${state.hits.length ? "この絞り込みに合う筆はありません。" : state.parcels.length ? "かかる筆がありません。" : "公図がまだありません。手順 2 で取得するか、落としてください。"}</p>`;
    return;
  }
  const rows = shown
    .map((h) => {
      const p = state.parcelById.get(h.parcelId)!;
      const t = treeOfParcel(state, h);
      const treeCell = t ? `<span class="tree-bar" title="木の割合の最大 ${t.tree}%"><i style="width:${t.tree}%"></i></span> ${t.tree}%` : `<span class="muted">—</span>`;
      const fi = state.forest?.get(h.parcelId);
      const forestCell = !state.forest ? `<span class="muted">…</span>` : !fi || fi.ratio < 0.02 ? `<span class="muted">外</span>` : `<span title="${escapeHtml(forestText(fi))}">${fi.ratio < 0.5 ? "一部" : fi.kinds.includes("国有林") ? "国有" : "民有"}</span>`;
      return `<tr data-id="${escapeHtml(h.parcelId)}" class="${h.parcelId === state.selectedParcel ? "selected" : ""}">
        <td class="num">${h.fromM}〜${h.toM}</td><td class="opt">${h.sides.map((s) => (s === "L" ? "左" : "右")).join("・")}</td>
        <td title="${escapeHtml(p.properties.oaza ?? "")}">${escapeHtml(p.properties.chiban)}</td>
        <td class="num">${h.areaM2}</td><td>${treeCell}</td><td class="opt">${forestCell}</td></tr>`;
    })
    .join("");
  document.getElementById("list-body")!.innerHTML = `<table class="list"><thead><tr>
    <th>起点から m</th><th class="opt">左右</th><th>地番</th><th>かかる m²</th><th>木（推定）</th><th class="opt" title="森林の区域（林野庁）">森林</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  document.querySelectorAll<HTMLTableRowElement>("table.list tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => selectParcel(state, tr.dataset.id!, true)),
  );
}

/* ---------- 森林の区域（林野庁） ---------- */

/** 区間の周り（左右 300m ほど）のタイルを読み、かかる筆ごとの重なりを出す。失敗しても道具は動く（列が空になるだけ） */
async function loadForest(state: AppState) {
  const dense = state.dense;
  const lls = dense.filter((_, i) => i % 20 === 0).map((p) => toLonLat(p));
  const pad = 0.004; // 経度・緯度で約 300〜400m
  const bbox: [number, number, number, number] = [Math.min(...lls.map((c) => c[0])) - pad, Math.min(...lls.map((c) => c[1])) - pad, Math.max(...lls.map((c) => c[0])) + pad, Math.max(...lls.map((c) => c[1])) + pad];
  try {
    const r = await fetchForest(bbox);
    if (state.dense !== dense) return; // 読んでいる間に中心線が変わった
    if (r.failed) {
      // 1 枚でも読めなければ区域は「未取得」のまま。欠けたタイルの筆が「区域外」と出て、CSV・KML にも確定した値として
      // 入ってしまう（Codex の指摘 2026-11-04）。列は空のまま、読み直しは案件を開き直して
      state.forestNote = `森林の区域：タイル ${r.tiles} 枚のうち ${r.failed} 枚を読めませんでした（区域の列は空のまま。通信を確かめて、ページを開き直すと読み直します）`;
      console.warn(state.forestNote);
    } else {
      state.forestIndex = new ForestIndex(r.polygons);
      recomputeForest(state);
      // 点線（確かめる所）に食い違いを反映する
      state.segmentsGeo = applyJudgments(segmentsToGeoJSON(state.segments), state.judgments, state.forestFlags);
      setSourceData(state.map, "segments", state.segmentsGeo);
      const asOf = r.polygons.find((p) => p.asOf)?.asOf ?? "";
      state.forestNote = `森林の区域：林野庁（データ時点 ${asOf}）`;
      console.info(`${state.forestNote}。多角形 ${r.polygons.length}`);
    }
  } catch (e) {
    if (state.dense !== dense) return;
    state.forestNote = `森林の区域を読めませんでした：${(e as Error).message}`;
  }
  renderList(state);
  renderChecks(state);
  if ([3, 5, 7].includes(state.step)) renderStep(state);
  if (state.selectedParcel) selectParcel(state, state.selectedParcel, false);
  if (state.selectedSegment) selectSegment(state, state.selectedSegment, false);
}

/** 筆ごと・区切りごとの区域の重なりと、判定との食い違いを出し直す（区切りや判定が変わったとき） */
function recomputeForest(state: AppState) {
  if (!state.forestIndex) return;
  state.forest = forestOfHits(state.hits, state.forestIndex);
  state.segForest = forestOfSegments(state.segments, state.forestIndex, state.dense, state.normals, state.track.band.roadHalf);
  state.forestFlags = forestMismatch(state.segments, state.judgments, state.segForest);
}

function forestCount(state: AppState): { minyu: number; part: number; koku: number } {
  let minyu = 0;
  let part = 0;
  let koku = 0;
  for (const h of state.hits) {
    const fi = state.forest?.get(h.parcelId);
    if (!fi || fi.ratio < 0.02) continue;
    if (fi.kinds.includes("国有林")) koku++;
    if (fi.kinds.includes("民有林")) {
      minyu++;
      if (fi.ratio < 0.5) part++;
    }
  }
  return { minyu, part, koku };
}

function forestSummary(state: AppState): string {
  if (!state.forest) return escapeHtml(state.forestNote);
  const { minyu, part, koku } = forestCount(state);
  return `${minyu} 筆が森林計画の対象の民有林の区域にかかります（一部だけ ${part}${koku ? `、国有林 ${koku}` : ""}）。一覧表では「伐採の届出が要るかもしれない（市町村に確かめる）」の目印が付きます。`;
}

/* ---------- 持って歩く地図（F8） ---------- */

function walkMapInput(state: AppState, withPhoto: boolean): WalkMapInput {
  const vehicleZones = state.track.source.kind === "vehicle" ? state.track.source.tiltZones : [];
  const band = state.track.source.kind === "band";
  const demo = !state.parcelSource.fromFile && state.centerline.source.kind === "demo";
  return {
    title: document.getElementById("project-name")?.textContent ?? state.roadName,
    roadName: state.roadName,
    dense: state.dense,
    normals: state.normals,
    segments: state.segments,
    parcels: state.parcels,
    hits: state.hits,
    judgments: state.judgments,
    kps: state.kps,
    sweep: band ? null : state.trackResult.sweep,
    outer: band ? null : state.trackResult.outer,
    tiltZones: vehicleZones,
    trackText: describeTrack(state.track),
    withPhoto,
    forest: state.forest,
    forestFlags: state.forestFlags,
    notes: state.notes,
    unjudged: state.unjudged,
    mojAttribution: mojAttribution(state.parcelSource.fromFile ? { fileName: "", maps: state.parcelSource.maps, skipped: [], features: [] } : null, demo),
  };
}

async function exportWalkMap(state: AppState, withPhoto: boolean) {
  if (state.pdfRun) return;
  state.pdfError = null;
  const input = walkMapInput(state, withPhoto);
  state.pdfRun = { done: 0, total: walkMapPageCount(input) };
  renderStep(state);
  try {
    const blob = await buildWalkMap(input, (done, total) => {
      state.pdfRun = { done, total };
      if (state.step === 7) renderStep(state);
    });
    const day = new Date().toISOString().slice(0, 10);
    const stem = (state.roadName || state.name).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 30) || "案件";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `arukumae_${stem}_持って歩く地図_${day}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    console.info(`PDF ${Math.round(blob.size / 1024)} KB`);
  } catch (e) {
    state.pdfError = `PDF を作れませんでした：${(e as Error).message}`;
    console.error(e);
  } finally {
    state.pdfRun = null;
    if (state.step === 7) renderStep(state);
  }
}

/* ---------- 凡例と表示の切り替え ---------- */

function renderLegend(state: AppState) {
  const groups: { key: LayerGroup; label: string; sub?: string; indent?: boolean }[] = [
    {
      key: "photo",
      label: "航空写真（国土地理院）",
      sub: `<label class="year">年 ${help(HELP.photoYear)} <select id="photo-year"><option value="">最新</option>${PHOTO_YEARS.map((y) => `<option value="${y}" ${state.photoYear === y ? "selected" : ""}>${y} 年度</option>`).join("")}</select></label>`,
    },
    { key: "forest", label: "森林計画の対象森林（林野庁）", sub: `<span><i class="sw" style="background:#43a04730;border-color:#2e7d32"></i>民有林</span><span><i class="sw" style="background:#1b5e2040;border-color:#1b5e20"></i>国有林</span>` },
    {
      key: "parcels",
      label: "公図の筆（法務省）",
      sub:
        `<span><i class="sw" style="border-color:#ffd600;border-width:2px"></i>かかる筆</span>` +
        Object.entries(KIND_COLORS)
          .filter(([k]) => !NOT_LAND.has(k as ParcelKind))
          .map(([k, c]) => `<span><i class="sw" style="background:${c}"></i>${kindLabel(k as ParcelKind)}</span>`)
          .join("") +
        `<span><i class="sw" style="border-style:dashed;border-color:#9e9e9e"></i>地区外・別図（隣の地図を見よ）</span>`,
    },
    // 公図の線は見たいが塗りは要らない（写真を見たい）ときがあるので、かかる部分の塗りだけ別に消せる
    { key: "hits", label: `<i class="sw" style="background:#ffeb3b;border-color:#ffd600"></i> かかる部分の塗り`, indent: true },
    {
      key: "segments",
      label: "区切り（木の判定）",
      sub: [["未判定", "rgba(200,200,200,0.5)"], ["0%", "rgba(255,255,255,0.6)"], ["25", "rgba(255,235,59,0.7)"], ["50", "rgba(255,152,0,0.7)"], ["75", "rgba(244,81,30,0.7)"], ["100", "rgba(183,28,28,0.7)"]]
        .map(([k, c]) => `<span><i class="sw" style="background:${c}"></i>${k}</span>`).join("") + `<span>点線＝確信が低い</span><span><i class="sw" style="border:2px solid #1565c0"></i>人が直した</span>`,
    },
    { key: "track", label: "軌跡（手順 2）", sub: `<span><i class="sw" style="background:#7b1fa233;border-color:#7b1fa2"></i>掃く範囲</span><span><i class="sw" style="border-style:dashed;border-color:#ff9800;border-width:2px"></i>伐採範囲の外側</span>` },
    { key: "section", label: "輸送路の中心線" },
    { key: "kps", label: "距離標（人が置いた。手順 6）" },
  ];
  document.getElementById("legend-body")!.innerHTML =
    groups.map((g) => `<label class="${g.indent ? "indent" : ""}"><input type="checkbox" data-group="${g.key}" checked> ${g.label}</label>${g.sub ? `<div class="sub">${g.sub}</div>` : ""}`).join("") +
    `<button class="btn small ghost" data-legend-more type="button">色の意味を見る</button>`;
  document.querySelector("[data-legend-more]")?.addEventListener("click", (e) => {
    const legend = document.getElementById("legend")!;
    legend.classList.toggle("full");
    (e.currentTarget as HTMLButtonElement).textContent = legend.classList.contains("full") ? "色の意味をたたむ" : "色の意味を見る";
  });
  document.querySelectorAll<HTMLInputElement>("[data-group]").forEach((cb) =>
    cb.addEventListener("change", () => {
      setGroupVisible(state.map, cb.dataset.group as LayerGroup, cb.checked);
      // 写真の群は年度別の層も含む。年を選んでいないときは年度別の層を出さない
      if (cb.dataset.group === "photo") setPhotoYear(state.map, state.photoYear, cb.checked);
    }),
  );
  document.getElementById("photo-year")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    state.photoYear = v || null;
    localStorage.setItem(PHOTO_YEAR_KEY, state.photoYear ?? "");
    const on = document.querySelector<HTMLInputElement>('[data-group="photo"]')?.checked ?? true;
    setPhotoYear(state.map, state.photoYear, on);
  });
}

/* ---------- 設定（鍵・モデル） ---------- */

function getApiKey(): string {
  return localStorage.getItem("arukumae.apiKey") ?? sessionStorage.getItem("arukumae.apiKey") ?? "";
}

const PHOTO_YEAR_KEY = "arukumae.photoYear";

function loadPhotoYear(): PhotoLayer | null {
  const v = localStorage.getItem(PHOTO_YEAR_KEY) ?? "";
  return PHOTO_YEARS.includes(v) ? v : null;
}

/** Google Earth（ウェブ）をその場所で開くリンク。人が見るためのもので、画像は取り込まない（HELP.earth） */
function earthLink([lon, lat]: [number, number]): string {
  return `<a href="https://earth.google.com/web/@${lat.toFixed(6)},${lon.toFixed(6)},0a,300d,35y,0h,0t,0r" target="_blank" rel="noopener">Google Earth で見る ↗</a> ${help(HELP.earth)}`;
}

function ringCenter(ring: Position[]): [number, number] {
  const pts = ring.length > 1 ? ring.slice(0, -1) : ring;
  return [pts.reduce((s, c) => s + c[0], 0) / pts.length, pts.reduce((s, c) => s + c[1], 0) / pts.length];
}

function getSettings(): { model: ModelId; review: ModelId | ""; photo2: PhotoLayer | "" } {
  const model = (localStorage.getItem("arukumae.model") as ModelId | null) ?? "claude-sonnet-5-5";
  const review = (localStorage.getItem("arukumae.review") ?? "claude-fable-5-1") as ModelId | "";
  const photo2 = localStorage.getItem("arukumae.photo2") ?? "";
  return { model: model in MODELS ? model : "claude-sonnet-5-5", review: review === "" || review in MODELS ? review : "claude-fable-5-1", photo2: PHOTO_YEARS.includes(photo2) ? photo2 : "" };
}

function wireSettings(state: AppState) {
  const key = document.getElementById("api-key") as HTMLInputElement;
  const remember = document.getElementById("remember-key") as HTMLInputElement;
  const modelSel = document.getElementById("model-main") as HTMLSelectElement;
  const reviewSel = document.getElementById("model-review") as HTMLSelectElement;
  const photoSel = document.getElementById("photo-second") as HTMLSelectElement;
  for (const y of PHOTO_YEARS) photoSel.add(new Option(`${y} 年度の写真`, y));
  // 既定はその場限り（sessionStorage）。「記憶する」を選んだときだけ localStorage に残す（spec §12）
  key.value = getApiKey();
  remember.checked = localStorage.getItem("arukumae.apiKey") !== null;
  const { model, review } = getSettings();
  modelSel.value = model;
  reviewSel.value = review;
  photoSel.value = getSettings().photo2;
  const save = () => {
    const v = key.value.trim();
    sessionStorage.setItem("arukumae.apiKey", v);
    if (remember.checked && v) localStorage.setItem("arukumae.apiKey", v);
    else localStorage.removeItem("arukumae.apiKey");
    localStorage.setItem("arukumae.model", modelSel.value);
    localStorage.setItem("arukumae.review", reviewSel.value);
    localStorage.setItem("arukumae.photo2", photoSel.value);
    if (state.step === 4) renderStep(state); // 鍵の有無と費用の目安をボタンに反映する
  };
  for (const el of [key, remember, modelSel, reviewSel, photoSel]) el.addEventListener("change", save);
  document.getElementById("settings-dialog")!.addEventListener("close", save);
}

main().catch((e) => {
  console.error(e);
  document.getElementById("app")!.innerHTML = `<p style="padding:20px">読み込みに失敗しました：${escapeHtml(String(e))}</p>`;
});
