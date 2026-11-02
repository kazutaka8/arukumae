/**
 * アルクマエの入口。見本のデータを読み、地図とパネルを組む。
 * 雛形の段階：手順 1・3・5 を見本で触れる。2（取り込み）・4（判定）・6（KP）・7（書き出し）は骨だけ。
 */
import "./style.css";
import type { FeatureCollection, Polygon } from "geojson";
import type { MapGeoJSONFeature, Map as MlMap } from "maplibre-gl";
import { buildSegments, leftNormals, resample, type Segment } from "./core/geom";
import { findHits, segmentsToGeoJSON, type ParcelFeature } from "./core/parcels";
import { toPlane, type EN } from "./core/proj";
import type { Judgment, ParcelHit, ParcelKind } from "./core/types";
import { loadDemoJudgments, loadParcels, loadSection } from "./data/demo";
import { addParcels, addSection, addSegments, applyJudgments, createMap, KIND_COLORS, setGroupVisible, type LayerGroup } from "./map/map";
import { buildLayout, escapeHtml, openDetail, renderSteps, STEPS } from "./ui/panels";

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
  selectedParcel: string | null;
  selectedSegment: string | null;
}

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

  const judgments = new Map(demoJudgments.map((j) => [j.segmentId, j]));
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
    selectedParcel: null,
    selectedSegment: null,
  };

  // 開発のときだけ、ブラウザの console から地図と状態をさわれるようにする（確かめ用）
  if (import.meta.env.DEV) (window as unknown as { __arukumae: unknown }).__arukumae = { map, state, t0: performance.now() };

  map.on("load", () => {
    addParcels(map, parcelsFc);
    addSegments(map, segmentsGeo);
    addSection(map, section);
    for (const h of hits) map.setFeatureState({ source: "parcels", id: h.parcelId }, { hit: true });
    wireMapClicks(state);
    renderLegend(state);
  });

  document.getElementById("project-name")!.textContent = `${section.features[0].properties.road_name}（見本）`;
  renderStep(state);
  renderList(state);
  wireSettings();
}

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
      parts.push(`<dl class="kv"><dt>案件名</dt><dd>小川村 県道401号（見本）</dd><dt>向き</dt><dd>南 → 北</dd><dt>区間</dt><dd>約 ${Math.round(state.segments.at(-1)!.toM)} m</dd></dl>`);
      parts.push(`<div class="next">次は、公図と軌跡図を取り込みます。見本では取り込み済みです。</div>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="2">次へ：取り込み</button></div>`);
      break;
    case 2:
      parts.push(`<div class="dropzone">ここに地図XML・KML・GeoTIFF を落とす<br><span class="small">（雛形ではまだ受け付けません）</span></div>`);
      parts.push(`<dl class="kv" style="margin-top:10px"><dt>公図</dt><dd>小川村 2026年版（4枚、区間の周り ${state.parcels.length} 筆）</dd><dt>軌跡図</dt><dd>架空。道路の中心線から幅を取っています</dd></dl>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="3">次へ：かかる筆を見る</button></div>`);
      break;
    case 3: {
      const kinds = countKinds(state);
      parts.push(`<p><b>${state.hits.length} 筆</b>が伐採範囲にかかります（${kinds}）。地図の黄色い筆です。押すと詳細が出ます。</p>`);
      parts.push(`<div class="next">漏れを出さないため、ここは AI ではなく計算で決めています。</div>`);
      parts.push(`<div class="actions"><button class="btn" data-open-list>一覧を開く</button><button class="btn primary" data-go="4">次へ：木を判定する</button></div>`);
      break;
    }
    case 4: {
      const judged = state.judgments.size;
      parts.push(`<p>区切りは <b>${state.segments.length}</b>。見本では ${judged} 区切りが判定済みです（Claude Sonnet 5.5）。</p>`);
      parts.push(`<div class="actions"><button class="btn primary" disabled>木を判定する <span class="cost">約 $0.3</span></button><p class="muted small">判定には API キーが要ります。右上の「設定」で入れると押せるようになります（雛形ではまだ呼びません）。</p></div>`);
      parts.push(`<div class="actions"><button class="btn primary" data-go="5">次へ：確かめて直す</button></div>`);
      break;
    }
    case 5: {
      const low = [...state.judgments.values()].filter((j) => j.conf === "低");
      parts.push(`<p>現地で確かめる所：<b>${low.length}</b> 区切り（確信が低いもの）。</p>`);
      parts.push(`<div class="actions"><button class="btn" data-next-low>次の「確かめる所」へ</button><button class="btn primary" data-go="6">次へ：KP</button></div>`);
      break;
    }
    case 6:
      parts.push(`<p class="muted">雛形ではまだ置けません。</p><div class="actions"><button class="btn primary" data-go="7">次へ：書き出し</button></div>`);
      break;
    case 7:
      parts.push(`<div class="actions"><button class="btn" disabled>一覧表（CSV）</button><button class="btn" disabled>一覧表（Excel）</button><button class="btn" disabled>持って歩く地図（PDF）</button></div><p class="muted small">雛形ではまだ書き出せません。</p>`);
      break;
  }
  body.innerHTML = parts.join("");
  body.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) =>
    b.addEventListener("click", () => {
      state.step = Number(b.dataset.go);
      renderStep(state);
    }),
  );
  body.querySelector("[data-open-list]")?.addEventListener("click", () => document.getElementById("list-drawer")!.classList.remove("collapsed"));
  body.querySelector("[data-next-low]")?.addEventListener("click", () => nextLow(state));
}

