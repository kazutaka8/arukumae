/**
 * 現地マップの書き出し（KML・GeoJSON）。かかる筆・区切り（判定の色）・確かめる所・中心線・距離標を、
 * Google Earth やほかの地図ソフトで開ける形にする。
 *
 * なぜ要るか：現場では、公図と航空写真を Google Earth に重ねたものを iPad で見ながら歩いていた（実務でやっていた形）。
 * この道具の結果を同じ形で持ち出せれば、持って歩く地図（PDF）がなくても、それだけで現地の下見に使える。
 * 運送会社や設計者と重ねるときも KML が通じやすい。
 *
 * KML の色は aabbggrr（不透明度・青・緑・赤の順）。地図の色（map.ts の treeColorExpression）と同じ系統にする。
 * 座標は端末の中で緯度経度にするだけで、外へは送らない。
 */
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from "geojson";
import type { Check } from "./checks";
import { forestText, noticeText, type ForestInfo } from "./forest";
import { estimateKp, fmtKm, formatKp, type KpMark } from "./kp";
import { noteText, notesText, type FieldNote } from "./notes";
import { toLonLat, type EN } from "./proj";
import { kindLabel, type Judgment, type ParcelHit, type ParcelProps } from "./types";

export interface FieldMapInput {
  title: string;
  roadName: string;
  /** 中心線（1m ごと、平面座標） */
  dense: EN[];
  hits: ParcelHit[];
  parcelById: Map<string, { properties: ParcelProps }>;
  /** 区切り（緯度経度。applyJudgments 済みで tree・check の属性がある） */
  segments: FeatureCollection<Polygon>;
  judgments: Map<string, Judgment>;
  checks: Check[];
  kps: KpMark[];
  forest: Map<string, ForestInfo> | null;
  /** 現地の記録（○△×とメモ）。無ければ空の Map */
  notes?: Map<string, FieldNote>;
  /** 伐採範囲（掃く範囲の外側）。あれば線で入れる */
  cutLines?: Position[][];
  madeOn: string;
}

