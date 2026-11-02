/**
 * アルクマエの入口。見本のデータを読み、地図とパネルを組む。
 * 手順 1・3・4・5 を触れる。2（取り込み）・5 の「直す」・6（KP）・7（書き出し）はまだ骨。
 */
import "./style.css";
import type { FeatureCollection, Polygon, Position } from "geojson";
import type { LngLatBoundsLike, MapGeoJSONFeature, Map as MlMap, GeoJSONSource } from "maplibre-gl";
import { buildSegments, leftNormals, resample, type Segment } from "./core/geom";
import { estimateCost, fmtUsd, judgeWindow, makeClient, MODELS, type ModelId } from "./core/judge";
import { findHits, hitsToGeoJSON, segmentsToGeoJSON, type ParcelFeature } from "./core/parcels";
import { renderWindow, windowsOf } from "./core/photo";
import { toPlane, type EN } from "./core/proj";
import { NOT_LAND, type Judgment, type ParcelHit, type ParcelKind } from "./core/types";
import { loadDemoJudgments, loadParcels, loadSection } from "./data/demo";
import { addParcels, addSection, addSegments, applyJudgments, createMap, KIND_COLORS, setGroupVisible, type LayerGroup } from "./map/map";
import { buildLayout, escapeHtml, help, leftCover, openDetail, renderSteps, rightCover, showListTab, STEPS } from "./ui/panels";

interface AppState {
  map: MlMap;
  step: number;
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
  /** 判定の進み具合。null なら動いていない */
  run: { done: number; total: number; usd: number; log: string[]; cancel: boolean } | null;
}

// 見本の案件の判定を、この端末に残す鍵。利用者が自分の鍵で払って得た判定を、ページを開き直して失わせないため
const JUDGMENTS_KEY = "arukumae.judgments.ogawa";

async function main() {
  const root = document.getElementById("app")!;
  buildLayout(root);

  const [section, parcelsFc, demoJudgments] = await Promise.all([loadSection(), loadParcels(), loadDemoJudgments()]);
  const line = section.features[0].geometry.coordinates.map((c) => toPlane([c[0], c[1]]) as EN);
  const dense = resample(line, 1);
  const segments = buildSegments(dense, leftNormals(dense));
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
    run: null,
  };

  // 開発のときだけ、ブラウザの console から地図と状態をさわれるようにする（確かめ用）
  if (import.meta.env.DEV) (window as unknown as { __arukumae: unknown }).__arukumae = { map, state, t0: performance.now() };

  map.on("load", () => {
    addParcels(map, parcelsFc, hitsToGeoJSON(hits));
    addSegments(map, segmentsGeo);
    addSection(map, section);
    for (const h of hits) map.setFeatureState({ source: "parcels", id: h.parcelId }, { hit: true });
    wireMapClicks(state);
    renderLegend(state);
  });

  document.getElementById("project-name")!.textContent = `${section.features[0].properties.road_name}（見本）`;
  renderStep(state);
  renderList(state);
  renderChecks(state);
  wireSettings(state);
}

