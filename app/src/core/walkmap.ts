/**
 * 持って歩く地図（F8、spec §9.2）。A4 縦の PDF。
 *
 * 1 ページ目は区間全体の索引図、2 ページ目からはルートに沿って約 200m ずつ（木の判定の窓と同じ区切り方）。
 * 各ページ：航空写真の上に、掃く範囲・伐採範囲の外側・筆の境界と地番・区切り（判定の色と番号）・中心線・起点からの距離と KP。
 * 地図の下に「現地で確かめる所」を並べ、○×とメモを手で書ける欄を付ける。
 *
 * 作り：ページ全体を canvas に描いて JPEG にし、jsPDF に貼る。jsPDF で日本語を出すにはフォント（数 MB）を同梱しないといけないので、
 * 文字も canvas に描く（端末のフォントが使える）。文字は選べない PDF になるが、持って歩く紙としては困らない
 */
import type { Position } from "geojson";
import { jsPDF } from "jspdf";
import type { Segment } from "./geom";
import type { ParcelFeature } from "./parcels";
import { fetchTile, lonLatToPx, metersPerPx, TILE, windowsOf, Z } from "./photo";
import { toLonLat, type EN } from "./proj";
import type { KpMark } from "./kp";
import { estimateKp, fmtKm } from "./kp";
import type { ForestInfo } from "./forest";
import type { Judgment, ParcelHit } from "./types";
import type { Sweep, TiltZone } from "./vehicle";

/** PDF を作るのに要るものを一式。main の状態から写して渡す（core はアプリの状態の形を知らない） */
export interface WalkMapInput {
  title: string;
  roadName: string;
  dense: EN[];
  normals: EN[];
  segments: Segment[];
  parcels: ParcelFeature[];
  hits: ParcelHit[];
  judgments: Map<string, Judgment>;
  kps: KpMark[];
  sweep: Sweep | null;
  outer: { left: ArrayLike<number>; right: ArrayLike<number> } | null;
  tiltZones: TiltZone[];
  /** 伐採範囲の決め方の説明（手順 2） */
  trackText: string;
  /** 航空写真を背景に入れるか。入れないと線と色だけになる（spec §9.2） */
  withPhoto: boolean;
  /** 森林の区域（林野庁）。読めていなければ null */
  forest: Map<string, ForestInfo> | null;
}

// A4 縦（mm）。描く解像度は 8 px/mm（約 203 dpi）。地理院の写真（z18、約 0.48m／画素）を拡大して貼るので、これ以上細かくしても写真はよくならない
const PAGE_W = 210;
const PAGE_H = 297;
const PX_PER_MM = 8;
const MARGIN = 10;
const HEADER_H = 16;
const FOOTER_H = 10;
const LEGEND_H = 13; // 凡例は 2 段に折り返す
const CHECK_ROW_H = 7.5;

const TREE_FILL: Record<number, string> = { 0: "rgba(255,255,255,0.25)", 25: "rgba(255,235,59,0.5)", 50: "rgba(255,152,0,0.55)", 75: "rgba(244,81,30,0.6)", 100: "rgba(183,28,28,0.65)" };

const ATTRIBUTION = "出典：国土地理院（地理院タイル 全国最新写真）を加工 ／ 登記所備付地図データ 上水内郡小川村（法務省）を加工して作成 ／ 森林計画対象森林レイヤ（林野庁） ／ © OpenStreetMap contributors";

type XY = [number, number];

/** 地理院の画素座標（z18）→ ページの px への写像。枠に収まる縮尺を決める */
interface Frame {
  /** 地図を描く枠（ページ mm） */
  box: { x: number; y: number; w: number; h: number };
  /** 写真の画素（z18）で見た左上と、1 画素が何ページ px か */
  minX: number;
  minY: number;
  scale: number;
  /** 1 ページ px が何 m か（縮尺の表示に使う） */
  metersPerPagePx: number;
}

