/**
 * 軌跡図の読み書き（F2）。
 *
 * 読む：KML（Google マイマップなどの書き出し）か GeoJSON の線・多角形を集め、その縁の点を中心線に投影して、
 *   1m ごとの「左右どこまで掃いたか」（vehicle.ts の Sweep）にする。
 *   外側線・内側線・多角形のどれで描かれていても同じ扱いになり、区切りの作り方を1つにできる。
 *   本物の軌跡図は発注者のまだ公表していない計画であることがある。読んだ座標はこの端末の外へ出さない（spec §8.7）。
 * 書く：架空の軌跡図を KML と GeoJSON にする。運送会社の軌跡図が届く前の打ち合わせや、ほかの地図ソフトで重ねるため。
 */
import { strFromU8, unzipSync } from "fflate";
import type { Feature, FeatureCollection, LineString, Polygon, Position } from "geojson";
import { StationIndex } from "./geom";
import { toLonLat, toPlane, type EN } from "./proj";
import type { Sweep } from "./vehicle";

export type LonLat = [number, number];

/* ---------- 読む ---------- */

/** 名前つきの線（KML の Placemark の名前、GeoJSON の properties.name）。中心線を選ぶとき（F12）に名前で見分けるため */
export interface NamedLine {
  name: string;
  coords: LonLat[];
  /** 多角形の縁（閉じた輪）か */
  ring: boolean;
}

/** KML か GeoJSON の文字列から、線と多角形の縁（緯度経度の点列）を全部取り出す。点（Point）は使わない */
export function parseTrackFile(name: string, text: string): LonLat[][] {
  return parseNamedLines(name, text).map((l) => l.coords);
}

/** 同じく、名前つきで */
export function parseNamedLines(name: string, text: string): NamedLine[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("PK")) throw new Error(`${name} は zip（KMZ）のようです。parseTrackBytes で読んでください`);
  if (trimmed.startsWith("{")) return linesFromGeoJSON(JSON.parse(text));
  if (trimmed.startsWith("<")) return linesFromKml(text);
  throw new Error(`${name} は KML でも GeoJSON でもないようです`);
}

/**
 * ファイルのバイト列から読む。KMZ（zip の中に doc.kml などの KML が 1 つ入ったもの。Google Earth の既定の保存形）なら解凍して中の KML を読む。
 * 中の画像などは使わない
 */
export function parseTrackBytes(name: string, bytes: Uint8Array): LonLat[][] {
  return parseNamedBytes(name, bytes).map((l) => l.coords);
}

export function parseNamedBytes(name: string, bytes: Uint8Array): NamedLine[] {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) return parseNamedLines(name, new TextDecoder("utf-8").decode(bytes));
  const entries = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith(".kml") });
  const names = Object.keys(entries).sort((a, b) => (a.toLowerCase() === "doc.kml" ? -1 : b.toLowerCase() === "doc.kml" ? 1 : a.localeCompare(b)));
  if (!names.length) throw new Error(`${name} の中に KML がありません`);
  return parseNamedLines(names[0], strFromU8(entries[names[0]]));
}

function unescapeXml(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[k as string] ?? "");
}

function linesFromKml(xml: string): NamedLine[] {
  // DOMParser はテストの環境（Node）にないので、正規表現で拾う。
  // Placemark ごとに見て、この道具が書き出した「伐採範囲の外側」は飛ばす（掃く範囲に余裕幅と伐採の幅を二重に足さないため）。
  // 中身は LineString と LinearRing（多角形の縁）の <coordinates>。"経度,緯度[,高さ]" を空白で区切ったもの
  const out: NamedLine[] = [];
  const blocks = xml.match(/<Placemark\b[\s\S]*?<\/Placemark>/g) ?? [xml];
  for (const block of blocks) {
    const name = unescapeXml(/<name>([\s\S]*?)<\/name>/.exec(block)?.[1] ?? "").trim();
    if (name.includes("伐採範囲")) continue;
    const re = /<(LineString|LinearRing)\b[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      const pts: LonLat[] = [];
      for (const tok of m[2].trim().split(/\s+/)) {
        const [lon, lat] = tok.split(",").map(Number);
        if (Number.isFinite(lon) && Number.isFinite(lat)) pts.push([lon, lat]);
      }
      if (pts.length >= 2) out.push({ name, coords: pts, ring: m[1] === "LinearRing" });
    }
  }
  return out;
}

