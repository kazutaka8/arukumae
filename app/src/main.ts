/**
 * アルクマエの入口。見本のデータを読み、地図とパネルを組む。
 * 手順 1・3〜7 を触れる。2（取り込み）と 7 の PDF はまだ骨。
 */
import "./style.css";
import type { FeatureCollection, Point, Polygon, Position } from "geojson";
import type { LngLatBoundsLike, MapGeoJSONFeature, Map as MlMap, GeoJSONSource } from "maplibre-gl";
import { buildRows, download, toCsv } from "./core/export";
import { leftNormals, nearestOnLine, resample, type Segment } from "./core/geom";
import { estimateKp, fmtKm, formatKp, type KpMark } from "./core/kp";
import { estimateCost, fmtUsd, judgeWindow, makeClient, MODELS, type ModelId } from "./core/judge";
import { findHits, hitsToGeoJSON, segmentsToGeoJSON, type ParcelFeature } from "./core/parcels";
import { renderWindow, windowsOf } from "./core/photo";
import { toLonLat, toPlane, type EN } from "./core/proj";
import { linesToPlane, parseTrackFile, trackGeoJSON, trackKml } from "./core/track";
import { computeTrack, DEFAULT_TRACK, describeTrack, loadTrack, saveTrack, type TrackResult, type TrackSetting } from "./core/trackstate";
import { bladeHorizontal, DEFAULT_BAND, PRESETS, sweepMax, type PresetId, type TiltZone, type Vehicle } from "./core/vehicle";
import { buildWalkMap, pagesOf, type WalkMapInput } from "./core/walkmap";
import { fetchForest, ForestIndex, forestMismatch, forestOfHits, forestOfSegments, forestText, noticeText, type ForestInfo, type SegmentForest } from "./core/forest";
import { listChecks, type Check } from "./core/checks";
import { NOT_LAND, type Confidence, type Judgment, type ParcelHit, type ParcelKind, type TreeKind } from "./core/types";
import { loadDemoJudgments, loadParcels, loadSection } from "./data/demo";
import { addKps, addParcels, addSection, addSegments, addTrack, applyJudgments, createMap, KIND_COLORS, setGroupVisible, setSourceData, type LayerGroup } from "./map/map";
import { buildLayout, escapeHtml, help, leftCover, openDetail, renderSteps, rightCover, showListTab, STEPS } from "./ui/panels";

interface AppState {
  map: MlMap;
  step: number;
  /** 中心線を 1m ごとに打ち直した点。添字＝起点からの距離（m） */
  dense: EN[];
  normals: EN[];
  roadName: string;
  /** 伐採範囲の決め方（手順 2）と、その計算の結果 */
  track: TrackSetting;
  trackResult: TrackResult;
  /** 手順 2 で読み込みに失敗したときの言葉 */
  trackError: string | null;
  segments: Segment[];
  segmentsGeo: FeatureCollection<Polygon>;
  parcels: ParcelFeature[];
  parcelById: Map<string, ParcelFeature>;
  hits: ParcelHit[];
  hitById: Map<string, ParcelHit>;
  judgments: Map<string, Judgment>;
  demoJudgments: Judgment[];
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
}

// 見本の案件の判定を、この端末に残す鍵。利用者が自分の鍵で払って得た判定を、ページを開き直して失わせないため
const JUDGMENTS_KEY = "arukumae.judgments.ogawa";
const KPS_KEY = "arukumae.kps.ogawa";
const TRACK_KEY = "arukumae.track.ogawa";

async function main() {
  const root = document.getElementById("app")!;
  buildLayout(root);

  const [section, parcelsFc, demoJudgments] = await Promise.all([loadSection(), loadParcels(), loadDemoJudgments()]);
  const line = section.features[0].geometry.coordinates.map((c) => toPlane([c[0], c[1]]) as EN);
  const dense = resample(line, 1);
  const normals = leftNormals(dense);
  const track = loadTrack(TRACK_KEY) ?? DEFAULT_TRACK;
  const trackResult = computeTrack(dense, normals, track);
  const segments = trackResult.segments;
  const parcels = parcelsFc.features as ParcelFeature[];
  const t0 = performance.now();
  const hits = findHits(parcels, segments);
  console.info(`かかる筆 ${hits.length} 筆（${Math.round(performance.now() - t0)}ms）`);

  const saved = loadSavedJudgments();
  const judgments = new Map((saved ?? demoJudgments).map((j) => [j.segmentId, j]));
  const segmentsGeo = applyJudgments(segmentsToGeoJSON(segments), judgments);

  const mid = section.features[0].geometry.coordinates[Math.floor(section.features[0].geometry.coordinates.length / 2)];
  const map = createMap(document.getElementById("map")!, [mid[0], mid[1]]);

  const state: AppState = {
    map,
    step: 3,
    dense,
    normals,
    roadName: section.features[0].properties.road_name,
    track,
    trackResult,
    trackError: null,
    segments,
    segmentsGeo,
    parcels,
    parcelById: new Map(parcels.map((p) => [p.properties.id, p])),
    hits,
    hitById: new Map(hits.map((h) => [h.parcelId, h])),
    judgments,
    demoJudgments,
    selectedParcel: null,
    selectedSegment: null,
    lowCursor: -1,
    kps: loadJson<KpMark[]>(KPS_KEY) ?? [],
    placingKp: false,
    placingTilt: null,
    run: null,
    pdfRun: null,
    pdfError: null,
    forestIndex: null,
    forest: null,
    segForest: null,
    forestFlags: null,
    forestNote: "森林の区域を読んでいます…",
  };

  // 開発のときだけ、ブラウザの console から地図と状態をさわれるようにする（確かめ用）
  if (import.meta.env.DEV) (window as unknown as { __arukumae: unknown }).__arukumae = { map, state, t0: performance.now(), walkMapInput };

  map.on("load", () => {
    addParcels(map, parcelsFc, hitsToGeoJSON(hits));
    addSegments(map, segmentsGeo);
    addTrack(map, trackGeo(state));
    addSection(map, section);
    addKps(map, kpsGeo(state));
    for (const h of state.hits) map.setFeatureState({ source: "parcels", id: h.parcelId }, { hit: true });
    wireMapClicks(state);
    renderLegend(state);
  });

  document.getElementById("project-name")!.textContent = `${section.features[0].properties.road_name}（見本）`;
  loadForest(state);
  renderStep(state);
  renderList(state);
  renderChecks(state);
  wireSettings(state);
}