/** 木の割合 → KML の色（aabbggrr）。地図と同じ系統 */
export function treeKmlColor(tree: number | undefined): string {
  if (tree === undefined) return "59c8c8c8";
  if (tree <= 0) return "40ffffff";
  if (tree <= 25) return "803bebff";
  if (tree <= 50) return "8c0098ff";
  if (tree <= 75) return "991e51f4";
  return "a61c1cb7";
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (c: Position) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
const coords = (pts: Position[]) => pts.map((c) => `${fmt(c)},0`).join(" ");

/**
 * 面にならないリング（書き出しの桁 7 桁＝約 1cm に丸めると、違う点が 3 つ未満になるもの）を落とす。
 * 筆と区切りの重なり（turf.intersect）は、境目でごく細い欠片や線のような欠片を作ることがあり、
 * Google Earth がそれを「閉じた多角形にならない」と警告して 0,0 に置いた（2026-11-03 に Android で確認）。
 * 外周が面にならない多角形は丸ごと落とす。面積にも一覧にも関わらない（表示の形だけ）
 */
export function cleanRings(rings: Position[][]): Position[][] | null {
  const ok = (r: Position[]) => new Set(r.map(fmt)).size >= 3;
  if (!rings.length || !ok(rings[0])) return null;
  return [rings[0], ...rings.slice(1).filter(ok)];
}

function kmlPolygon(rings: Position[][]): string {
  const [outer, ...inner] = rings;
  return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(outer)}</coordinates></LinearRing></outerBoundaryIs>${inner
    .map((r) => `<innerBoundaryIs><LinearRing><coordinates>${coords(r)}</coordinates></LinearRing></innerBoundaryIs>`)
    .join("")}</Polygon>`;
}

function kmlGeometry(g: Geometry): string {
  switch (g.type) {
    case "Polygon": {
      const rings = cleanRings(g.coordinates);
      return rings ? kmlPolygon(rings) : "";
    }
    case "MultiPolygon": {
      const polys = g.coordinates.map(cleanRings).filter((r): r is Position[][] => !!r);
      if (!polys.length) return "";
      return polys.length === 1 ? kmlPolygon(polys[0]) : `<MultiGeometry>${polys.map(kmlPolygon).join("")}</MultiGeometry>`;
    }
    case "LineString":
      return `<LineString><tessellate>1</tessellate><coordinates>${coords(g.coordinates)}</coordinates></LineString>`;
    case "Point":
      return `<Point><coordinates>${coords([g.coordinates])}</coordinates></Point>`;
    default:
      return "";
  }
}

/** 札を置く点：いちばん大きい欠片の外周の頂点の平均。へこんだ形では外に出ることもあるが、札の位置なので目安で足りる */
export function labelPoint(shape: MultiPolygon): Position | null {
  let best: Position[] | null = null;
  let bestArea = -1;
  for (const rings of shape.coordinates) {
    const r = cleanRings(rings)?.[0];
    if (!r) continue;
    let a = 0;
    for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    a = Math.abs(a);
    if (a > bestArea) {
      bestArea = a;
      best = r;
    }
  }
  if (!best) return null;
  const pts = best.slice(0, -1);
  return [pts.reduce((s, c) => s + c[0], 0) / pts.length, pts.reduce((s, c) => s + c[1], 0) / pts.length];
}

/** 説明文（吹き出し）。表の形で、行の名前と値 */
function table(rows: [string, string][]): string {
  return `<table>${rows
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`)
    .join("")}</table>`;
}

interface Item {
  folder: string;
  name: string;
  style: string;
  description: string;
  geometry: Geometry;
  properties: Record<string, unknown>;
}

function items(input: FieldMapInput): Item[] {
  const out: Item[] = [];
  const kpOf = (m: number) => formatKp(input.roadName, estimateKp(input.kps, m));

  // 中心線
  const line = input.dense.filter((_, i) => i % 5 === 0 || i === input.dense.length - 1).map((p) => toLonLat(p) as Position);
  out.push({ folder: "中心線", name: `${input.roadName} 中心線（起点 → 終点）`, style: "center", description: `長さ約 ${input.dense.length - 1}m。起点が 0m`, geometry: { type: "LineString", coordinates: line }, properties: { kind: "centerline", lengthM: input.dense.length - 1 } });
  for (let m = 0; m < input.dense.length; m += 100) {
    out.push({ folder: "中心線", name: `${m}m`, style: "tick", description: `起点から ${m}m${kpOf(m) ? `。${kpOf(m)}` : ""}`, geometry: { type: "Point", coordinates: toLonLat(input.dense[m]) }, properties: { kind: "tick", atM: m } });
  }

  // 距離標
  for (const k of [...input.kps].sort((a, b) => a.atM - b.atM)) {
    const i = Math.max(0, Math.min(input.dense.length - 1, Math.round(k.atM)));
    out.push({ folder: "距離標", name: `KP ${fmtKm(k.kp)}`, style: "kp", description: `起点から ${k.atM}m。人が読んで置いた距離標`, geometry: { type: "Point", coordinates: toLonLat(input.dense[i]) }, properties: { kind: "kp", atM: k.atM, kp: k.kp } });
  }

  // かかる筆（かかる部分の形）
  for (const h of input.hits) {
    const p = input.parcelById.get(h.parcelId)?.properties;
    if (!p) continue;
    const js = h.segmentIds.map((id) => input.judgments.get(id)).filter((j): j is Judgment => !!j);
    const tree = js.length ? Math.max(...js.map((j) => j.tree)) : undefined;
    const f = input.forest?.get(h.parcelId);
    const name = `${p.oaza ?? ""} ${p.chiban}`.trim();
    out.push({
      folder: "かかる筆",
      name,
      style: "hit",
      description: table([
        ["所在・地番", name],
        ["種類", kindLabel(p.kind)],
        ["かかる面積", `${h.areaM2} m²`],
        ["起点から", `${h.fromM}〜${h.toM}m（${h.sides.map((s) => (s === "L" ? "左" : "右")).join("・")}）`],
        ["KP（推定）", kpOf((h.fromM + h.toM) / 2)],
        ["木（推定）", tree === undefined ? "まだ判定していません" : `最大 ${tree}%（${js.length} 区切り）`],
        ["森林の区域", f ? forestText(f) : ""],
        ["伐採の届出", f ? noticeText(f) : ""],
        ["区切り", h.segmentIds.join("・")],
        ["現地の記録", input.notes ? notesText(input.notes, h.segmentIds) : ""],
      ]),
      geometry: h.shape as MultiPolygon,
      properties: { kind: "hit", id: h.parcelId, oaza: p.oaza, chiban: p.chiban, parcelKind: p.kind, areaM2: h.areaM2, fromM: h.fromM, toM: h.toM, sides: h.sides.join(""), treeMax: tree ?? null, forest: f ? forestText(f) : null, segmentIds: h.segmentIds },
    });
  }
  // 地番の札：Google Earth は面の名前を地図に描かないので、かかる部分のいちばん大きい欠片の真ん中に点を置いて名前（地番）を出す。
  // 印は消して字だけにする（現地で iPad の画面に地番を読みたい、と 2026-11-03 に言われた）
  for (const h of input.hits) {
    const p = input.parcelById.get(h.parcelId)?.properties;
    if (!p) continue;
    const at = labelPoint(h.shape as MultiPolygon);
    if (!at) continue;
    out.push({ folder: "地番の札", name: p.chiban, style: "chiban", description: `${p.oaza ?? ""} ${p.chiban}（かかる面積 ${h.areaM2} m²）`.trim(), geometry: { type: "Point", coordinates: at }, properties: { kind: "label", id: h.parcelId, oaza: p.oaza, chiban: p.chiban } });
  }

  // 区切り（判定の色）
  for (const s of input.segments.features) {
    const pr = s.properties as Record<string, unknown>;
    const id = String(pr.id);
    const j = input.judgments.get(id);
    const label = j ? `${id} 木 ${j.tree}%${j.by === "人" ? "（人）" : ""}` : `${id}（未判定）`;
    out.push({
      folder: "区切り",
      name: label,
      style: `tree${j ? j.tree : "none"}`,
      description: table([
        ["場所", `起点から ${pr.fromM}〜${pr.toM}m の${pr.side === "L" ? "左" : "右"}`],
        ["KP（推定）", kpOf((Number(pr.fromM) + Number(pr.toM)) / 2)],
        ["木の割合", j ? `${j.tree}%` : "まだ判定していません"],
        ["樹種", j?.kind ?? ""],
        ["木以外", j?.other.join("・") ?? ""],
        ["確信", j?.conf ?? ""],
        ["理由", j?.why ?? ""],
        ["決めたのは", j ? `${j.by}${j.model ? `（${j.model}）` : ""}` : ""],
        ["現地の記録", noteText(input.notes?.get(id))],
      ]),
      geometry: s.geometry,
      properties: { kind: "segment", id, side: pr.side, fromM: pr.fromM, toM: pr.toM, areaM2: pr.areaM2, tree: j?.tree ?? null, treeKind: j?.kind ?? null, conf: j?.conf ?? null, why: j?.why ?? null, by: j?.by ?? null, note: noteText(input.notes?.get(id)) || null },
    });
  }

  // 確かめる所（区切りの真ん中に印）
  const segById = new Map(input.segments.features.map((s) => [String((s.properties as Record<string, unknown>).id), s]));
  for (const c of input.checks) {
    const s = segById.get(c.segmentId);
    if (!s) continue;
    const ring = s.geometry.coordinates[0];
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    out.push({
      folder: "現地で確かめる所",
      name: `${c.segmentId}${c.kind === "森林" ? "（森林）" : "（確信 低）"}${input.notes?.get(c.segmentId)?.result ? ` ${input.notes.get(c.segmentId)!.result}` : ""}`,
      style: input.notes?.get(c.segmentId)?.result ? "check-done" : "check",
      description: table([
        ["区切り", c.segmentId],
        ["種類", c.kind === "森林" ? "森林の区域と判定が食い違う" : "Claude の確信が低い"],
        ["理由", c.why],
        ["木（判定）", `${c.tree}%`],
        ["現地の記録", noteText(input.notes?.get(c.segmentId))],
      ]),
      geometry: { type: "Point", coordinates: [cx, cy] },
      properties: { kind: "check", segmentId: c.segmentId, checkKind: c.kind, why: c.why, tree: c.tree, note: noteText(input.notes?.get(c.segmentId)) || null },
    });
  }

  // 伐採範囲の外側
  for (const [i, l] of (input.cutLines ?? []).entries()) {
    out.push({ folder: "伐採範囲", name: `伐採範囲の外側 ${i + 1}`, style: "cut", description: "掃く範囲に余裕幅と伐採の幅を足した外側の線", geometry: { type: "LineString", coordinates: l }, properties: { kind: "cut" } });
  }
  return out;
}

const STYLES: Record<string, string> = {
  center: `<LineStyle><color>ff2257ff</color><width>3</width></LineStyle>`,
  tick: `<IconStyle><scale>0.5</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>0.7</scale></LabelStyle>`,
  kp: `<IconStyle><scale>1.0</scale><color>ffff9900</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/blu-blank.png</href></Icon></IconStyle>`,
  hit: `<LineStyle><color>ff00d6ff</color><width>2</width></LineStyle><PolyStyle><color>6600d6ff</color></PolyStyle>`,
  chiban: `<IconStyle><scale>0</scale></IconStyle><LabelStyle><color>ff00ffff</color><scale>0.8</scale></LabelStyle>`,
  check: `<IconStyle><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-stars.png</href></Icon></IconStyle>`,
  "check-done": `<IconStyle><scale>1.0</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon></IconStyle>`,
  cut: `<LineStyle><color>ff0098ff</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle>`,
};

export function fieldKml(input: FieldMapInput): string {
  const all = items(input);
  const folders = [...new Set(all.map((i) => i.folder))];
  const treeStyles = ["none", 0, 25, 50, 75, 100]
    .map((t) => `    <Style id="tree${t}"><LineStyle><color>${t === "none" ? "ffc8c8c8" : "ff" + treeKmlColor(t as number).slice(2)}</color><width>1.5</width></LineStyle><PolyStyle><color>${treeKmlColor(t === "none" ? undefined : (t as number))}</color></PolyStyle></Style>`)
    .join("\n");
  const styles = Object.entries(STYLES)
    .map(([id, body]) => `    <Style id="${id}">${body}</Style>`)
    .join("\n");
  const description = `${input.title}。アルクマエで ${input.madeOn} に作成。かかる筆は伐採範囲に重なる部分の形、区切りの色は航空写真から Claude が判定した木の割合（白 0% → 黄 25% → 橙 50% → 赤 75〜100%。人が直したものは名前に「人」）。下調べの資料で、現地で確かめる前提。公図は「おおよその位置と隣接関係」を示す図面で、境界は現地と違うことがある。出典：登記所備付地図データ（法務省）を加工して作成 ／ 森林計画対象森林レイヤ（林野庁） ／ © OpenStreetMap contributors`;
  const body = folders
    .map((fo) => {
      const pm = all
        .filter((i) => i.folder === fo)
        .map((i) => `      <Placemark><name>${esc(i.name)}</name><styleUrl>#${i.style}</styleUrl><description><![CDATA[${i.description}]]></description>${kmlGeometry(i.geometry)}</Placemark>`)
        .join("\n");
      // 区切りは数が多いので、最初は畳んで見えないようにする（筆と確かめる所が主役）
      const open = fo === "区切り" ? "<open>0</open>" : "<open>1</open>";
      return `    <Folder><name>${esc(fo)}（${all.filter((i) => i.folder === fo).length}）</name>${open}\n${pm}\n    </Folder>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(input.title)}</name>
    <description><![CDATA[${esc(description)}]]></description>
${styles}
${treeStyles}
${body}
  </Document>
</kml>
`;
}

export function fieldGeoJSON(input: FieldMapInput): FeatureCollection & { title: string; description: string } {
  const features: Feature[] = items(input).map((i) => ({ type: "Feature", properties: { folder: i.folder, name: i.name, ...i.properties }, geometry: i.geometry }));
  return { type: "FeatureCollection", title: input.title, description: `アルクマエで ${input.madeOn} に作成。下調べの資料で、現地で確かめる前提。出典：登記所備付地図データ（法務省）を加工して作成 ／ 森林計画対象森林レイヤ（林野庁） ／ © OpenStreetMap contributors`, features };
}