function linesFromGeoJSON(json: unknown): NamedLine[] {
  const out: NamedLine[] = [];
  let current = "";
  const push = (coords: Position[], ring = false) => {
    const pts = coords.filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]] as LonLat);
    if (pts.length >= 2) out.push({ name: current, coords: pts, ring });
  };
  const walkGeom = (g: { type: string; coordinates?: unknown; geometries?: unknown[] } | null | undefined) => {
    if (!g) return;
    switch (g.type) {
      case "LineString":
        push(g.coordinates as Position[]);
        break;
      case "MultiLineString":
        (g.coordinates as Position[][]).forEach((l) => push(l));
        break;
      case "Polygon":
        (g.coordinates as Position[][]).forEach((r) => push(r, true));
        break;
      case "MultiPolygon":
        (g.coordinates as Position[][][]).forEach((poly) => poly.forEach((r) => push(r, true)));
        break;
      case "GeometryCollection":
        (g.geometries as typeof g[]).forEach(walkGeom);
        break;
    }
  };
  const j = json as { type?: string; features?: { geometry?: unknown; properties?: { kind?: string; name?: unknown } | null }[]; geometry?: unknown; properties?: { name?: unknown } | null };
  const nameOf = (p: { name?: unknown } | null | undefined) => (typeof p?.name === "string" ? p.name : "");
  // この道具が書き出した「伐採範囲の外側」（kind: cut）は飛ばす。KML と同じ理由
  if (j.type === "FeatureCollection") {
    for (const f of j.features ?? []) {
      if (f.properties?.kind === "cut") continue;
      current = nameOf(f.properties);
      walkGeom(f.geometry as Parameters<typeof walkGeom>[0]);
    }
  } else if (j.type === "Feature") {
    current = nameOf(j.properties);
    walkGeom(j.geometry as Parameters<typeof walkGeom>[0]);
  } else walkGeom(j as Parameters<typeof walkGeom>[0]);
  return out;
}

/**
 * 線・多角形の縁から Sweep を作る。
 * 中心線の各点の法線で、線の全部の辺を横切り、左右それぞれ「いちばん遠い交点」を幅にする（2026-11-04）。
 * - それまでは縁の点を 1m ごとに打ち直して最寄りの点に投影していた。曲がりの外側では点が少ない区切りに幅の低い点しか当たらず、
 *   ギザギザや落ち込みになった（車両の計算と同じ穴）。法線で横切れば、線が通っている所は必ず連続する
 * - ヘアピンの反対側の脚の線を拾わないように、辺は「その辺の真ん中に最寄りの点が、いまの点から belongM 以内」のものだけ見る
 * - 中心線から maxDist より遠い交点は無視する（別の道の軌跡）
 * - 交点のない所は、maxGap（m）までなら両隣から直線で埋める。それより長く途切れた所は NaN（軌跡図がない）
 * - 片側だけ交点がある所は、もう片側を 0 にする（掃く範囲が中心線まで届いていない）
 */