const HELP = {
  band: "伐採範囲：掃く範囲（軌跡図、または車両の寸法から計算した架空の軌跡図）に余裕幅を足し、そのさらに外へ伐採の幅を足したもの。道路の端（中心線から道路の半幅）より外の部分だけを区切りにします。手順 2 で決め方を変えられます。",
  segment: "区切り：伐採範囲を道に沿って 10m ごと、左右別に分けたもの。番号 L032 は「起点から 320〜330m の左」。この1つずつについて、木の有無を航空写真から判定します。",
  judged: "判定が付いている区切りの数。見本として最初から入っている Claude の判定、この道具から Claude に判定させたもの、人が直したものを合わせた数です。",
  check: "確かめる所：(1) Claude の確信が「低」だった区切り（写真がぼやける・影で見えない・枠の位置が読みにくい、など）と、(2) 森林の区域（林野庁）と判定が食い違う区切り（区域の中なのに木が 25% 以下、区域の外なのに木が 75% 以上。区域の縁から 15m 以内は指摘しない）。現地で見る候補として一覧に並べています。",
  review: "見直し：最初のモデル（Sonnet）の確信が低かった区切りだけ、上位のモデル（Fable）に同じ写真をもう一度見せます。最初の判定は見せません（引きずられないように）。",
  kp: "KP（キロポスト）：道路管理者が決めた、その道路の起点からの距離（km）。道ばたの距離標に書いてあります。位置も値も公開データに無いので、現地やストリートビューで人が読んだ距離標を 2 本以上置くと、その間を中心線に沿って直線で補間します。「起点からの距離（m）」はこの案件の区間の起点から測ったもので、KP とは別の物差しです。",
  forest: "森林の区域：林野庁の「森林計画対象森林レイヤ」（地域森林計画の対象の民有林と国有林の区域、林班）。筆のかかる部分がこの区域にどれだけ入るかを測り、半分未満なら「一部」と書きます。伐採の届出が要るかどうかは、登記の地目ではなく、この民有林の区域かどうかで決まるとされています（自分の理解。森林法第10条の8）。道具は目印を付けるまでで、要否は所管の市町村に確かめてください。区域の線は 1/5,000 相当で、筆の境界とはふつうずれます。",
  walkmap: "持って歩く地図：A4 の PDF。1 ページ目が区間全体の索引図、2 ページ目からは起点から約 200m ずつ（木の判定の窓と同じ分け方）。航空写真の上に掃く範囲・伐採範囲・筆と地番・区切り（判定の色と番号）・起点からの距離と KP を重ね、下に「現地で確かめる所」の表と、○×・メモを手で書く欄を付けます。文字も絵として入れているので、PDF の中の文字は検索できません。",
  tiltZone: "起立の区間：ブレードを立てられる所と角度を、場所ごとに決めます。電線をくぐる所や橋の下では立てられないので、全部の曲がりで立てるとは限りません。区間はブレードの根元がいる位置で見ます。区間の外は基本の角度（既定は 0°＝寝かせる。広めに出るので安全側）。",
  vehicle: "追従の計算：前軸が中心線をたどり、キングピンと台車の軸がそれを追います（引かれる点はいつも引く点の真後ろ）。曲がりでは台車が内側に切れ込み、ブレードは内側を弦のように横切り、先は外へ振れます。多軸台車は後輪も操舵するので、実際の切れ込みはこれより小さいことが多く、ここでは広め（安全側）に出ます。高さは見ません。",
  fix: "直す：Claude の判定を人の目で直します。直した区切りは「人」と記録され、地図では青い枠、一覧表では「決めたのは：人」になります。元に戻すこともできます。",
};

/* ---------- 手順 ---------- */