function countKinds(state: AppState): string {
  const c = new Map<ParcelKind, number>();
  for (const h of state.hits) {
    const k = state.parcelById.get(h.parcelId)!.properties.kind;
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return [...c.entries()].map(([k, n]) => `${k} ${n}`).join("・");
}

let lowCursor = -1;
function nextLow(state: AppState) {
  const lows = [...state.judgments.values()].filter((j) => j.conf === "低");
  if (!lows.length) return;
  lowCursor = (lowCursor + 1) % lows.length;
  selectSegment(state, lows[lowCursor].segmentId, true);
}

/* ---------- 地図の操作 ---------- */

function wireMapClicks(state: AppState) {
  const { map } = state;
  map.on("click", "segments-fill", (e) => {
    const f = e.features?.[0];
    if (f) selectSegment(state, f.properties.id as string, false);
  });
  map.on("click", "parcels-fill", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["segments-fill"] }).length) return; // 区切りの上では区切りを優先
    const f = e.features?.[0] as MapGeoJSONFeature | undefined;
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
  openDetail(
    `${p.properties.oaza ?? ""} ${p.properties.chiban}`,
    `<dl class="kv">
      <dt>種類</dt><dd><span class="badge" style="background:${KIND_COLORS[p.properties.kind]}">${p.properties.kind}</span></dd>
      <dt>かかる</dt><dd>${h ? `はい。${h.areaM2} m²` : "いいえ"}</dd>
      ${h ? `<dt>起点から</dt><dd>${h.fromM}〜${h.toM} m（${h.sides.map((s) => (s === "L" ? "左" : "右")).join("・")}）</dd>` : ""}
      <dt>地図</dt><dd>${p.properties.map}</dd>
    </dl>
    <p class="muted small" style="margin-top:10px">公図は「おおよその位置と隣接関係」を示す図面です。境界は現地と違うことがあります。</p>`,
  );
  if (fly) state.map.fitBounds(boundsOf(p.geometry.coordinates[0]), { padding: 120, maxZoom: 19 });
}

function selectSegment(state: AppState, id: string, fly: boolean) {
  clearSelection(state);
  const f = state.segmentsGeo.features.find((f) => f.properties!.id === id);
  if (!f) return;
  state.selectedSegment = id;
  state.map.setFeatureState({ source: "segments", id }, { selected: true });
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
             <dt>決めたのは</dt><dd><span class="badge ${j.by === "人" ? "human" : ""}">${j.by}${j.model ? `（${j.model.replace("claude-", "")}）` : ""}</span></dd>`
          : `<dt>判定</dt><dd class="muted">まだ判定していません</dd>`
      }
    </dl>
    <div class="actions" style="margin-top:12px"><button class="btn" disabled>この区切りを直す（雛形では未対応）</button></div>`,
  );
  if (fly) state.map.fitBounds(boundsOf(f.geometry.coordinates[0]), { padding: 160, maxZoom: 19 });
}

function boundsOf(ring: number[][]): [[number, number], [number, number]] {
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
      return `<tr data-id="${escapeHtml(h.parcelId)}">
        <td class="num">${h.fromM}〜${h.toM}</td><td>${h.sides.map((s) => (s === "L" ? "左" : "右")).join("・")}</td>
        <td>${p.properties.oaza ?? ""}</td><td>${escapeHtml(p.properties.chiban)}</td><td>${p.properties.kind}</td>
        <td class="num">${h.areaM2}</td><td class="muted">—</td></tr>`;
    })
    .join("");
  document.getElementById("list-body")!.innerHTML = `<table class="list"><thead><tr>
    <th>起点から（m）</th><th>左右</th><th>大字</th><th>地番</th><th>種類</th><th>かかる面積（m²）</th><th>木（推定）</th>
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
      sub: `<span><i class="sw" style="background:#ffeb3b80;border-color:#ffd600"></i>かかる筆</span>` + Object.entries(KIND_COLORS).map(([k, c]) => `<span><i class="sw" style="background:${c}"></i>${k}</span>`).join(""),
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

function wireSettings() {
  const key = document.getElementById("api-key") as HTMLInputElement;
  const remember = document.getElementById("remember-key") as HTMLInputElement;
  // 既定はその場限り（sessionStorage）。「記憶する」を選んだときだけ localStorage に残す（spec §12）
  key.value = localStorage.getItem("arukumae.apiKey") ?? sessionStorage.getItem("arukumae.apiKey") ?? "";
  remember.checked = localStorage.getItem("arukumae.apiKey") !== null;
  const save = () => {
    sessionStorage.setItem("arukumae.apiKey", key.value);
    if (remember.checked) localStorage.setItem("arukumae.apiKey", key.value);
    else localStorage.removeItem("arukumae.apiKey");
  };
  key.addEventListener("change", save);
  remember.addEventListener("change", save);
}

main().catch((e) => {
  console.error(e);
  document.getElementById("app")!.innerHTML = `<p style="padding:20px">読み込みに失敗しました：${escapeHtml(String(e))}</p>`;
});