/** 枠（mm）に bbox（z18 画素）を収める。横長・縦長どちらでも入るように小さいほうの縮尺を取り、真ん中に置く */
export function fitFrame(box: Frame["box"], bbox: [number, number, number, number], lat: number): Frame {
  const bw = Math.max(1, bbox[2] - bbox[0]);
  const bh = Math.max(1, bbox[3] - bbox[1]);
  const boxPxW = box.w * PX_PER_MM;
  const boxPxH = box.h * PX_PER_MM;
  const scale = Math.min(boxPxW / bw, boxPxH / bh);
  // 余った分だけ左右・上下に広げて真ん中に
  const minX = bbox[0] - (boxPxW / scale - bw) / 2;
  const minY = bbox[1] - (boxPxH / scale - bh) / 2;
  return { box, minX, minY, scale, metersPerPagePx: metersPerPx(lat) / scale };
}

/** ページ（200m ほどの窓）ごとの区切り。索引図のために先に全部決める */
export function pagesOf(segments: Segment[]): Segment[][] {
  return windowsOf(segments, 20);
}

export async function buildWalkMap(input: WalkMapInput, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const pages = pagesOf(input.segments);
  const total = pages.length + 1;
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const day = new Date().toISOString().slice(0, 10);

  // 索引図
  const indexCanvas = await renderIndexPage(input, pages, day);
  pdf.addImage(indexCanvas.toDataURL("image/jpeg", 0.85), "JPEG", 0, 0, PAGE_W, PAGE_H);
  onProgress?.(1, total);

  for (let i = 0; i < pages.length; i++) {
    const canvas = await renderRoutePage(input, pages, i, day);
    pdf.addPage();
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.85), "JPEG", 0, 0, PAGE_W, PAGE_H);
    onProgress?.(i + 2, total);
  }
  return pdf.output("blob");
}

/* ---------- ページ ---------- */

function newPage(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = PAGE_W * PX_PER_MM;
  c.height = PAGE_H * PX_PER_MM;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return [c, ctx];
}

const mm = (v: number) => v * PX_PER_MM;
const FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif';
function font(ctx: CanvasRenderingContext2D, ptMm: number, bold = false) {
  ctx.font = `${bold ? "bold " : ""}${Math.round(mm(ptMm))}px ${FONT}`;
}

function header(ctx: CanvasRenderingContext2D, input: WalkMapInput, sub: string, pageNo: number, pageTotal: number, day: string) {
  ctx.fillStyle = "#1f2933";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  font(ctx, 4.2, true);
  ctx.fillText(`${input.title}　持って歩く地図`, mm(MARGIN), mm(MARGIN));
  font(ctx, 3.2);
  ctx.fillStyle = "#6b7a89";
  ctx.fillText(sub, mm(MARGIN), mm(MARGIN + 6.5));
  ctx.textAlign = "right";
  ctx.fillText(`${pageNo} / ${pageTotal}　${day}`, mm(PAGE_W - MARGIN), mm(MARGIN));
  ctx.fillStyle = "#c62828";
  ctx.fillText("下調べの資料。現地で確かめる前提です", mm(PAGE_W - MARGIN), mm(MARGIN + 6.5));
  ctx.strokeStyle = "#d9dee3";
  ctx.lineWidth = mm(0.2);
  ctx.beginPath();
  ctx.moveTo(mm(MARGIN), mm(MARGIN + HEADER_H - 2));
  ctx.lineTo(mm(PAGE_W - MARGIN), mm(MARGIN + HEADER_H - 2));
  ctx.stroke();
}

function footer(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#6b7a89";
  font(ctx, 2.3);
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(ATTRIBUTION, mm(MARGIN), mm(PAGE_H - MARGIN + 2));
  ctx.fillText("公図は「おおよその位置と隣接関係」を示す図面で、境界は現地と違うことがあります。届出などの要否は所管に確かめてください。", mm(MARGIN), mm(PAGE_H - MARGIN + 5.5));
}

/* ---------- 地図を描く ---------- */