function renderStep(state: AppState) {
  renderSteps(state.step, (n) => {
    state.step = n;
    renderStep(state);
  });
  const s = STEPS[state.step - 1];
  const body = document.getElementById("step-body")!;
  const parts: string[] = [`<h3>${s.n}. ${s.title}</h3><p>${s.hint}</p>`];
  switch (state.step) {
    case 1:
      parts.push(`<dl class="kv"><dt>案件名</dt><dd>小川村 県道401号（見本）</dd><dt>向き</dt><dd>南 → 北</dd><dt>区間</dt><dd>約 ${state.dense.length - 1} m</dd><dt>伐採範囲</dt><dd>${escapeHtml(describeTrack(state.track))} ${help(HELP.band)}</dd></dl>`);
      parts.push(`<div class="next">次は、公図と軌跡図を取り込みます。見本では公図は取り込み済みで、軌跡図は車両の寸法から架空のものを作っています。</div>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="2">次へ：取り込み</button></div>`);
      break;
    case 2:
      parts.push(renderTrackStep(state));
      break;
    case 3: {
      const kinds = countKinds(state);
      parts.push(`<p><b>${state.hits.length} 筆</b>が伐採範囲 ${help(HELP.band)} にかかります（${kinds}）。地図の濃い黄色が、筆のうち伐採範囲と重なる部分です。右の一覧の行を押すと、地図がそこへ飛びます。</p>`);
      parts.push(`<p>${forestSummary(state)} ${help(HELP.forest)}</p>`);
      parts.push(`<div class="next">漏れを出さないため、ここは AI ではなく計算で決めています。「地区外」「別図」は隣の地図を指す印なので数えていません。</div>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="4">次へ：木を判定する</button></div>`);
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
      parts.push(`<p>確かめる所 ${help(HELP.check)}：<b>${lows.length}</b>（確信が低い ${lows.length - forestN}・森林の区域と食い違う ${forestN}）。${reviewed.length ? `うち ${reviewed.length} 区切りは上位のモデルが見直し済み ${help(HELP.review)}。` : ""}右の一覧にも並んでいます。</p>`);
      const pos = state.lowCursor >= 0 && state.lowCursor < lows.length ? `${state.lowCursor + 1} / ${lows.length}` : `— / ${lows.length}`;
      parts.push(`<div class="nav"><button class="btn" data-prev-low ${lows.length ? "" : "disabled"}>← 前</button><span class="pos">${pos}</span><button class="btn" data-next-low ${lows.length ? "" : "disabled"}>次 →</button></div>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="6">次へ：KP</button></div>`);
      showListTab("checks");
      break;
    }
    case 6: {
      const marks = [...state.kps].sort((a, b) => a.atM - b.atM);
      parts.push(`<p>読んだ距離標 ${help(HELP.kp)} を地図に置くと、全部の区切りと筆に「${escapeHtml(state.roadName)} ○.○○km 付近（推定）」が付きます。2 本以上要ります。</p>`);
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
      parts.push(`<p class="muted small">ストリートビューは人が見て読むだけにしています（画像を取り込んだり Claude に読ませたりはしません）。距離標と実際の距離は改築などでずれていることがあります。</p>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="7">次へ：書き出し</button></div>`);
      break;
    }
    case 7: {
      const noKp = state.kps.length < 2;
      const judged = state.judgments.size;
      parts.push(`<p>かかる筆 <b>${state.hits.length}</b> 行の一覧表です。${noKp ? "距離標が 2 本未満なので KP の列は空になります。" : ""}${judged < state.segments.length ? `判定のない区切りが ${state.segments.length - judged} あり、その分の木の面積は数えません。` : ""}</p>`);
      parts.push(`<div class="actions"><button class="btn primary" data-csv>一覧表を書き出す（CSV。Excel でそのまま開けます）</button></div>`);
      parts.push(`<p class="muted small">列：起点からの距離・左右・道路名と KP（推定）・根拠・所在・地番・種類・かかる面積・木のある面積（推定）・樹種の目安・木以外・確信・現地で確かめる所・決めたのは・森林の区域・伐採の届出の目印・備考。${state.forest ? "" : "森林の区域はまだ読めていないので空になります。"}</p>`);
      parts.push(`<h4 class="muted small" style="margin:12px 0 4px">持って歩く地図（PDF） ${help(HELP.walkmap)}</h4>`);
      if (state.pdfRun) {
        parts.push(`<div class="progress"><i style="width:${(100 * state.pdfRun.done) / state.pdfRun.total}%"></i></div><p class="small">${state.pdfRun.done} / ${state.pdfRun.total} ページを描いています…</p>`);
      } else {
        parts.push(`<div class="actions"><button class="btn primary" data-pdf>持って歩く地図を書き出す（PDF、A4 ${pagesOf(state.segments).length + 1} ページ）</button></div>`);
        parts.push(`<label class="row" style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-pdf-photo checked> 背景に航空写真を入れる（外すと線と色だけ）</label>`);
        if (state.pdfError) parts.push(`<p class="small" style="color:#c62828">${escapeHtml(state.pdfError)}</p>`);
      }
      showListTab("hits");
      break;
    }
  }
  body.innerHTML = parts.join("");
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
  body.querySelector("[data-csv]")?.addEventListener("click", () => {
    const rows = buildRows(state.hits, state.parcelById, state.judgments, state.kps, state.roadName, state.forest, state.forestFlags, state.segments);
    const day = new Date().toISOString().slice(0, 10);
    download(`arukumae_${state.roadName}_一覧表_${day}.csv`, toCsv(rows));
  });
  body.querySelector("[data-pdf]")?.addEventListener("click", () => {
    const withPhoto = (body.querySelector("[data-pdf-photo]") as HTMLInputElement | null)?.checked ?? true;
    exportWalkMap(state, withPhoto);
  });
  body.querySelector("[data-prev-low]")?.addEventListener("click", () => stepLow(state, -1));
  body.querySelector("[data-judge]")?.addEventListener("click", () => runJudging(state));
  body.querySelector("[data-cancel]")?.addEventListener("click", () => {
    if (state.run) state.run.cancel = true;
  });
  body.querySelector("[data-reset-demo]")?.addEventListener("click", () => {
    if (!confirm("判定を見本に戻します。この端末に残した判定は消えます。よいですか？")) return;
    localStorage.removeItem(JUDGMENTS_KEY);
    state.judgments = new Map(state.demoJudgments.map((j) => [j.segmentId, j]));
    refreshJudgments(state);
    renderStep(state);
  });
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
  const parts: string[] = [`<div class="track">`];
  parts.push(`<dl class="kv"><dt>公図</dt><dd>小川村 2026年版（4枚、区間の周り ${state.parcels.length} 筆）。見本では取り込み済み</dd></dl>`);
  parts.push(`<h4>伐採範囲の決め方 ${help(HELP.band)}</h4>`);
  parts.push(
    `<select class="wide" data-track-kind>
      <option value="vehicle" ${t.source.kind === "vehicle" ? "selected" : ""}>架空の軌跡図を作る（車両の寸法から）</option>
      <option value="file" ${t.source.kind === "file" ? "selected" : ""}>軌跡図のファイルを読む（KML・GeoJSON）</option>
      <option value="band" ${t.source.kind === "band" ? "selected" : ""}>仮の帯（中心線から一定の幅）</option>
    </select>`,
  );
  parts.push(`<form data-track-form>`);
  if (t.source.kind === "vehicle") {
    const v = t.source.vehicle;
    const preset = t.source.preset;
    parts.push(
      `<label class="field"><span>車両の型</span></label><select class="wide" name="preset">${(Object.keys(PRESETS) as PresetId[])
        .map((k) => `<option value="${k}" ${k === preset ? "selected" : ""}>${PRESETS[k].name}</option>`)
        .join("")}</select>`,
    );
    parts.push(`<p class="muted small">${PRESETS[preset].note}。${help(HELP.vehicle)}</p>`);
    for (const f of VEHICLE_FIELDS.filter((f) => f.main && (!f.lifterOnly || preset === "lifter"))) parts.push(numField(f.key, f.label, v[f.key], f.unit, f.step, f.min, f.max));
    parts.push(
      `<p class="muted small">水平の投影 ${bladeHorizontal(v).toFixed(1)}m（長さ × cos 角度）。ブレードの先は台車の軸の ${(v.bladeRootAt + bladeHorizontal(v) - v.kingpinToAxle).toFixed(1)}m 後ろ。</p>`,
    );
    parts.push(`<details><summary>細かい寸法（台車・トラクタ）</summary>`);
    for (const f of VEHICLE_FIELDS.filter((f) => !f.main || (f.lifterOnly && preset !== "lifter"))) parts.push(numField(f.key, f.label, v[f.key], f.unit, f.step, f.min, f.max));
    parts.push(`</details>`);
    if (preset === "lifter") parts.push(renderTiltZones(state, t.source.tiltZones));
  } else if (t.source.kind === "file") {
    parts.push(`<div class="dropzone" data-drop>ここに軌跡図（KML・GeoJSON）を落とす<br><input type="file" accept=".kml,.geojson,.json" data-track-file></div>`);
    parts.push(`<p class="muted small">線と多角形の縁を全部読み、中心線に投影して左右の幅にします。外側線・内側線・多角形のどれでも構いません。座標はこの端末の外へ出しません。KMZ は解凍して中の KML を。</p>`);
    if (t.source.lines.length) parts.push(`<p>読んだ：<b>${escapeHtml(t.source.name)}</b>（線 ${t.source.lines.length} 本）</p>`);
  } else {
    parts.push(numField("halfWidth", "中心線から外側まで", t.source.halfWidth, "m", 1, 3, 60));
  }
  if (t.source.kind !== "band") {
    parts.push(`<details ${t.source.kind === "file" ? "open" : ""}><summary>余裕幅と伐採の幅</summary>`);
    for (const f of BAND_FIELDS) parts.push(numField(`band.${f.key}`, f.label, t.band[f.key], "m", 0.5, 0, 20));
    parts.push(`</details>`);
  } else {
    parts.push(numField("band.roadHalf", "道路の半幅", t.band.roadHalf, "m", 0.5, 0, 20));
  }
  parts.push(`<div class="actions"><button class="btn primary" type="submit">${t.source.kind === "vehicle" ? "架空の軌跡図を作る" : "この範囲で拾い直す"}</button></div>`);
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
  if (judged) parts.push(`<br><span class="muted small">判定 ${judged} 区切りはそのまま残しています。範囲を変えたあとは、手順 4 で判定し直すのが確実です。</span>`);
  parts.push(`</div>`);
  if (t.source.kind !== "band") {
    parts.push(`<div class="row btns"><button class="btn small" data-save-track="kml">KML で保存</button><button class="btn small" data-save-track="geojson">GeoJSON で保存</button></div>`);
    parts.push(`<p class="muted small">${t.source.kind === "vehicle" ? "架空の軌跡図です。本物は運送会社が専用のソフトで描きます。打ち合わせの叩き台や、軌跡図が届く前の下調べに。" : "読んだ軌跡図を、この道具の形（掃く範囲と伐採範囲の外側）で書き出します。"}</p>`);
  }
  parts.push(`<div class="actions"><button class="btn primary" data-go="3">次へ：かかる筆を見る</button></div>`);
  parts.push(`</div>`);
  return parts.join("");
}