const HELP = {
  band: "伐採範囲（仮）：輸送路の中心線から左右 3〜13m、つまり道路の端から外側 10m の帯です。軌跡図を取り込めるようになったら、その外側線から決めます。",
  segment: "区切り：伐採範囲を道に沿って 10m ごと、左右別に分けたもの。番号 L032 は「起点から 320〜330m の左」。この1つずつについて、木の有無を航空写真から判定します。",
  judged: "判定が付いている区切りの数。見本として最初から入っている Claude の判定、この道具から Claude に判定させたもの、人が直したものを合わせた数です。",
  check: "確かめる所：Claude の確信が「低」だった区切り。写真がぼやける・影で見えない・枠の位置が読みにくい、などの理由です。現地で見る候補として一覧に並べています。",
  review: "見直し：最初のモデル（Sonnet）の確信が低かった区切りだけ、上位のモデル（Fable）に同じ写真をもう一度見せます。最初の判定は見せません（引きずられないように）。",
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
      parts.push(`<dl class="kv"><dt>案件名</dt><dd>小川村 県道401号（見本）</dd><dt>向き</dt><dd>南 → 北</dd><dt>区間</dt><dd>約 ${Math.round(state.segments.at(-1)!.toM)} m</dd><dt>伐採範囲</dt><dd>仮：中心線から 3〜13m ${help(HELP.band)}</dd></dl>`);
      parts.push(`<div class="next">次は、公図と軌跡図を取り込みます。見本では取り込み済みです。</div>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="2">次へ：取り込み</button></div>`);
      break;
    case 2:
      parts.push(`<div class="dropzone">ここに地図XML・KML・GeoTIFF を落とす<br><span class="small">（まだ受け付けません）</span></div>`);
      parts.push(`<dl class="kv" style="margin-top:10px"><dt>公図</dt><dd>小川村 2026年版（4枚、区間の周り ${state.parcels.length} 筆）</dd><dt>軌跡図</dt><dd>架空。道路の中心線から幅を取っています</dd></dl>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="3">次へ：かかる筆を見る</button></div>`);
      break;
    case 3: {
      const kinds = countKinds(state);
      parts.push(`<p><b>${state.hits.length} 筆</b>が伐採範囲 ${help(HELP.band)} にかかります（${kinds}）。地図の濃い黄色が、筆のうち伐採範囲と重なる部分です。右の一覧の行を押すと、地図がそこへ飛びます。</p>`);
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
      parts.push(`<p>確かめる所 ${help(HELP.check)}：<b>${lows.length}</b> 区切り。${reviewed.length ? `うち ${reviewed.length} 区切りは上位のモデルが見直し済み ${help(HELP.review)}。` : ""}右の一覧にも並んでいます。</p>`);
      const pos = state.lowCursor >= 0 && state.lowCursor < lows.length ? `${state.lowCursor + 1} / ${lows.length}` : `— / ${lows.length}`;
      parts.push(`<div class="nav"><button class="btn" data-prev-low ${lows.length ? "" : "disabled"}>← 前</button><span class="pos">${pos}</span><button class="btn" data-next-low ${lows.length ? "" : "disabled"}>次 →</button></div>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="6">次へ：KP</button></div>`);
      showListTab("checks");
      break;
    }
    case 6:
      parts.push(`<p class="muted">まだ置けません。</p><div class="actions"><button class="btn primary" data-go="7">次へ：書き出し</button></div>`);
      break;
    case 7:
      parts.push(`<div class="actions"><button class="btn" disabled>一覧表（CSV）</button><button class="btn" disabled>一覧表（Excel）</button><button class="btn" disabled>持って歩く地図（PDF）</button></div><p class="muted small">まだ書き出せません。</p>`);
      break;
  }
  body.innerHTML = parts.join("");
  body.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) =>
    b.addEventListener("click", () => {
      state.step = Number(b.dataset.go);
      renderStep(state);
    }),
  );
  body.querySelector("[data-next-low]")?.addEventListener("click", () => stepLow(state, 1));
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
  state.segmentsGeo = applyJudgments(segmentsToGeoJSON(state.segments), state.judgments);
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
function checkList(state: AppState): Judgment[] {
  const order = new Map(state.segments.map((s, i) => [s.id, i]));
  return [...state.judgments.values()].filter((j) => j.conf === "低").sort((a, b) => (order.get(a.segmentId) ?? 0) - (order.get(b.segmentId) ?? 0));
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
    body.innerHTML = `<p class="empty">まだありません。手順 4 で判定すると、確信が「低」だった区切りがここに並びます。</p>`;
    return;
  }
  const rows = lows
    .map((j, i) => {
      const seg = state.segments.find((s) => s.id === j.segmentId);
      const side = j.segmentId.startsWith("L") ? "左" : "右";
      return `<tr data-seg="${j.segmentId}" class="${j.segmentId === state.selectedSegment ? "selected" : ""}">
        <td class="num">${i + 1}</td><td class="num">${seg ? `${seg.fromM}〜${seg.toM}` : ""}</td><td>${side}</td>
        <td class="num">${j.tree}%</td><td>${j.before ? '<span class="badge">見直し済</span>' : ""}</td>
        <td class="muted" title="${escapeHtml(j.why)}">${escapeHtml(j.why.length > 18 ? j.why.slice(0, 18) + "…" : j.why)}</td></tr>`;
    })
    .join("");
  body.innerHTML = `<table class="list"><thead><tr><th>#</th><th>起点から m</th><th>左右</th><th>木</th><th></th><th>理由</th></tr></thead><tbody>${rows}</tbody></table>`;
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

function clearSelection(state: AppState) {
  if (state.selectedParcel) state.map.setFeatureState({ source: "parcels", id: state.selectedParcel }, { selected: false });
  if (state.selectedSegment) state.map.setFeatureState({ source: "segments", id: state.selectedSegment }, { selected: false });
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
  state.map.setFeatureState({ source: "parcels", id }, { selected: true });
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
  state.map.setFeatureState({ source: "segments", id }, { selected: true });
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
      <dt>面積</dt><dd>${f.properties!.areaM2} m²</dd>
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
    <div class="actions" style="margin-top:12px"><button class="btn" disabled>この区切りを直す（まだ）</button></div>`,
  );
  if (fly) flyTo(state, boundsOf(f.geometry.coordinates[0]));
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
      return `<tr data-id="${escapeHtml(h.parcelId)}" class="${h.parcelId === state.selectedParcel ? "selected" : ""}">
        <td class="num">${h.fromM}〜${h.toM}</td><td>${h.sides.map((s) => (s === "L" ? "左" : "右")).join("・")}</td>
        <td title="${escapeHtml(p.properties.oaza ?? "")}">${escapeHtml(p.properties.chiban)}</td>
        <td class="num">${h.areaM2}</td><td>${treeCell}</td></tr>`;
    })
    .join("");
  document.getElementById("list-body")!.innerHTML = `<table class="list"><thead><tr>
    <th>起点から m</th><th>左右</th><th>地番</th><th>かかる m²</th><th>木（推定）</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  document.querySelectorAll<HTMLTableRowElement>("table.list tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => selectParcel(state, tr.dataset.id!, true)),
  );
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
        .map(([k, c]) => `<span><i class="sw" style="background:${c}"></i>${k}</span>`).join("") + `<span>点線＝確信が低い</span>`,
    },
    { key: "section", label: "輸送路の中心線（架空の軌跡図の元）" },
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