export function sweepFromLines(dense: EN[], normals: EN[], lines: EN[][], maxDist = 120, maxGap = 10, belongM = 60): Sweep {
  const n = dense.length;
  const left = new Float64Array(n).fill(NaN);
  const right = new Float64Array(n).fill(NaN);
  const index = new StationIndex(dense);
  // 辺ごとに「どの点の近くの辺か」を先に決め、点の升に入れる
  const cell = 50;
  const buckets = new Map<string, { a: EN; b: EN; at: number }[]>();
  // 長い辺は pieceM ごとに刻んでから所属を決める。200m の直線を両端 2 点で表した辺は真ん中の 1 点にしか所属せず、
  // 両端 40m ずつが「軌跡図なし」になった（Codex の指摘 2026-11-04）。刻めば各片が近くの点に所属する
  const pieceM = 20;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const A = line[i - 1];
      const B = line[i];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const pieces = Math.max(1, Math.ceil(len / pieceM));
      for (let k = 0; k < pieces; k++) {
        const a: EN = [A[0] + ((B[0] - A[0]) * k) / pieces, A[1] + ((B[1] - A[1]) * k) / pieces];
        const b: EN = [A[0] + ((B[0] - A[0]) * (k + 1)) / pieces, A[1] + ((B[1] - A[1]) * (k + 1)) / pieces];
        const mid: EN = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const near = index.nearest(mid, maxDist + len / pieces / 2);
        if (!near) continue;
        const key = Math.floor(near.index / cell);
        (buckets.get(String(key)) ?? buckets.set(String(key), []).get(String(key))!).push({ a, b, at: near.index });
      }
    }
  }
  for (let s = 0; s < n; s++) {
    const P = dense[s];
    const N = normals[s];
    let lo = Infinity;
    let hi = -Infinity;
    const k0 = Math.floor((s - belongM) / cell);
    const k1 = Math.floor((s + belongM) / cell);
    for (let k = k0; k <= k1; k++) {
      for (const e of buckets.get(String(k)) ?? []) {
        if (Math.abs(e.at - s) > belongM) continue;
        // 直線 P + d N と辺 a→b の交点
        const ex = e.b[0] - e.a[0];
        const ey = e.b[1] - e.a[1];
        const det = ex * N[1] - N[0] * ey;
        if (Math.abs(det) < 1e-9) continue;
        const wx = e.a[0] - P[0];
        const wy = e.a[1] - P[1];
        const u = (N[0] * wy - N[1] * wx) / det;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        const d = (ex * wy - ey * wx) / det;
        if (Math.abs(d) > maxDist) continue;
        if (d > hi) hi = d;
        if (d < lo) lo = d;
      }
    }
    if (hi > -Infinity && hi >= 0) left[s] = hi;
    if (lo < Infinity && lo <= 0) right[s] = -lo;
    // 交点が片側にしかない（線が中心線の片側だけにある）ときは、その側の最大を取り、反対側は後で 0 にする
    if (hi > -Infinity && hi < 0 && Number.isNaN(left[s])) right[s] = Math.max(right[s] || 0, -lo);
    if (lo < Infinity && lo > 0 && Number.isNaN(right[s])) left[s] = Math.max(left[s] || 0, hi);
  }
  fillGaps(left, maxGap);
  fillGaps(right, maxGap);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(left[i]) && !Number.isFinite(right[i])) right[i] = 0;
    else if (Number.isFinite(right[i]) && !Number.isFinite(left[i])) left[i] = 0;
  }
  return { left, right };
}