function bboxOf(points: XY[], padPx: number): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX - padPx, minY - padPx, maxX + padPx, maxY + padPx];
}

const toPx = (p: EN): XY => lonLatToPx(...toLonLat(p));
const llPx = (c: Position): XY => lonLatToPx(c[0], c[1]);

/** 地図の枠の中に、写真と線を描く。枠の外にははみ出さない（clip） */
async function drawMap(ctx: CanvasRenderingContext2D, f: Frame, input: WalkMapInput, segs: Segment[], index: boolean) {
  const { box } = f;
  const X = (x: number) => mm(box.x) + (x - f.minX) * f.scale;
  const Y = (y: number) => mm(box.y) + (y - f.minY) * f.scale;
  const P = ([x, y]: XY): XY => [X(x), Y(y)];
  ctx.save();
  ctx.beginPath();
  ctx.rect(mm(box.x), mm(box.y), mm(box.w), mm(box.h));
  ctx.clip();
  ctx.fillStyle = input.withPhoto ? "#222" : "#f4f6f8";
  ctx.fillRect(mm(box.x), mm(box.y), mm(box.w), mm(box.h));

  // 背景の写真。索引図は広いので 1 段粗いタイル（z17）で足りる
  if (input.withPhoto) {
    const z = index ? Z - 1 : Z;
    const k = 2 ** (Z - z); // z18 画素で見た 1 タイルの大きさの倍率
    const maxX = f.minX + mm(box.w) / f.scale;
    const maxY = f.minY + mm(box.h) / f.scale;
    const jobs: Promise<void>[] = [];
    for (let tx = Math.floor(f.minX / (TILE * k)); tx <= Math.floor(maxX / (TILE * k)); tx++) {
      for (let ty = Math.floor(f.minY / (TILE * k)); ty <= Math.floor(maxY / (TILE * k)); ty++) {
        jobs.push(
          fetchTile(z, tx, ty).then((img) => {
            if (img) ctx.drawImage(img, X(tx * TILE * k), Y(ty * TILE * k), TILE * k * f.scale + 0.5, TILE * k * f.scale + 0.5);
          }),
        );
      }
    }
    await Promise.all(jobs);
    // 写真の上の線が読めるよう、少し白を掛ける
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(mm(box.x), mm(box.y), mm(box.w), mm(box.h));
  }

  const path = (pts: XY[], close = false) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
    if (close) ctx.closePath();
  };
  const inView = (pts: XY[]) => {
    const b = bboxOf(pts, 0);
    return !(X(b[2]) < mm(box.x) || X(b[0]) > mm(box.x + box.w) || Y(b[3]) < mm(box.y) || Y(b[1]) > mm(box.y + box.h));
  };

  // 筆：境界は白（写真の上）か灰（背景なし）、かかる筆は黄色の太線、かかる部分は黄色の面
  const hitIds = new Set(input.hits.map((h) => h.parcelId));
  const lineBase = input.withPhoto ? "rgba(255,255,255,0.7)" : "rgba(120,130,140,0.8)";
  const labelSpots: { p: XY; text: string; hit: boolean }[] = [];
  for (const pf of input.parcels) {
    if (pf.properties.kind === "地区外" || pf.properties.kind === "別図") continue;
    const ring = pf.geometry.coordinates[0].map(llPx);
    if (!inView(ring)) continue;
    const hit = hitIds.has(pf.properties.id);
    path(ring, true);
    ctx.strokeStyle = hit ? "#ffd600" : lineBase;
    ctx.lineWidth = hit ? mm(0.5) : mm(0.18);
    ctx.stroke();
    if (!index) {
      const b = bboxOf(ring, 0);
      labelSpots.push({ p: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], text: pf.properties.chiban, hit });
    }
  }
  for (const h of input.hits) {
    for (const poly of h.shape.coordinates) {
      const ring = poly[0].map(llPx);
      if (!inView(ring)) continue;
      path(ring, true);
      ctx.fillStyle = "rgba(255,235,59,0.45)";
      ctx.fill();
    }
  }

  // 区切り：判定の色の面と、左＝黄・右＝水色の枠。人が直したものは青枠、確信が低いものは点線
  for (const s of segs) {
    const ring = s.ring.map(toPx);
    const j = input.judgments.get(s.id);
    path(ring, true);
    ctx.fillStyle = j ? TREE_FILL[j.tree] ?? TREE_FILL[100] : "rgba(200,200,200,0.3)";
    ctx.fill();
    ctx.setLineDash(j?.conf === "低" ? [mm(0.8), mm(0.6)] : []);
    ctx.strokeStyle = j?.by === "人" ? "#1565c0" : s.side === "L" ? "#ffe600" : "#00dcff";
    ctx.lineWidth = j?.by === "人" ? mm(0.5) : mm(0.25);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 掃く範囲（紫）と伐採範囲の外側（橙の点線）
  if (input.sweep) {
    const n = input.dense.length;
    const edge = (arr: ArrayLike<number>, sgn: 1 | -1): XY[][] => {
      const runs: XY[][] = [];
      let cur: XY[] = [];
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (Number.isFinite(v)) cur.push(toPx([input.dense[i][0] + sgn * input.normals[i][0] * v, input.dense[i][1] + sgn * input.normals[i][1] * v]));
        else if (cur.length) {
          runs.push(cur);
          cur = [];
        }
      }
      if (cur.length) runs.push(cur);
      return runs;
    };
    ctx.strokeStyle = "#7b1fa2";
    ctx.lineWidth = mm(0.35);
    for (const r of [...edge(input.sweep.left, 1), ...edge(input.sweep.right, -1)]) {
      path(r);
      ctx.stroke();
    }
    if (input.outer) {
      ctx.strokeStyle = "#ff9800";
      ctx.setLineDash([mm(1.2), mm(0.8)]);
      for (const r of [...edge(input.outer.left, 1), ...edge(input.outer.right, -1)]) {
        path(r);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  // 起立の区間（青い帯）と中心線（赤）
  for (const z of input.tiltZones) {
    path(input.dense.slice(z.fromM, z.toM + 1).map(toPx));
    ctx.strokeStyle = "rgba(21,101,192,0.55)";
    ctx.lineWidth = mm(1.6);
    ctx.stroke();
  }
  path(input.dense.map(toPx));
  ctx.strokeStyle = "#ff3b30";
  ctx.lineWidth = mm(index ? 0.6 : 0.45);
  ctx.stroke();

  // 起点からの距離の目盛り（索引図は 200m、ページは 50m）と KP
  const step = index ? 200 : 50;
  ctx.textBaseline = "middle";
  for (let m = 0; m < input.dense.length; m += step) {
    const p = P(toPx(input.dense[m]));
    const nrm = input.normals[m];
    ctx.fillStyle = "#ff3b30";
    ctx.beginPath();
    ctx.arc(p[0], p[1], mm(index ? 0.8 : 0.7), 0, Math.PI * 2);
    ctx.fill();
    const est = estimateKp(input.kps, m);
    const text = index ? `${m}m` : `${m}m${est ? `  KP ${fmtKm(est.kp)}` : ""}`;
    font(ctx, index ? 2.6 : 2.8, true);
    // 札は進行方向の右側（右の法線の向き）に少し離して置く
    const dx = -nrm[0] * mm(2.5);
    const dy = nrm[1] * mm(2.5); // 画面の y は南が正なので符号が反転する
    ctx.textAlign = dx >= 0 ? "left" : "right";
    outlinedText(ctx, text, p[0] + dx, p[1] + dy, "#fff", "#c62828");
  }
  // 起点・終点
  font(ctx, 3, true);
  const p0 = P(toPx(input.dense[0]));
  const p1 = P(toPx(input.dense[input.dense.length - 1]));
  ctx.textAlign = "center";
  outlinedText(ctx, "起点", p0[0], p0[1] - mm(3.5), "#fff", "#c62828");
  outlinedText(ctx, "終点", p1[0], p1[1] - mm(3.5), "#fff", "#c62828");

  // 区切りの番号と地番（ページだけ）。枠の中に小さく
  if (!index) {
    font(ctx, 2.2, true);
    ctx.textAlign = "center";
    for (const s of segs) {
      const ring = s.ring.map(toPx);
      const b = bboxOf(ring, 0);
      const c = P([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
      outlinedText(ctx, s.id, c[0], c[1], "#fff", "rgba(0,0,0,0.85)");
    }
    font(ctx, 2.4);
    for (const l of labelSpots) {
      const c = P(l.p);
      outlinedText(ctx, l.text, c[0], c[1], l.hit ? "#fff" : "rgba(255,255,255,0.85)", "rgba(0,0,0,0.6)");
    }
  }

  ctx.restore();
  // 枠
  ctx.strokeStyle = "#1f2933";
  ctx.lineWidth = mm(0.3);
  ctx.strokeRect(mm(box.x), mm(box.y), mm(box.w), mm(box.h));

  // 縮尺（100m の棒）
  const barM = index ? 200 : 100;
  const barPx = barM / f.metersPerPagePx;
  const bx = mm(box.x + box.w - 4) - barPx;
  const by = mm(box.y + box.h - 4);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(bx - mm(1.5), by - mm(4), barPx + mm(3), mm(6));
  ctx.fillStyle = "#1f2933";
  ctx.fillRect(bx, by, barPx, mm(0.8));
  font(ctx, 2.4);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${barM}m（1:${Math.round(f.metersPerPagePx * PX_PER_MM * 1000 / 100) * 100}）`, bx + barPx / 2, by - mm(0.5));
}

function outlinedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, stroke: string) {
  ctx.lineJoin = "round";
  ctx.lineWidth = mm(0.6);
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function legend(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const items: [string, string, string?][] = [
    ["かかる部分", "rgba(255,235,59,0.6)", "#ffd600"],
    ["木 0%", TREE_FILL[0], "#999"],
    ["25", TREE_FILL[25]],
    ["50", TREE_FILL[50]],
    ["75", TREE_FILL[75]],
    ["100", TREE_FILL[100]],
    ["点線＝確信が低い", "transparent", "#555"],
    ["人が直した", "transparent", "#1565c0"],
    ["掃く範囲", "transparent", "#7b1fa2"],
    ["伐採範囲の外側", "transparent", "#ff9800"],
    ["起立の区間", "rgba(21,101,192,0.55)"],
    ["中心線", "#ff3b30"],
  ];
  font(ctx, 2.4);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let cx = mm(x);
  let cy = mm(y);
  for (const [label, fill, stroke] of items) {
    // 右端に収まらなければ次の段へ
    if (cx + mm(4) + ctx.measureText(label).width > mm(PAGE_W - MARGIN)) {
      cx = mm(x);
      cy += mm(5);
    }
    ctx.fillStyle = fill;
    ctx.fillRect(cx, cy - mm(1.5), mm(3), mm(3));
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = mm(0.35);
      ctx.setLineDash(label.startsWith("点線") ? [mm(0.8), mm(0.6)] : []);
      ctx.strokeRect(cx, cy - mm(1.5), mm(3), mm(3));
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#1f2933";
    ctx.fillText(label, cx + mm(4), cy);
    cx += mm(4) + ctx.measureText(label).width + mm(4);
  }
}

/* ---------- 索引図 ---------- */

export async function renderIndexPage(input: WalkMapInput, pages: Segment[][], day: string): Promise<HTMLCanvasElement> {
  const [canvas, ctx] = newPage();
  header(ctx, input, `区間全体の索引図。2 ページ目から、起点から約 200m ずつ ${pages.length} 枚`, 1, pages.length + 1, day);
  const box = { x: MARGIN, y: MARGIN + HEADER_H, w: PAGE_W - MARGIN * 2, h: 190 };
  const pts = input.dense.map(toPx);
  const f = fitFrame(box, bboxOf(pts, 60 / metersPerPx(toLonLat(input.dense[0])[1])), toLonLat(input.dense[0])[1]);
  await drawMap(ctx, f, input, [], true);

  // ページの枠と番号
  const X = (x: number) => mm(box.x) + (x - f.minX) * f.scale;
  const Y = (y: number) => mm(box.y) + (y - f.minY) * f.scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(mm(box.x), mm(box.y), mm(box.w), mm(box.h));
  ctx.clip();
  pages.forEach((segs, i) => {
    const b = pageBbox(segs, input);
    ctx.strokeStyle = "#1f2933";
    ctx.lineWidth = mm(0.3);
    ctx.setLineDash([mm(1), mm(0.7)]);
    ctx.strokeRect(X(b[0]), Y(b[1]), (b[2] - b[0]) * f.scale, (b[3] - b[1]) * f.scale);
    ctx.setLineDash([]);
    font(ctx, 3.4, true);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lab = `p.${i + 2}`;
    ctx.fillStyle = "#fff";
    ctx.fillRect(X(b[0]), Y(b[1]), ctx.measureText(lab).width + mm(2), mm(5));
    ctx.fillStyle = "#1f2933";
    ctx.fillText(lab, X(b[0]) + mm(1), Y(b[1]) + mm(0.7));
  });
  ctx.restore();
  legend(ctx, MARGIN, box.y + box.h + 5);

  // まとめ
  const lows = checkRows(input, input.segments);
  const judged = input.judgments.size;
  const treeArea = input.hits.reduce((a, h) => a + h.segmentIds.reduce((b, id) => b + (input.judgments.get(id) ? (h.segAreas[id] ?? 0) * (input.judgments.get(id)!.tree / 100) : 0), 0), 0);
  const lines = [
    `道路：${input.roadName}　区間：起点から ${input.dense.length - 1}m　筆：かかる筆 ${input.hits.length}　区切り ${input.segments.length}（判定あり ${judged}）`,
    `伐採範囲：${input.trackText}`,
    `木のある面積（推定・判定のある区切りだけ）：約 ${Math.round(treeArea)} m²　現地で確かめる所（確信が低い区切り）：${lows.length}`,
    input.kps.length >= 2 ? `KP：人が置いた距離標 ${input.kps.length} 本から中心線に沿って推定（距離標の外側は外挿）` : "KP：距離標が 2 本未満のため出していません",
    input.forest
      ? `森林の区域（林野庁）：民有林の区域にかかる筆 ${input.hits.filter((h) => (input.forest!.get(h.parcelId)?.ratio ?? 0) >= 0.02 && input.forest!.get(h.parcelId)!.kinds.includes("民有林")).length}（伐採の届出が要るかもしれない。要否は市町村に確かめる）`
      : "森林の区域：読めていません",
    "使い方：ページの地図で区切りの番号を見て、下の表の○×とメモに現地の見たままを書く。帰ってから道具の「確かめて直す」に写す。",
  ];
  font(ctx, 3);
  ctx.fillStyle = "#1f2933";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(fitText(ctx, l, mm(PAGE_W - MARGIN * 2)), mm(MARGIN), mm(box.y + box.h + LEGEND_H + 4 + i * 6)));
  footer(ctx);
  return canvas;
}

function pageBbox(segs: Segment[], input: WalkMapInput): [number, number, number, number] {
  const pts = segs.flatMap((s) => s.ring.map(toPx));
  // 区切りだけだと道路の幅がないので、同じ距離の中心線も入れる
  const from = Math.min(...segs.map((s) => s.fromM));
  const to = Math.max(...segs.map((s) => s.toM));
  for (let m = from; m <= to; m += 5) pts.push(toPx(input.dense[Math.min(m, input.dense.length - 1)]));
  return bboxOf(pts, 25 / metersPerPx(toLonLat(input.dense[0])[1]));
}

/* ---------- ルートのページ ---------- */

interface CheckRow {
  id: string;
  fromM: number;
  toM: number;
  tree: number;
  why: string;
}

function checkRows(input: WalkMapInput, segs: Segment[]): CheckRow[] {
  return segs
    .map((s) => ({ s, j: input.judgments.get(s.id) }))
    .filter((x): x is { s: Segment; j: Judgment } => !!x.j && x.j.conf === "低")
    .map(({ s, j }) => ({ id: s.id, fromM: s.fromM, toM: s.toM, tree: j.tree, why: j.why }));
}

export async function renderRoutePage(input: WalkMapInput, pages: Segment[][], i: number, day: string): Promise<HTMLCanvasElement> {
  const segs = pages[i];
  const from = Math.min(...segs.map((s) => s.fromM));
  const to = Math.max(...segs.map((s) => s.toM));
  const [canvas, ctx] = newPage();
  const kpA = estimateKp(input.kps, from);
  const kpB = estimateKp(input.kps, to);
  const kpText = kpA && kpB ? `　KP ${fmtKm(kpA.kp)}〜${fmtKm(kpB.kp)}（推定）` : "";
  header(ctx, input, `起点から ${from}〜${to}m${kpText}　区切り ${segs.map((s) => s.id).at(0)}〜${segs.at(-1)!.id}`, i + 2, pages.length + 1, day);

  const rows = checkRows(input, segs);
  const tableH = 10 + Math.max(rows.length, 3) * CHECK_ROW_H;
  const box = { x: MARGIN, y: MARGIN + HEADER_H, w: PAGE_W - MARGIN * 2, h: PAGE_H - MARGIN * 2 - HEADER_H - FOOTER_H - LEGEND_H - tableH - 4 };
  const lat = toLonLat(input.dense[from])[1];
  const f = fitFrame(box, pageBbox(segs, input), lat);
  await drawMap(ctx, f, input, segs, false);
  legend(ctx, MARGIN, box.y + box.h + 4);

  // 確かめる所の表
  const ty = box.y + box.h + LEGEND_H + 2;
  font(ctx, 3.2, true);
  ctx.fillStyle = "#1f2933";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`現地で確かめる所（確信が低い区切り）：${rows.length ? `${rows.length} か所` : "この区間にはありません。気づいたことを下に"}`, mm(MARGIN), mm(ty));
  const cols = [
    { label: "区切り", w: 18 },
    { label: "起点から", w: 20 },
    { label: "木", w: 10 },
    { label: "理由（Claude）", w: 74 },
    { label: "○ ×", w: 14 },
    { label: "メモ", w: PAGE_W - MARGIN * 2 - 136 },
  ];
  let y = ty + 6;
  const drawRow = (cells: string[], headerRow: boolean) => {
    let x = MARGIN;
    font(ctx, 2.8, headerRow);
    ctx.strokeStyle = "#9aa5b1";
    ctx.lineWidth = mm(0.2);
    cols.forEach((c, k) => {
      ctx.strokeRect(mm(x), mm(y), mm(c.w), mm(CHECK_ROW_H));
      if (headerRow) {
        ctx.fillStyle = "#f3f5f7";
        ctx.fillRect(mm(x) + 1, mm(y) + 1, mm(c.w) - 2, mm(CHECK_ROW_H) - 2);
      }
      ctx.fillStyle = "#1f2933";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const text = fitText(ctx, cells[k] ?? "", mm(c.w - 2));
      ctx.fillText(text, mm(x + 1), mm(y + CHECK_ROW_H / 2));
      x += c.w;
    });
    y += CHECK_ROW_H;
  };
  drawRow(cols.map((c) => c.label), true);
  const filled = rows.map((r) => [r.id, `${r.fromM}〜${r.toM}m`, `${r.tree}%`, r.why, "○  ×", ""]);
  while (filled.length < 3) filled.push(["", "", "", "", "○  ×", ""]);
  for (const r of filled) drawRow(r, false);
  footer(ctx);
  return canvas;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}