function wireTrackStep(state: AppState, body: HTMLElement) {
  body.querySelector<HTMLSelectElement>("[data-track-kind]")?.addEventListener("change", (e) => {
    const kind = (e.target as HTMLSelectElement).value as TrackSetting["source"]["kind"];
    state.trackError = null;
    if (kind === "vehicle") state.track = { ...state.track, source: { kind, preset: "lifter", vehicle: { ...PRESETS.lifter.vehicle }, tiltZones: [] } };
    else if (kind === "file") state.track = { ...state.track, source: { kind, name: "", lines: [] } };
    else state.track = { ...state.track, source: { kind, halfWidth: 13 } };
    // ファイルはまだ読んでいないので、読むまで前の範囲のまま。車両と帯はすぐ計算する
    if (kind !== "file") rebuildTrack(state);
    else renderStep(state);
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
    setTimeout(() => rebuildTrack(state), 20);
  });
  const fileInput = body.querySelector<HTMLInputElement>("[data-track-file]");
  fileInput?.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) readTrackFile(state, f);
  });
  const drop = body.querySelector<HTMLElement>("[data-drop]");
  if (drop) {
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const f = e.dataTransfer?.files?.[0];
      if (f) readTrackFile(state, f);
    });
  }
  wireTiltZones(state, body);
  body.querySelectorAll<HTMLButtonElement>("[data-save-track]").forEach((b) =>
    b.addEventListener("click", () => {
      const fc = trackGeoJSON(state.dense, state.normals, state.trackResult.sweep, state.trackResult.outer);
      const day = new Date().toISOString().slice(0, 10);
      const zones = state.track.source.kind === "vehicle" ? state.track.source.tiltZones : [];
      const zoneNote = zones.length ? `起立の区間：${zones.map((z) => `${z.fromM}〜${z.toM}m を ${z.tilt}°`).join("、")}。` : "";
      const title = `${state.roadName} ${state.track.source.kind === "vehicle" ? "架空の軌跡図" : "軌跡"}（アルクマエ）`;
      const desc = `${describeTrack(state.track)}。${zoneNote}アルクマエで ${day} に作成。${state.track.source.kind === "vehicle" ? "車両の寸法と道路の中心線（OpenStreetMap）から計算した架空の軌跡図で、実在の輸送計画ではありません。" : ""}現地の確認なしに使わないでください。`;
      if (b.dataset.saveTrack === "kml") download(`arukumae_${state.roadName}_軌跡_${day}.kml`, trackKml(fc, title, desc), "application/vnd.google-earth.kml+xml");
      else download(`arukumae_${state.roadName}_軌跡_${day}.geojson`, JSON.stringify({ ...fc, features: fc.features.filter((f) => f.properties.kind !== "tilt"), title, description: desc }), "application/geo+json");
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
    state.placingTilt = state.placingTilt ? null : { fromM: null };
    state.placingKp = false;
    state.map.getCanvas().style.cursor = state.placingTilt ? "crosshair" : "";
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
    const text = await f.text();
    const lines = parseTrackFile(f.name, text);
    if (!lines.length) throw new Error(`${f.name} に線や多角形がありません`);
    state.track = { ...state.track, source: { kind: "file", name: f.name, lines: linesToPlane(lines) } };
    state.trackError = null;
    rebuildTrack(state);
    const covered = state.trackResult.sweep.left.filter((x) => Number.isFinite(x)).length;
    if (covered === 0) state.trackError = "読めましたが、この区間の中心線の近く（120m 以内）に線がありません。別の道の軌跡図かもしれません。";
    else if (covered < state.dense.length * 0.5) state.trackError = `軌跡図が区間の一部（約 ${covered}m）しか覆っていません。覆っていない所は切らない扱いです。`;
    if (state.trackError) renderStep(state);
  } catch (e) {
    state.trackError = (e as Error).message;
    renderStep(state);
  }
}

/** 伐採範囲の決め方が変わったとき、区切り・かかる筆・地図・一覧を全部作り直す */
function rebuildTrack(state: AppState) {
  const t0 = performance.now();
  state.trackResult = computeTrack(state.dense, state.normals, state.track);
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
  saveTrack(TRACK_KEY, state.track);
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
  const { model, review } = getSettings();
  const windows = windowsOf(state.segments);
  const judged = state.judgments.size;
  const byClaude = [...state.judgments.values()].filter((j) => j.by === "Claude").length;
  const hasKey = !!getApiKey();
  const parts: string[] = [];
  const byHuman = judged - byClaude;
  parts.push(`<p>区切り ${help(HELP.segment)} は <b>${state.segments.length}</b>。判定が付いているのは <b>${judged}</b> ${help(HELP.judged)}（Claude ${byClaude}・人 ${byHuman}）。</p>`);
  parts.push(`<p class="small muted">判定は、区切り 40 ほどをまとめた写真 1 枚ずつ（${windows.length} 枚）を Claude に見せて進めます。</p>`);
  if (state.run) {
    const r = state.run;
    parts.push(`<div class="progress"><i style="width:${(100 * r.done) / r.total}%"></i></div>`);
    parts.push(`<p class="small">${r.done} / ${r.total} 窓、ここまで ${fmtUsd(r.usd)}</p>`);
    parts.push(`<pre class="log">${r.log.map((l) => (l.startsWith("!") ? `<span class="err">${escapeHtml(l.slice(1))}</span>` : escapeHtml(l))).join("\n")}</pre>`);
    parts.push(`<div class="actions"><button class="btn" data-cancel ${r.cancel ? "disabled" : ""}>${r.cancel ? "止めています…" : "止める"}</button></div>`);
  } else {
    const usd = estimateCost(windows.length, model, review);
    parts.push(
      `<div class="actions"><button class="btn primary" data-judge ${hasKey ? "" : "disabled"}>${judged ? "全部を判定し直す" : "木を判定する"} <span class="cost">約 ${fmtUsd(usd)}</span></button>` +
        (hasKey
          ? `<p class="muted small">${MODELS[model]} が全区切りを見て、確信「低」の区切りだけ${review ? ` ${MODELS[review]} が見直します ${help(HELP.review)}` : "はそのまま残します"}。送るのは航空写真の切り抜きだけです。</p>`
          : `<p class="muted small">判定には API キーが要ります。右上の「設定」で入れると押せるようになります。</p>`) +
        `</div>`,
    );
    if (localStorage.getItem(JUDGMENTS_KEY)) parts.push(`<div class="actions"><button class="btn" data-reset-demo>判定を見本に戻す</button></div>`);
    parts.push(`<div class="actions"><button class="btn primary" data-go="5">次へ：確かめて直す</button></div>`);
  }
  return parts.join("");
}

/** 判定を走らせる。窓ごとに 写真を作る → 主のモデル → 確信「低」だけ見直しのモデル。同時に 3 窓まで */
async function runJudging(state: AppState) {
  const key = getApiKey();
  if (!key || state.run) return;
  const { model, review } = getSettings();
  const client = makeClient(key);
  const windows = windowsOf(state.segments);
  state.run = { done: 0, total: windows.length, usd: 0, log: [], cancel: false };
  renderStep(state);
  const log = (s: string) => {
    state.run?.log.unshift(s);
    if (state.step === 4) renderStep(state);
  };

  const one = async (segs: Segment[], k: number) => {
    if (state.run?.cancel) return;
    const label = `${segs[0].fromM}〜${segs.at(-1)!.toM}m`;
    try {
      const images = await renderWindow(segs);
      const main = await judgeWindow(client, model, images);
      if (state.run) state.run.usd += main.usd;
      if (main.refused) {
        log(`!窓 ${k + 1}（${label}）：モデルが答えませんでした`);
      } else {
        for (const j of main.judgments) state.judgments.set(j.segmentId, j);
        log(`窓 ${k + 1}（${label}）：${main.judgments.length} 区切り、${Math.round(main.seconds)}秒、${fmtUsd(main.usd)}`);
        const lows = main.judgments.filter((j) => j.conf === "低").map((j) => j.segmentId);
        if (review && lows.length && !state.run?.cancel) {
          const second = await judgeWindow(client, review, images, lows);
          if (state.run) state.run.usd += second.usd;
          for (const j of second.judgments) {
            const first = state.judgments.get(j.segmentId)!;
            state.judgments.set(j.segmentId, { ...j, before: { tree: first.tree, conf: first.conf, model: first.model } });
          }
          const changed = second.judgments.filter((j) => j.tree !== state.judgments.get(j.segmentId)!.before!.tree).length;
          log(`　見直し ${lows.length} 区切り（${MODELS[review]}）：${changed} 区切りで木の割合が変わりました、${fmtUsd(second.usd)}`);
        }
      }
    } catch (e) {
      log(`!窓 ${k + 1}（${label}）：${(e as Error).message}`);
    } finally {
      if (state.run) state.run.done++;
      refreshJudgments(state);
      if (state.step === 4) renderStep(state);
    }
  };

  // 同時に 3 窓まで。API の同時の問い合わせの上限と、写真の取り込みの負荷の両方を抑える
  let next = 0;
  const workers = Array.from({ length: Math.min(3, windows.length) }, async () => {
    while (next < windows.length && !state.run?.cancel) {
      const k = next++;
      await one(windows[k], k);
    }
  });
  await Promise.all(workers);
  const total = state.run?.usd ?? 0;
  state.run = null;
  saveJudgments(state);
  if (state.step === 4) renderStep(state);
  console.info(`判定おわり：${fmtUsd(total)}`);
}

/** 判定が変わったとき、地図の色・一覧・詳細を合わせる */
function refreshJudgments(state: AppState) {
  if (state.segForest) state.forestFlags = forestMismatch(state.segments, state.judgments, state.segForest);
  state.segmentsGeo = applyJudgments(segmentsToGeoJSON(state.segments), state.judgments, state.forestFlags);
  (state.map.getSource("segments") as GeoJSONSource | undefined)?.setData(state.segmentsGeo);
  renderList(state);
  renderChecks(state);
  saveJudgments(state);
  if (state.selectedSegment) selectSegment(state, state.selectedSegment, false);
}

function saveJudgments(state: AppState) {
  localStorage.setItem(JUDGMENTS_KEY, JSON.stringify([...state.judgments.values()]));
}

function loadSavedJudgments(): Judgment[] | null {
  try {
    const raw = localStorage.getItem(JUDGMENTS_KEY);
    return raw ? (JSON.parse(raw) as Judgment[]) : null;
  } catch {
    return null;
  }
}

function countKinds(state: AppState): string {
  const c = new Map<ParcelKind, number>();
  for (const h of state.hits) {
    const k = state.parcelById.get(h.parcelId)!.properties.kind;
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return [...c.entries()].map(([k, n]) => `${k} ${n}`).join("・");
}

/** 確かめる所＝確信「低」の区切り。起点から順、同じ所は左→右 */
function checkList(state: AppState): Check[] {
  return listChecks(state.segments, state.judgments, state.forestFlags);
}

function stepLow(state: AppState, dir: 1 | -1) {
  const lows = checkList(state);
  if (!lows.length) return;
  state.lowCursor = (state.lowCursor + dir + lows.length) % lows.length;
  selectSegment(state, lows[state.lowCursor].segmentId, true);
  if (state.step === 5) renderStep(state);
}

/** 「確かめる所」の一覧。行を押すとそこへ飛び、何番目かが手順 5 の表示と合う */
function renderChecks(state: AppState) {
  const lows = checkList(state);
  document.getElementById("check-count")!.textContent = `${lows.length}`;
  const body = document.getElementById("check-body")!;
  if (!lows.length) {
    body.innerHTML = `<p class="empty">まだありません。手順 4 で判定すると、確信が「低」だった区切りと、森林の区域と食い違う区切りがここに並びます。</p>`;
    return;
  }
  const rows = lows
    .map((c, i) => {
      const seg = state.segments.find((s) => s.id === c.segmentId);
      const j = state.judgments.get(c.segmentId);
      const side = c.segmentId.startsWith("L") ? "左" : "右";
      const tag = c.kind === "森林" ? `<span class="badge forest">森林</span>` : j?.before ? `<span class="badge">見直し済</span>` : `<span class="badge low">低</span>`;
      return `<tr data-seg="${c.segmentId}" class="${c.segmentId === state.selectedSegment ? "selected" : ""}">
        <td class="num">${i + 1}</td><td class="num">${seg ? `${seg.fromM}〜${seg.toM}` : ""}</td><td>${side}</td>
        <td class="num">${c.tree}%</td><td>${tag}</td>
        <td class="muted" title="${escapeHtml(c.why)}">${escapeHtml(c.why.length > 18 ? c.why.slice(0, 18) + "…" : c.why)}</td></tr>`;
    })
    .join("");
  body.innerHTML = `<table class="list"><thead><tr><th>#</th><th>起点から m</th><th>左右</th><th>木</th><th>種類</th><th>理由</th></tr></thead><tbody>${rows}</tbody></table>`;
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
    if (state.placingKp) return placeKp(state, [e.lngLat.lng, e.lngLat.lat]);
    if (state.placingTilt) return placeTilt(state, [e.lngLat.lng, e.lngLat.lat]);
    // 区切りの上では区切りを優先。筆は、地区外・別図でないものを優先する（地区外の区画は隣の地図の筆を丸ごと覆っているため）
    const seg = map.queryRenderedFeatures(e.point, { layers: ["segments-fill"] })[0];
    if (seg) return selectSegment(state, seg.properties.id as string, false);
    const fs = map.queryRenderedFeatures(e.point, { layers: ["parcels-fill"] }) as MapGeoJSONFeature[];
    const f = fs.find((f) => !NOT_LAND.has(f.properties.kind as ParcelKind)) ?? fs[0];
    if (f) selectParcel(state, f.properties.id as string, false);
  });
  for (const layer of ["segments-fill", "parcels-fill"]) {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
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
  localStorage.setItem(KPS_KEY, JSON.stringify(state.kps));
  renderList(state);
  if (state.selectedSegment) selectSegment(state, state.selectedSegment, false);
  else if (state.selectedParcel) selectParcel(state, state.selectedParcel, false);
}

/** 起点からの距離 m の KP の表示。距離標が足りなければ空 */
function kpText(state: AppState, m: number): string {
  const est = estimateKp(state.kps, m);
  return est ? `${escapeHtml(formatKp(state.roadName, est))}<br><span class="muted small">${est.basis}</span>` : `<span class="muted">距離標を 2 本以上置くと出ます（手順 6）</span>`;
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
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
  openDetail(
    `${p.properties.oaza ?? ""} ${p.properties.chiban}`,
    `<dl class="kv">
      <dt>種類</dt><dd><span class="badge" style="background:${KIND_COLORS[p.properties.kind]}">${p.properties.kind}</span></dd>
      ${notLand ? `<dd style="grid-column:1/-1" class="muted small">土地ではなく「この地図ではここから先は描いていない」という印です。この中の筆は隣の地図に載っています。</dd>` : ""}
      <dt>かかる</dt><dd>${h ? `はい。${h.areaM2} m²` : "いいえ"}</dd>
      ${h ? `<dt>起点から</dt><dd>${h.fromM}〜${h.toM} m（${h.sides.map((s) => (s === "L" ? "左" : "右")).join("・")}）</dd>` : ""}
      ${h ? `<dt>木（推定）</dt><dd>${tree ? `最大 ${tree.tree}%（${tree.n} 区切り）` : '<span class="muted">まだ判定していません</span>'}</dd>` : ""}
      ${h ? `<dt>KP（推定）</dt><dd>${kpText(state, (h.fromM + h.toM) / 2)}</dd>` : ""}
      ${h ? `<dt>森林の区域</dt><dd>${state.forest ? escapeHtml(forestText(state.forest.get(h.parcelId))) + (noticeText(state.forest.get(h.parcelId)) ? `<br><span class="badge low">届出が要るかもしれない（市町村に確かめる）</span>` : "") : `<span class="muted">${escapeHtml(state.forestNote)}</span>`} ${help(HELP.forest)}</dd>` : ""}
      <dt>地図</dt><dd>${p.properties.map}</dd>
    </dl>
    <p class="muted small" style="margin-top:10px">公図は「おおよその位置と隣接関係」を示す図面です。境界は現地と違うことがあります。</p>`,
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
  openDetail(
    `区切り ${id}`,
    `<dl class="kv">
      <dt>場所</dt><dd>起点から ${f.properties!.fromM}〜${f.properties!.toM} m の${side}</dd>
      <dt>KP（推定）</dt><dd>${kpText(state, (f.properties!.fromM + f.properties!.toM) / 2)}</dd>
      <dt>面積</dt><dd>${f.properties!.areaM2} m²</dd>
      <dt>外側</dt><dd>中心線から ${f.properties!.outerMaxM} m まで ${help(HELP.band)}</dd>
      ${state.segForest?.get(id) ? `<dt>森林の区域</dt><dd>${Math.round(state.segForest.get(id)!.ratio * 100)}% が区域の中${state.forestFlags?.get(id) ? `<br><span class="badge forest">食い違い</span> <span class="small">${escapeHtml(state.forestFlags.get(id)!)}</span>` : ""}</dd>` : ""}
      ${
        j
          ? `<dt>木の割合</dt><dd><b>${j.tree}%</b></dd>
             <dt>樹種</dt><dd>${j.kind}</dd>
             <dt>木以外</dt><dd>${j.other.join("・") || "—"}</dd>
             <dt>確信</dt><dd><span class="badge ${confClass}">${j.conf}</span></dd>
             <dt>理由</dt><dd>${escapeHtml(j.why)}</dd>
             <dt>決めたのは</dt><dd><span class="badge ${j.by === "人" ? "human" : ""}">${j.by}${j.model ? `（${shortModel(j.model)}）` : ""}</span></dd>
             ${j.before ? `<dt>最初の判定</dt><dd class="muted">${j.before.tree}%・確信 ${j.before.conf}（${shortModel(j.before.model ?? "")}）→ 見直しました</dd>` : ""}`
          : `<dt>判定</dt><dd class="muted">まだ判定していません</dd>`
      }
    </dl>
    ${fixForm(j)}`,
  );
  wireFixForm(state, id);
  if (fly) flyTo(state, boundsOf(f.geometry.coordinates[0]));
}

const TREE_KINDS: TreeKind[] = ["針葉樹", "広葉樹", "混じる", "分からない", "なし"];
const CONFS: Confidence[] = ["高", "中", "低"];

/** 区切りの判定を人が直すフォーム（F10）。開いたときは今の値が入っている。
 * 確信だけは「高」を初期値にする：人が目で確かめて記録するのだから、Claude の「低」を引き継ぐと「確かめる所」に残り続けるため */
function fixForm(j: Judgment | undefined): string {
  const tree = j?.tree ?? 0;
  return `<details class="fix" ${j?.by === "人" ? "open" : ""}>
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
    const fixed: Judgment = {
      segmentId: id,
      tree: Number(fd.get("tree")),
      kind: fd.get("kind") as TreeKind,
      other: old?.other ?? [],
      conf: fd.get("conf") as Confidence,
      why: String(fd.get("why") ?? "").trim() || "人が直した",
      by: "人",
      // 直す前の判定は 1 つだけ覚える（人が何度直しても、戻る先は Claude の判定）
      prev: old ? (old.by === "人" && old.prev ? old.prev : stripPrev(old)) : undefined,
    };
    state.judgments.set(id, fixed);
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

function renderList(state: AppState) {
  document.getElementById("list-count")!.textContent = `${state.hits.length} 筆`;
  const rows = state.hits
    .map((h) => {
      const p = state.parcelById.get(h.parcelId)!;
      const t = treeOfParcel(state, h);
      const treeCell = t ? `<span class="tree-bar" title="木の割合の最大 ${t.tree}%"><i style="width:${t.tree}%"></i></span> ${t.tree}%` : `<span class="muted">—</span>`;
      const fi = state.forest?.get(h.parcelId);
      const forestCell = !state.forest ? `<span class="muted">…</span>` : !fi || fi.ratio < 0.02 ? `<span class="muted">外</span>` : `<span title="${escapeHtml(forestText(fi))}">${fi.ratio < 0.5 ? "一部" : fi.kinds.includes("国有林") ? "国有" : "民有"}</span>`;
      return `<tr data-id="${escapeHtml(h.parcelId)}" class="${h.parcelId === state.selectedParcel ? "selected" : ""}">
        <td class="num">${h.fromM}〜${h.toM}</td><td>${h.sides.map((s) => (s === "L" ? "左" : "右")).join("・")}</td>
        <td title="${escapeHtml(p.properties.oaza ?? "")}">${escapeHtml(p.properties.chiban)}</td>
        <td class="num">${h.areaM2}</td><td>${treeCell}</td><td>${forestCell}</td></tr>`;
    })
    .join("");
  document.getElementById("list-body")!.innerHTML = `<table class="list"><thead><tr>
    <th>起点から m</th><th>左右</th><th>地番</th><th>かかる m²</th><th>木（推定）</th><th title="森林の区域（林野庁）">森林</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  document.querySelectorAll<HTMLTableRowElement>("table.list tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => selectParcel(state, tr.dataset.id!, true)),
  );
}

/* ---------- 森林の区域（林野庁） ---------- */

/** 区間の周り（左右 300m ほど）のタイルを読み、かかる筆ごとの重なりを出す。失敗しても道具は動く（列が空になるだけ） */
async function loadForest(state: AppState) {
  const lls = state.dense.filter((_, i) => i % 20 === 0).map((p) => toLonLat(p));
  const pad = 0.004; // 経度・緯度で約 300〜400m
  const bbox: [number, number, number, number] = [Math.min(...lls.map((c) => c[0])) - pad, Math.min(...lls.map((c) => c[1])) - pad, Math.max(...lls.map((c) => c[0])) + pad, Math.max(...lls.map((c) => c[1])) + pad];
  try {
    const r = await fetchForest(bbox);
    state.forestIndex = new ForestIndex(r.polygons);
    recomputeForest(state);
    // 点線（確かめる所）に食い違いを反映する
    state.segmentsGeo = applyJudgments(segmentsToGeoJSON(state.segments), state.judgments, state.forestFlags);
    setSourceData(state.map, "segments", state.segmentsGeo);
    const asOf = r.polygons.find((p) => p.asOf)?.asOf ?? "";
    state.forestNote = r.failed ? `森林の区域：タイル ${r.tiles} 枚のうち ${r.failed} 枚を読めませんでした` : `森林の区域：林野庁（データ時点 ${asOf}）`;
    console.info(`${state.forestNote}。多角形 ${r.polygons.length}`);
  } catch (e) {
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

function forestSummary(state: AppState): string {
  if (!state.forest) return escapeHtml(state.forestNote);
  let minyu = 0;
  let part = 0;
  let koku = 0;
  for (const h of state.hits) {
    const fi = state.forest.get(h.parcelId);
    if (!fi || fi.ratio < 0.02) continue;
    if (fi.kinds.includes("国有林")) koku++;
    if (fi.kinds.includes("民有林")) {
      minyu++;
      if (fi.ratio < 0.5) part++;
    }
  }
  return `うち <b>${minyu} 筆</b>が森林計画の対象の民有林の区域にかかります（一部だけ ${part}${koku ? `、国有林 ${koku}` : ""}）。この筆には一覧表で「伐採の届出が要るかもしれない（市町村に確かめる）」の目印を付けます。`;
}

/* ---------- 持って歩く地図（F8） ---------- */

function walkMapInput(state: AppState, withPhoto: boolean): WalkMapInput {
  const vehicleZones = state.track.source.kind === "vehicle" ? state.track.source.tiltZones : [];
  const band = state.track.source.kind === "band";
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
  };
}

async function exportWalkMap(state: AppState, withPhoto: boolean) {
  if (state.pdfRun) return;
  state.pdfError = null;
  state.pdfRun = { done: 0, total: pagesOf(state.segments).length + 1 };
  renderStep(state);
  try {
    const blob = await buildWalkMap(walkMapInput(state, withPhoto), (done, total) => {
      state.pdfRun = { done, total };
      if (state.step === 7) renderStep(state);
    });
    const day = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `arukumae_${state.roadName}_持って歩く地図_${day}.pdf`;
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
  const groups: { key: LayerGroup; label: string; sub?: string }[] = [
    { key: "photo", label: "航空写真（国土地理院）" },
    { key: "forest", label: "森林計画の対象森林（林野庁）", sub: `<span><i class="sw" style="background:#43a04730;border-color:#2e7d32"></i>民有林</span><span><i class="sw" style="background:#1b5e2040;border-color:#1b5e20"></i>国有林</span>` },
    {
      key: "parcels",
      label: "公図の筆（法務省）",
      sub:
        `<span><i class="sw" style="background:#ffeb3b;border-color:#ffd600"></i>かかる部分</span><span><i class="sw" style="border-color:#ffd600;border-width:2px"></i>かかる筆</span>` +
        Object.entries(KIND_COLORS)
          .filter(([k]) => !NOT_LAND.has(k as ParcelKind))
          .map(([k, c]) => `<span><i class="sw" style="background:${c}"></i>${k}</span>`)
          .join("") +
        `<span><i class="sw" style="border-style:dashed;border-color:#9e9e9e"></i>地区外・別図（隣の地図を見よ）</span>`,
    },
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
  document.getElementById("legend-body")!.innerHTML = groups
    .map((g) => `<label><input type="checkbox" data-group="${g.key}" checked> ${g.label}</label>${g.sub ? `<div class="sub">${g.sub}</div>` : ""}`)
    .join("");
  document.querySelectorAll<HTMLInputElement>("[data-group]").forEach((cb) =>
    cb.addEventListener("change", () => setGroupVisible(state.map, cb.dataset.group as LayerGroup, cb.checked)),
  );
}

/* ---------- 設定（鍵・モデル） ---------- */

function getApiKey(): string {
  return localStorage.getItem("arukumae.apiKey") ?? sessionStorage.getItem("arukumae.apiKey") ?? "";
}

function getSettings(): { model: ModelId; review: ModelId | "" } {
  const model = (localStorage.getItem("arukumae.model") as ModelId | null) ?? "claude-sonnet-5-5";
  const review = (localStorage.getItem("arukumae.review") ?? "claude-fable-5-1") as ModelId | "";
  return { model: model in MODELS ? model : "claude-sonnet-5-5", review: review === "" || review in MODELS ? review : "claude-fable-5-1" };
}

function wireSettings(state: AppState) {
  const key = document.getElementById("api-key") as HTMLInputElement;
  const remember = document.getElementById("remember-key") as HTMLInputElement;
  const modelSel = document.getElementById("model-main") as HTMLSelectElement;
  const reviewSel = document.getElementById("model-review") as HTMLSelectElement;
  // 既定はその場限り（sessionStorage）。「記憶する」を選んだときだけ localStorage に残す（spec §12）
  key.value = getApiKey();
  remember.checked = localStorage.getItem("arukumae.apiKey") !== null;
  const { model, review } = getSettings();
  modelSel.value = model;
  reviewSel.value = review;
  const save = () => {
    const v = key.value.trim();
    sessionStorage.setItem("arukumae.apiKey", v);
    if (remember.checked && v) localStorage.setItem("arukumae.apiKey", v);
    else localStorage.removeItem("arukumae.apiKey");
    localStorage.setItem("arukumae.model", modelSel.value);
    localStorage.setItem("arukumae.review", reviewSel.value);
    if (state.step === 4) renderStep(state); // 鍵の有無と費用の目安をボタンに反映する
  };
  for (const el of [key, remember, modelSel, reviewSel]) el.addEventListener("change", save);
  document.getElementById("settings-dialog")!.addEventListener("close", save);
}

main().catch((e) => {
  console.error(e);
  document.getElementById("app")!.innerHTML = `<p style="padding:20px">読み込みに失敗しました：${escapeHtml(String(e))}</p>`;
});