function fillGaps(a: Float64Array, maxGap: number) {
  let i = 0;
  while (i < a.length) {
    if (Number.isFinite(a[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < a.length && !Number.isFinite(a[j])) j++;
    // i..j-1 が抜け。両側に値があり、短ければ直線で埋める
    if (i > 0 && j < a.length && j - i <= maxGap) {
      for (let k = i; k < j; k++) a[k] = a[i - 1] + ((a[j] - a[i - 1]) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
}

/** 緯度経度の点列を平面直角座標に */
export function linesToPlane(lines: LonLat[][]): EN[][] {
  return lines.map((l) => l.map((c) => toPlane(c)));
}

/* ---------- 書く ---------- */

export interface TrackProps {
  name: string;
  /** sweep＝掃く範囲、cut＝伐採範囲の外側、tilt＝起立の区間（地図の表示だけ。ファイルには書かない） */
  kind: "sweep" | "cut" | "tilt";
  side?: "L" | "R";
  label?: string;
}

/**
 * Sweep と伐採範囲の外側を、地図に出す・ファイルに書く GeoJSON にする。
 * 掃く範囲は多角形（左の縁＋右の縁を逆順）、縁と伐採範囲の外側は線。情報のない所（NaN）で切れる
 */
export function trackGeoJSON(
  dense: EN[],
  normals: EN[],
  sweep: Sweep,
  outer: { left: ArrayLike<number>; right: ArrayLike<number> } | null,
): FeatureCollection<Polygon | LineString, TrackProps> {
  const features: Feature<Polygon | LineString, TrackProps>[] = [];
  const at = (i: number, off: number, sgn: 1 | -1): Position => toLonLat([dense[i][0] + sgn * normals[i][0] * off, dense[i][1] + sgn * normals[i][1] * off]);
  for (const [a, b] of runs(sweep.left)) {
    const leftPts: Position[] = [];
    const rightPts: Position[] = [];
    for (let i = a; i <= b; i++) {
      leftPts.push(at(i, sweep.left[i], 1));
      rightPts.push(at(i, sweep.right[i], -1));
    }
    const ring = [...leftPts, ...[...rightPts].reverse(), leftPts[0]];
    features.push({ type: "Feature", properties: { name: "掃く範囲", kind: "sweep" }, geometry: { type: "Polygon", coordinates: [ring] } });
    features.push({ type: "Feature", properties: { name: "掃く範囲の左の縁", kind: "sweep", side: "L" }, geometry: { type: "LineString", coordinates: leftPts } });
    features.push({ type: "Feature", properties: { name: "掃く範囲の右の縁", kind: "sweep", side: "R" }, geometry: { type: "LineString", coordinates: rightPts } });
    if (outer) {
      const ol: Position[] = [];
      const or: Position[] = [];
      for (let i = a; i <= b; i++) {
        ol.push(at(i, outer.left[i], 1));
        or.push(at(i, outer.right[i], -1));
      }
      features.push({ type: "Feature", properties: { name: "伐採範囲の外側（左）", kind: "cut", side: "L" }, geometry: { type: "LineString", coordinates: ol } });
      features.push({ type: "Feature", properties: { name: "伐採範囲の外側（右）", kind: "cut", side: "R" }, geometry: { type: "LineString", coordinates: or } });
    }
  }
  return { type: "FeatureCollection", features };
}

/** 値のある添字の連続した区間 [a, b]（両端を含む） */
function runs(a: Float64Array): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= a.length; i++) {
    const ok = i < a.length && Number.isFinite(a[i]);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - 1 > start) out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** KML にする。Google Earth・マイマップ・QGIS で開ける。架空であることを説明に書く */
export function trackKml(fc: FeatureCollection<Polygon | LineString, TrackProps>, title: string, description: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const coords = (pts: Position[]) => pts.map((c) => `${c[0].toFixed(7)},${c[1].toFixed(7)},0`).join(" ");
  const placemarks = fc.features
    .filter((f) => f.properties.kind !== "tilt")
    .map((f) => {
      const style = f.properties.kind === "sweep" ? "#sweep" : "#cut";
      const geom =
        f.geometry.type === "Polygon"
          ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(f.geometry.coordinates[0])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
          : `<LineString><tessellate>1</tessellate><coordinates>${coords(f.geometry.coordinates)}</coordinates></LineString>`;
      return `    <Placemark><name>${esc(f.properties.name)}</name><styleUrl>${style}</styleUrl>${geom}</Placemark>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(title)}</name>
    <description>${esc(description)}</description>
    <Style id="sweep"><LineStyle><color>ffa21f7b</color><width>2</width></LineStyle><PolyStyle><color>33a21f7b</color></PolyStyle></Style>
    <Style id="cut"><LineStyle><color>ff0098ff</color><width>2</width></LineStyle></Style>
${placemarks}
  </Document>
</kml>
`;
}
